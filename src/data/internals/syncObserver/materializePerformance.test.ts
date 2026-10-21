// @vitest-environment node
import {expect, it, vi} from 'vitest'
import type {BlockData} from '@/data/api'
import type {PowerSyncDb} from '@/data/internals/commitPipeline'
import {MAX_IDS_PER_IN_CLAUSE} from '@/data/internals/sqlBinds'
import {encodeForWire} from '@/sync/transform'
import {materializeStagingRows, type MaterializeOutcome} from './materialize'
import {constMat, noKey, setupObserverTestDb, stagingCiphertextParams} from './test/harness'

const h = setupObserverTestDb()
const block = (id: string, overrides: Partial<BlockData> = {}): BlockData => ({
  id, workspaceId: 'ws-perf', parentId: null, orderKey: id,
  content: `Synthetic content ${id}`, properties: {}, references: [],
  createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'peer', updatedBy: 'peer',
  deleted: false, ...overrides,
})
const makeKey = () => crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
const stageEncrypted = async (data: BlockData, key: CryptoKey) => {
  const wire = await encodeForWire({
    id: data.id, workspace_id: data.workspaceId, content: data.content,
    properties_json: JSON.stringify(data.properties), references_json: JSON.stringify(data.references),
  }, 'e2ee', async () => key)
  await h.stageRow(data, stagingCiphertextParams(data, wire))
}

it('reuses a workspace key within a window, keeps workspaces distinct, and rereads on the next window', async () => {
  const keys = new Map([['ws-perf', await makeKey()], ['ws-other', await makeKey()]])
  const records = [block('a'), block('b'), block('c', {workspaceId: 'ws-other'}), block('d', {workspaceId: 'ws-other'})]
  for (const data of records) await stageEncrypted(data, keys.get(data.workspaceId)!)
  const getCek = vi.fn(async (workspaceId: string) => keys.get(workspaceId) ?? null)
  const getMaterializability = vi.fn(async () => 'decrypt' as const)
  const deps = {getMaterializability, getCek}
  const result = await materializeStagingRows(h.env.db, {upserted: records.map(b => b.id), removed: []}, deps)
  expect(result.applied).toHaveLength(4)
  expect(getCek.mock.calls.map(([ws]) => ws).sort()).toEqual(['ws-other', 'ws-perf'])
  expect(getMaterializability).toHaveBeenCalledTimes(2)
  expect(await h.blocks()).toEqual(records.map(b => ({id: b.id, content: b.content})))

  const replacement = await makeKey()
  keys.set('ws-perf', replacement)
  const changed = block('a', {content: 'Encrypted with the replacement key', updatedAt: 2})
  await stageEncrypted(changed, replacement)
  const next = await materializeStagingRows(h.env.db, {upserted: ['a'], removed: []}, deps)
  expect(next.applied).toEqual(['a'])
  expect(getCek).toHaveBeenCalledTimes(3)
  expect((await h.blocks())[0].content).toBe(changed.content)
})

it('does not retain a key across windows after its store record disappears', async () => {
  const key = await makeKey()
  let available = true
  const deps = {getMaterializability: constMat('decrypt'), getCek: async () => available ? key : null}
  await stageEncrypted(block('a'), key)
  await materializeStagingRows(h.env.db, {upserted: ['a'], removed: []}, deps)
  const changed = block('a', {content: 'Must stay staged without the key', updatedAt: 2})
  await stageEncrypted(changed, key)
  available = false
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const result = await materializeStagingRows(h.env.db, {upserted: ['a'], removed: []}, deps)
    expect(result.quarantined).toEqual(['a'])
    expect((await h.blocks())[0].content).toBe(block('a').content)
    expect(await h.env.db.get<{needs_apply: number}>('SELECT needs_apply FROM blocks_synced WHERE id = ?', ['a']))
      .toEqual({needs_apply: 1})
  } finally { warning.mockRestore() }
})

it('decodes other records while one crypto operation is pending, before opening the write transaction', async () => {
  const key = await makeKey()
  const records = Array.from({length: 40}, (_, i) => block(`row-${i.toString().padStart(3, '0')}`))
  for (const data of records) await stageEncrypted(data, key)
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  let active = 0
  let peak = 0
  const spy = vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
    const first = calls++ === 0
    peak = Math.max(peak, ++active)
    try {
      if (first) await held
      return await decrypt(...args)
    } finally { active-- }
  })
  const txSpy = vi.spyOn(h.env.db, 'writeTransaction')
  const pass = materializeStagingRows(h.env.db, {upserted: records.map(b => b.id), removed: []}, {
    getMaterializability: constMat('decrypt'), getCek: async () => key,
  })
  let outcome!: MaterializeOutcome
  try {
    await vi.waitFor(() => expect(calls).toBeGreaterThan(3))
    expect(txSpy).not.toHaveBeenCalled()
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThan(records.length)
  } finally {
    release()
    try { outcome = await pass }
    finally {
      spy.mockRestore()
      txSpy.mockRestore()
    }
  }
  expect(outcome.applied).toEqual(records.map(b => b.id))
  expect([...outcome.snapshots.values()].map(s => s.after?.content)).toEqual(records.map(b => b.content))
  expect(await h.blocks()).toEqual(records.map(b => ({id: b.id, content: b.content})))
})

it('writes a large arrival in bounded SQL batches while maintaining every value and derived index', async () => {
  const records = Array.from({length: 160}, (_, i) => block(`row-${i.toString().padStart(3, '0')}`, {
    content: `Searchable ${i}`, properties: {alias: [`Alias ${i}`], types: ['example']},
  }))
  for (const data of records) await h.stageRow(data)
  const writes: number[] = []
  const db = new Proxy(h.env.db, {
    get(target, prop) {
      if (prop === 'writeTransaction') return (fn: Parameters<PowerSyncDb['writeTransaction']>[0]) => target.writeTransaction(tx => fn(new Proxy(tx, {
        get(txTarget, txProp) {
          if (txProp === 'execute') return (sql: string, params?: unknown[]) => {
            if (/INSERT INTO blocks\s*\(/.test(sql)) writes.push(params?.length ?? 0)
            return txTarget.execute(sql, params)
          }
          const value = Reflect.get(txTarget, txProp)
          return typeof value === 'function' ? value.bind(txTarget) : value
        },
      })))
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const out = await materializeStagingRows(db, {upserted: records.map(b => b.id), removed: []}, {
    getMaterializability: constMat('copy'), getCek: noKey,
  })
  expect(writes.length).toBeLessThan(records.length / 10)
  expect(Math.max(...writes)).toBeLessThanOrEqual(MAX_IDS_PER_IN_CLAUSE)
  expect(out.applied).toHaveLength(records.length)
  expect([...out.snapshots.values()].map(s => s.after?.content)).toEqual(records.map(b => b.content))
  expect(await h.blocks()).toEqual(records.map(b => ({id: b.id, content: b.content})))
  expect(await h.env.db.get<{n: number}>('SELECT COUNT(*) AS n FROM block_aliases')).toEqual({n: records.length})
  expect(await h.env.db.get<{n: number}>('SELECT COUNT(*) AS n FROM block_types')).toEqual({n: records.length})
  expect(await h.env.db.get<{n: number}>("SELECT COUNT(*) AS n FROM blocks_fts WHERE blocks_fts MATCH 'Searchable'"))
    .toEqual({n: records.length})
  expect(await h.crudCount()).toBe(0)
})
