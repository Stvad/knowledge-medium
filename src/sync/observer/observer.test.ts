// @vitest-environment node
/**
 * Layout B observer driver (design doc §9.2, D-2c) — end-to-end against a real
 * `@powersync/node` DB: staging write → capture trigger → queue → drain →
 * materialize → invalidate, plus the drain's race/failure/restart robustness.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToRowParams } from '@/data/blockSchema'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { startBlocksSyncedObserver, type BlocksSyncedObserver } from './observer.js'
import type { GetMaterializability } from './materialize.js'
import { encodeForWire, type GetCek } from '../transform.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '../crypto/workspaceKey.js'
import type { ChangeNotification } from '@/data/internals/handleStore'
import type { BlockData, CycleDetectedEvent } from '@/data/api'

const data = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: 'ws-plain', parentId: null, orderKey: 'a0', content: 'hello',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, createdBy: 'u',
  updatedBy: 'u', deleted: false, ...o,
})

const stagingCiphertextParams = (
  meta: BlockData,
  wire: { content: string; properties_json: string; references_json: string },
): unknown[] => {
  const params = blockToRowParams(meta)
  params[4] = wire.content
  params[5] = wire.properties_json
  params[6] = wire.references_json
  return params
}

let env: TestDb
let observers: BlocksSyncedObserver[]
beforeEach(async () => { env = await createTestDb(); observers = [] })
afterEach(async () => {
  for (const o of observers) o.dispose()
  await env.cleanup()
})

const put = (d: BlockData, params?: unknown[]) =>
  env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, params ?? blockToRowParams(d))
const del = (id: string) => env.db.execute(BLOCKS_SYNCED_RAW_TABLE.delete.sql, [id])

const blocks = () =>
  env.db.getAll<{ id: string; content: string }>('SELECT id, content FROM blocks ORDER BY id')
const queueLen = async () =>
  (await env.db.getAll('SELECT seq FROM blocks_synced_changes')).length

const constMat = (m: 'copy' | 'decrypt' | 'defer'): GetMaterializability => () => m
const noKey: GetCek = async () => null

interface Harness {
  observer: BlocksSyncedObserver
  cache: BlockCache
  notifications: ChangeNotification[]
}

const start = (opts: {
  getMaterializability: GetMaterializability
  getCek?: GetCek
  onCycleDetected?: (e: CycleDetectedEvent) => void
}): Harness => {
  const cache = new BlockCache()
  const notifications: ChangeNotification[] = []
  const observer = startBlocksSyncedObserver({
    db: env.db,
    cache,
    handleStore: { invalidate: (n) => notifications.push(n) },
    deps: { getMaterializability: opts.getMaterializability, getCek: opts.getCek ?? noKey },
    onCycleDetected: opts.onCycleDetected,
    throttleMs: 5,
  })
  observers.push(observer)
  return { observer, cache, notifications }
}

const e2eeStaging = async (plain: BlockData): Promise<{ getCek: GetCek; params: unknown[] }> => {
  const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
  const getCek: GetCek = async () => key
  const wire = await encodeForWire(
    {
      id: plain.id, workspace_id: plain.workspaceId,
      content: plain.content,
      properties_json: JSON.stringify(plain.properties),
      references_json: JSON.stringify(plain.references),
    },
    'e2ee', getCek,
  )
  return { getCek, params: stagingCiphertextParams(plain, wire) }
}

const waitFor = async (cond: () => Promise<boolean>, ms = 3000): Promise<void> => {
  const start = Date.now()
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 15))
  }
}

describe('blocksSyncedObserver — drain', () => {
  it('materializes a queued plaintext row into blocks and drains the queue', async () => {
    await put(data({ content: 'plain' }))
    const { observer } = start({ getMaterializability: constMat('copy') })

    await observer.flush()

    expect(await blocks()).toEqual([{ id: 'b1', content: 'plain' }])
    expect(await queueLen()).toBe(0)
  })

  it('hard-deletes a removed row', async () => {
    await put(data({ content: 'doomed' }))
    const { observer } = start({ getMaterializability: constMat('copy') })
    await observer.flush()
    expect(await blocks()).toHaveLength(1)

    await del('b1')
    await observer.flush()
    expect(await blocks()).toEqual([])
  })

  it('coalesces a re-delivery within one drain (latest content wins, applied once)', async () => {
    await put(data({ content: 'v1' }))
    await put(data({ content: 'v2', updatedAt: 2 })) // re-delivery before any drain
    const { observer } = start({ getMaterializability: constMat('copy') })

    await observer.flush()

    expect(await blocks()).toEqual([{ id: 'b1', content: 'v2' }])
    expect(await queueLen()).toBe(0)
  })

  it('decrypts an e2ee row when the WK is available', async () => {
    const plain = data({ id: 'e1', workspaceId: 'ws-e2ee', content: 'secret' })
    const { getCek, params } = await e2eeStaging(plain)
    await put(plain, params)
    const { observer } = start({ getMaterializability: constMat('decrypt'), getCek })

    await observer.flush()

    expect(await blocks()).toEqual([{ id: 'e1', content: 'secret' }])
  })

  it('invalidates the cache and handles for an applied row', async () => {
    await put(data({ content: 'fresh' }))
    const { observer, cache, notifications } = start({ getMaterializability: constMat('copy') })

    await observer.flush()

    expect(cache.getSnapshot('b1')).toMatchObject({ content: 'fresh' })
    expect(notifications).toHaveLength(1)
    expect([...(notifications[0]!.rowIds ?? [])]).toEqual(['b1'])
  })
})

describe('blocksSyncedObserver — defer + drainWorkspace', () => {
  it('leaves an un-keyed e2ee row in staging, then materializes it on drainWorkspace', async () => {
    const plain = data({ id: 'e1', workspaceId: 'ws-e2ee', content: 'locked' })
    const { getCek, params } = await e2eeStaging(plain)
    await put(plain, params)

    // First the workspace is not materializable (no WK loaded yet).
    let mat: 'defer' | 'decrypt' = 'defer'
    const { observer } = start({ getMaterializability: () => mat, getCek })
    await observer.flush()
    expect(await blocks()).toEqual([]) // deferred — staged, not materialized
    expect(await queueLen()).toBe(0) // but the queue entry was consumed

    // WK arrives → the workspace becomes materializable; §8 calls drainWorkspace.
    mat = 'decrypt'
    await observer.drainWorkspace('ws-e2ee')
    expect(await blocks()).toEqual([{ id: 'e1', content: 'locked' }])
  })
})

describe('blocksSyncedObserver — robustness', () => {
  it('keeps the queue intact when a drain fails, and retries successfully', async () => {
    const plain = data({ id: 'e1', workspaceId: 'ws-e2ee', content: 'retryme' })
    // Encrypt with a known key, but withhold it from the observer at first.
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const wire = await encodeForWire(
      {
        id: plain.id, workspace_id: plain.workspaceId, content: plain.content,
        properties_json: JSON.stringify(plain.properties),
        references_json: JSON.stringify(plain.references),
      },
      'e2ee', async () => key,
    )
    await put(plain, stagingCiphertextParams(plain, wire))

    // Claim 'decrypt' but hand back no key first → decode throws mid-drain.
    let available: CryptoKey | null = null
    const getCek: GetCek = async () => available
    const { observer } = start({ getMaterializability: constMat('decrypt'), getCek })

    await observer.flush()
    expect(await blocks()).toEqual([]) // failed to decrypt
    expect(await queueLen()).toBe(1) // NOT consumed — the change is still queued

    // The key arrives; the retry drains the still-queued change.
    available = key
    await observer.flush()
    expect(await blocks()).toEqual([{ id: 'e1', content: 'retryme' }])
  })

  it('survives a restart: a queued change persists for a fresh observer (durable queue)', async () => {
    await put(data({ content: 'persisted' }))

    // Observer A starts but is disposed before its startup drain runs.
    const a = start({ getMaterializability: constMat('copy') })
    a.observer.dispose()
    expect(await blocks()).toEqual([]) // A never drained
    expect(await queueLen()).toBe(1) // change is still durably queued

    // A fresh observer (a "reload") drains the persisted change.
    const b = start({ getMaterializability: constMat('copy') })
    await b.observer.flush()
    expect(await blocks()).toEqual([{ id: 'b1', content: 'persisted' }])
  })

  it('auto-drains via the onChange subscription (no explicit flush)', async () => {
    start({ getMaterializability: constMat('copy') })
    await put(data({ content: 'autopilot' }))

    await waitFor(async () => (await blocks()).length === 1)
    expect(await blocks()).toEqual([{ id: 'b1', content: 'autopilot' }])
  })
})

describe('blocksSyncedObserver — cycle detection (§4.7)', () => {
  it('emits cycleDetected for a sync-applied 2-cycle (startIds cover both members)', async () => {
    const events: CycleDetectedEvent[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { observer } = start({
      getMaterializability: constMat('copy'),
      onCycleDetected: e => events.push(e),
    })

    // Seed A, B (no parents) and materialize them.
    await put(data({ id: 'A', parentId: null, updatedAt: 1 }))
    await put(data({ id: 'B', parentId: null, updatedAt: 1 }))
    await observer.flush()

    // Two sync-applied moves close the loop: A under B, B under A (both
    // strictly newer so they apply). The observer writes with source = NULL,
    // so the parent-workspace invariant trigger is bypassed, exactly like
    // PowerSync's CRUD-apply — letting the cycle form.
    await put(data({ id: 'A', parentId: 'B', updatedAt: 2 }))
    await put(data({ id: 'B', parentId: 'A', updatedAt: 2 }))
    await observer.flush()

    expect(events.length).toBeGreaterThanOrEqual(1)
    const startIds = new Set<string>()
    for (const ev of events) {
      expect(ev.workspaceId).toBe('ws-plain')
      expect(ev.txIdsInvolved).toEqual([]) // sync writes carry no tx_id
      ev.startIds.forEach(id => startIds.add(id))
    }
    expect([...startIds].sort()).toEqual(['A', 'B'])
    const cycleWarns = warn.mock.calls.filter(c => String(c[0]).includes('cycleDetected'))
    expect(cycleWarns).toHaveLength(events.length)
    warn.mockRestore()
  })

  it('does not fire when a sync-applied move does not close a loop', async () => {
    const events: CycleDetectedEvent[] = []
    const { observer } = start({
      getMaterializability: constMat('copy'),
      onCycleDetected: e => events.push(e),
    })
    await put(data({ id: 'A', parentId: null, updatedAt: 1 }))
    await put(data({ id: 'B', parentId: null, updatedAt: 1 }))
    await observer.flush()

    await put(data({ id: 'B', parentId: 'A', updatedAt: 2 })) // one move, no loop
    await observer.flush()

    expect(events).toEqual([])
  })

  it('does not fire on a pure content edit', async () => {
    const events: CycleDetectedEvent[] = []
    const { observer } = start({
      getMaterializability: constMat('copy'),
      onCycleDetected: e => events.push(e),
    })
    await put(data({ id: 'A', parentId: null, content: 'v1', updatedAt: 1 }))
    await observer.flush()

    await put(data({ id: 'A', parentId: null, content: 'v2', updatedAt: 2 }))
    await observer.flush()

    expect(events).toEqual([])
  })
})
