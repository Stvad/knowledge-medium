// @vitest-environment node
import {expect, it, vi} from 'vitest'
import type {BlockData} from '@/data/api'
import {createTestRepo} from '@/data/test/createTestRepo'
import {MAX_IDS_PER_IN_CLAUSE} from '@/data/internals/sqlBinds'
import {referenceTargetLookupsVia} from '@/data/internals/referenceTargetLookups'
import {selectAliasTargetIdsSql} from '@/data/internals/kernelQueries'
import {setupObserverTestDb} from './test/harness'

const h = setupObserverTestDb()
const block = (id: string, overrides: Partial<BlockData> = {}): BlockData => ({
  id, workspaceId: 'ws-batch', parentId: null, orderKey: id, content: '',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1,
  createdBy: 'peer', updatedBy: 'peer', deleted: false, ...overrides,
})

// About 0.3s alone; several seconds when the full gate contends for SQLite workers.
it('batches reference stamps and alias reads within the bind limit, preserving SQL and cache values', async () => {
  const records: BlockData[] = []
  for (let i = 0; i < 520; i++) {
    records.push(block(`ref-${i}`, {content: i % 2 ? `::[[Alias ${i}]]` : `((target-${i}))`}))
    if (i % 2) records.push(block(`target-${i}`, {properties: {alias: [`Alias ${i}`]}}))
  }
  // Referrers precede their targets; resolution must see the whole window.
  for (const row of records) await h.stageRow(row)
  const {repo, cache} = createTestRepo({db: h.env.db, startSyncObserver: true})
  const statements: {sql: string; binds: number}[] = []
  const rawWrite = h.env.db.writeTransaction.bind(h.env.db)
  const spy = vi.spyOn(h.env.db, 'writeTransaction').mockImplementation(fn => rawWrite(tx => fn({
    ...tx,
    execute: async (sql, params) => {
      statements.push({sql, binds: params?.length ?? 0})
      return tx.execute(sql, params)
    },
    getAll: async (sql, params) => {
      statements.push({sql, binds: params?.length ?? 0})
      return tx.getAll(sql, params)
    },
    getOptional: async (sql, params) => {
      statements.push({sql, binds: params?.length ?? 0})
      return tx.getOptional(sql, params)
    },
  })))
  try {
    await repo.flushSyncObserver()
    const stamps = statements.filter(s => /UPDATE blocks SET reference_target_id/.test(s.sql))
    const aliasReads = statements.filter(s => /FROM block_aliases/.test(s.sql))
    expect(stamps.length).toBeGreaterThan(0)
    expect(stamps.length).toBeLessThan(10)
    expect(aliasReads.length).toBeLessThan(5)
    expect(Math.max(...statements.map(s => s.binds))).toBeLessThanOrEqual(MAX_IDS_PER_IN_CLAUSE)
    for (let i = 0; i < 520; i++) {
      const row = await h.env.db.get<{reference_target_id: string; is_field_form: number | null}>(
        'SELECT reference_target_id, is_field_form FROM blocks WHERE id = ?', [`ref-${i}`],
      )
      expect(row).toEqual({reference_target_id: `target-${i}`, is_field_form: i % 2 ? 1 : null})
      expect(cache.getSnapshot(`ref-${i}`)?.referenceTargetId).toBe(`target-${i}`)
      expect(cache.getSnapshot(`ref-${i}`)?.isFieldForm).toBe(Boolean(i % 2))
    }
    expect(await h.crudCount()).toBe(0)
  } finally {
    spy.mockRestore()
    repo.stopSyncObserver()
  }
}, 20_000)

it('uses the same workspace-scoped oldest claimant and id tie-break as ordinary alias lookup', async () => {
  const records = [
    block('newer', {properties: {alias: ['Shared']}, createdAt: 20}),
    block('z-oldest', {properties: {alias: ['Shared']}, createdAt: 10}),
    block('a-oldest', {properties: {alias: ['Shared']}, createdAt: 10}),
    block('other-workspace', {workspaceId: 'other', properties: {alias: ['Shared']}, createdAt: 0}),
    block('deleted', {properties: {alias: ['Shared']}, createdAt: 0, deleted: true}),
    block('ref', {content: '[[Shared]]'}),
    block('other-ref', {workspaceId: 'other', content: '::[[Shared]]'}),
    block('unresolved', {content: '::[[Missing]]'}),
  ]
  for (const row of records) await h.stageRow(row)
  const {repo, cache} = createTestRepo({db: h.env.db, startSyncObserver: true})
  await repo.flushSyncObserver()
  expect(cache.getSnapshot('ref')?.referenceTargetId).toBe('a-oldest')
  expect(cache.getSnapshot('other-ref')?.referenceTargetId).toBe('other-workspace')
  expect(cache.getSnapshot('unresolved')).toMatchObject({referenceTargetId: null, isFieldForm: true})
})

it('chunks distinct alias lookups and uses the workspace-alias index', async () => {
  const reads: number[] = []
  const reader = {
    getAll: async <T>(sql: string, params?: unknown[]) => {
      reads.push(params?.length ?? 0)
      return h.env.db.getAll<T>(sql, params)
    },
  }
  const names = Array.from({length: 1003}, (_, i) => `Alias ${i}`)
  const targets = await referenceTargetLookupsVia(reader).aliasTargetIds!([...names, names[0]!], 'ws-batch')
  expect(targets.size).toBe(names.length)
  expect([...targets.values()].every(id => id === null)).toBe(true)
  expect(reads).toHaveLength(3)
  expect(Math.max(...reads)).toBeLessThanOrEqual(MAX_IDS_PER_IN_CLAUSE)
  const plan = await h.env.db.getAll<{detail: string}>(`EXPLAIN QUERY PLAN ${selectAliasTargetIdsSql(1)}`, ['Alias', 'ws-batch'])
  expect(plan.some(row => row.detail.includes('idx_block_aliases_ws_alias'))).toBe(true)
})

it('rolls back a partially failing stamp batch before isolating its bad row', async () => {
  for (const id of ['a-good', 'bad', 'z-good']) await h.stageRow(block(id, {content: `::((target-${id}))`}))
  await h.env.db.execute('CREATE TABLE arrival_stamp_effects (id TEXT)')
  await h.env.db.execute(`CREATE TRIGGER count_arrival_stamp AFTER UPDATE OF reference_target_id ON blocks
    BEGIN INSERT INTO arrival_stamp_effects (id) VALUES (NEW.id); END`)
  await h.env.db.execute(`CREATE TRIGGER reject_arrival_stamp BEFORE UPDATE OF reference_target_id ON blocks
    WHEN NEW.id = 'bad' BEGIN SELECT RAISE(FAIL, 'poison stamp'); END`)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const {repo, cache} = createTestRepo({db: h.env.db, startSyncObserver: true})
  try {
    await repo.flushSyncObserver()
    const rows = await h.env.db.getAll<{id: string; reference_target_id: string | null; is_field_form: number | null}>(
      'SELECT id, reference_target_id, is_field_form FROM blocks ORDER BY id',
    )
    expect(rows).toEqual([
      {id: 'a-good', reference_target_id: 'target-a-good', is_field_form: 1},
      {id: 'bad', reference_target_id: null, is_field_form: null},
      {id: 'z-good', reference_target_id: 'target-z-good', is_field_form: 1},
    ])
    expect(cache.getSnapshot('bad')).toMatchObject({referenceTargetId: null, isFieldForm: false})
    expect(cache.getSnapshot('z-good')?.referenceTargetId).toBe('target-z-good')
    // Three arrivals, then exactly two successful local stamps; no leaked audit
    // entry from a row visited before RAISE(FAIL) interrupted the batch.
    expect(await h.env.db.get<{n: number}>('SELECT COUNT(*) AS n FROM row_events')).toEqual({n: 5})
    expect(await h.env.db.getAll<{id: string}>('SELECT id FROM arrival_stamp_effects ORDER BY id'))
      .toEqual([{id: 'a-good'}, {id: 'z-good'}])
    expect(await h.crudCount()).toBe(0)
  } finally {
    await h.env.db.execute('DROP TRIGGER reject_arrival_stamp')
    await h.env.db.execute('DROP TRIGGER count_arrival_stamp')
    await h.env.db.execute('DROP TABLE arrival_stamp_effects')
    warning.mockRestore()
    repo.stopSyncObserver()
  }
})
