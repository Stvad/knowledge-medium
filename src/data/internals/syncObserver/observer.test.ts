// @vitest-environment node
/**
 * Layout B observer driver (design doc §9.2, D-2c) — end-to-end against a real
 * `@powersync/node` DB: staging write → capture trigger → queue → drain →
 * materialize → invalidate, plus the drain's race/failure/restart robustness.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { BLOCKS_SYNCED_RAW_TABLE, blockToRowParams } from '@/data/blockSchema'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { startBlocksSyncedObserver, type BlocksSyncedObserver } from './observer.js'
import type { GetMaterializability, Materializability } from './materialize.js'
import { encodeForWire, type GetCek } from '@/sync/transform.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '@/sync/crypto/workspaceKey.js'
import type { ChangeNotification } from '@/data/internals/handleStore'
import type { BlockData, CycleDetectedEvent } from '@/data/api'

const data = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: 'ws-plain', parentId: null, orderKey: 'a0', content: 'hello',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'u',
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

let sharedDb: TestDb
let env: TestDb
let observers: BlocksSyncedObserver[]
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db); env = sharedDb; observers = [] })
afterEach(() => {
  // Dispose any observers the test started; the shared DB closes in afterAll.
  for (const o of observers) o.dispose()
})

const put = (d: BlockData, params?: unknown[]) =>
  env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, params ?? blockToRowParams(d))
const del = (id: string) => env.db.execute(BLOCKS_SYNCED_RAW_TABLE.delete.sql, [id])

const blocks = () =>
  env.db.getAll<{ id: string; content: string }>('SELECT id, content FROM blocks ORDER BY id')
const queueLen = async () =>
  (await env.db.getAll('SELECT seq FROM blocks_synced_changes')).length

const BLOCK_COLS =
  'id, workspace_id, parent_id, order_key, content, properties_json, references_json, ' +
  'created_at, updated_at, user_updated_at, created_by, updated_by, deleted'
/** Seed a row straight into the app-visible `blocks` table (source NULL → no
 *  ps_crud, i.e. non-pending) — the shape of a locally-minted bootstrap default
 *  the observer must let the server override. */
const seedLocalBlock = (d: BlockData) =>
  env.db.execute(
    `INSERT INTO blocks (${BLOCK_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    blockToRowParams(d),
  )

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
  drainChunkSize?: number
  onError?: (err: unknown) => void
}): Harness => {
  const cache = new BlockCache()
  const notifications: ChangeNotification[] = []
  const observer = startBlocksSyncedObserver({
    db: env.db,
    cache,
    handleStore: { invalidate: (n) => notifications.push(n) },
    deps: {
      getMaterializability: opts.getMaterializability,
      getCek: opts.getCek ?? noKey,
    },
    onCycleDetected: opts.onCycleDetected,
    throttleMs: 5,
    drainChunkSize: opts.drainChunkSize,
    onError: opts.onError,
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

describe('blocksSyncedObserver — server overrides a non-pending local row (disk + live heal)', () => {
  it('overwrites a 0-stamped pristine default with the older server row, on disk AND in the cache', async () => {
    // A deterministic-id default minted on read-as-absent: 0-stamped (pristine
    // sentinel), non-pending (no ps_crud), read into the cache at app start.
    // The steady-state drain heals it — no separate healing mode.
    const localDefault = data({ content: 'default', updatedAt: 0 })
    await seedLocalBlock(localDefault)
    const { observer, cache } = start({ getMaterializability: constMat('copy') })
    cache.setSnapshot(localDefault)

    // The real, authoritative server value arrives in staging — nonzero stamp.
    await put(data({ content: 'real synced config', updatedAt: 3000 }))
    await observer.flush()

    // Disk: the server value replaced the pristine default via the stamp-0
    // exemption.
    expect(await blocks()).toEqual([{ id: 'b1', content: 'real synced config' }])
    // Cache (in-session): applyFromSync force-applies the server row because the
    // cache still matched the pre-write disk row — the LIVE heal, no reload.
    expect(cache.getSnapshot('b1')).toMatchObject({ content: 'real synced config' })
  })

  it('also overwrites a strictly-newer NON-pending local row (replay transient, echo converges)', async () => {
    // No more strictly-newer protection. A nonzero local row strictly newer than
    // an older delivery, with no pending upload, is an acked edit facing a stale
    // in-flight replay. The gate applies the older server row — a transient
    // revert the upload echo (server stamp >= local via the floor+bump)
    // converges. A genuinely-unsent edit would be pending and is still guarded.
    const localEdit = data({ content: 'my edit', updatedAt: 9000 })
    await seedLocalBlock(localEdit)
    const { observer } = start({ getMaterializability: constMat('copy') })

    await put(data({ content: 'stale server', updatedAt: 3000 }))
    await observer.flush()

    expect(await blocks()).toEqual([{ id: 'b1', content: 'stale server' }])
  })
})

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

  it('drains a deferred backlog in bounded windows, committing each independently', async () => {
    // A workspace that synced while still unpinned (fresh-device initial sync)
    // defers every row AND has its queue signal consumed — only a later
    // drainWorkspace recovers it. With a large staged backlog that recovery
    // drain must be windowed like the queue drain: a single unbounded
    // materialize pass wraps every upsert in one transaction that freezes the
    // tab and, on any mid-pass failure, rolls back ALL progress (the bug that
    // stranded ~230k rows on a real client). Fail the 2nd window and assert the
    // 1st survived — the old single-transaction drain would leave 0 rows.
    for (let i = 0; i < 4; i++) await put(data({ id: `b${i}`, workspaceId: 'ws', content: `c${i}` }))
    let mode: Materializability = 'defer'
    let windows = 0
    const getMaterializability: GetMaterializability = () => {
      if (mode === 'defer') return 'defer'
      windows += 1
      if (windows >= 2) throw new Error('boom')
      return 'copy'
    }
    const errors: unknown[] = []
    const { observer } = start({ getMaterializability, drainChunkSize: 2, onError: e => errors.push(e) })
    await observer.flush()
    expect(await blocks()).toEqual([]) // all deferred; queue consumed
    expect(await queueLen()).toBe(0)

    mode = 'copy'
    await observer.drainWorkspace('ws')

    // Window 1 (b0,b1) committed; window 2's throw didn't roll it back.
    expect(await blocks()).toEqual([{ id: 'b0', content: 'c0' }, { id: 'b1', content: 'c1' }])
    expect(errors.some(e => e instanceof Error && e.message === 'boom')).toBe(true)
  })
})

describe('blocksSyncedObserver — robustness', () => {
  it('quarantines an undecryptable row without wedging the rest of the batch', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const wrongKey = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const enc = (k: CryptoKey, d: BlockData) =>
      encodeForWire(
        {
          id: d.id, workspace_id: d.workspaceId, content: d.content,
          properties_json: JSON.stringify(d.properties),
          references_json: JSON.stringify(d.references),
        },
        'e2ee', async () => k,
      )

    const good = data({ id: 'good', workspaceId: 'ws-e2ee', content: 'readable' })
    const bad = data({ id: 'bad', workspaceId: 'ws-e2ee', content: 'unreadable' })
    await put(good, stagingCiphertextParams(good, await enc(key, good)))
    // A well-formed envelope sealed under a DIFFERENT key → AEAD verification
    // fails. One such row must not block the rest of the drain.
    await put(bad, stagingCiphertextParams(bad, await enc(wrongKey, bad)))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { observer } = start({ getMaterializability: constMat('decrypt'), getCek: async () => key })
    await observer.flush()
    warn.mockRestore()

    // The good row materialized; the bad row was quarantined (skipped); the
    // queue fully drained — no wedge, no infinite-retry head-of-line block.
    // (The quarantine contract itself — out.quarantined — is asserted at the
    // materialize unit level.)
    expect(await blocks()).toEqual([{ id: 'good', content: 'readable' }])
    expect(await queueLen()).toBe(0)
  })

  it('drains a backlog larger than the chunk size across bounded windows', async () => {
    // 5 distinct queued rows, chunk size 2 → three windows (2 + 2 + 1). One
    // flush must loop until the whole backlog is materialized and the queue is
    // empty — the regression was a single unbounded pass over the entire queue.
    for (let i = 0; i < 5; i++) await put(data({ id: `b${i}`, content: `c${i}` }))
    const { observer } = start({ getMaterializability: constMat('copy'), drainChunkSize: 2 })

    await observer.flush()

    expect(await blocks()).toEqual([
      { id: 'b0', content: 'c0' }, { id: 'b1', content: 'c1' },
      { id: 'b2', content: 'c2' }, { id: 'b3', content: 'c3' },
      { id: 'b4', content: 'c4' },
    ])
    expect(await queueLen()).toBe(0)
  })

  it('commits each window independently, so a mid-backlog failure keeps prior progress', async () => {
    for (let i = 0; i < 4; i++) await put(data({ id: `b${i}`, content: `c${i}` }))
    // getMaterializability is resolved once per window (all rows share a
    // workspace); throw on the second window so its materialize aborts.
    let windows = 0
    const getMaterializability: GetMaterializability = () => {
      windows += 1
      if (windows >= 2) throw new Error('boom')
      return 'copy'
    }
    const errors: unknown[] = []
    const { observer } = start({
      getMaterializability, drainChunkSize: 2, onError: e => errors.push(e),
    })

    await observer.flush()

    // First window (b0,b1) committed and consumed; the second window's failure
    // left its rows queued for a later retry rather than rolling back everything.
    expect(await blocks()).toEqual([{ id: 'b0', content: 'c0' }, { id: 'b1', content: 'c1' }])
    expect(await queueLen()).toBe(2)
    // The failure surfaced via onError (the initial start() drain and the
    // explicit flush both reach the throwing window); it never rejects flush().
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors.every(e => e instanceof Error && e.message === 'boom')).toBe(true)
  })

  it('keeps a locally-edited block when the server re-delivers it (collapse → single upsert, skip-staled)', async () => {
    // `put` is INSERT OR REPLACE, so re-delivering an existing staged row fires
    // DELETE then INSERT. The blocks_synced_changes_insert trigger collapses
    // that to a single 'upsert' at enqueue, which the drain then skip-stales
    // against the user's pending local edit (newer local stamp + pending
    // upload). The unsent edit must survive the re-delivery.
    await put(data({ content: 'server v1', updatedAt: 1 }))
    const { observer } = start({ getMaterializability: constMat('copy'), drainChunkSize: 1 })
    await observer.flush()
    expect(await blocks()).toEqual([{ id: 'b1', content: 'server v1' }])

    // The user edits b1 locally; the edit is queued for upload (pending).
    await env.db.execute(
      'UPDATE blocks SET content = ?, updated_at = ? WHERE id = ?', ['local edit', 100, 'b1'],
    )
    await env.db.execute(
      "INSERT INTO ps_crud (tx_id, data) VALUES (1, json_object('op','PATCH','type','blocks','id',?,'data',json_object()))",
      ['b1'],
    )

    // Server re-delivers b1 → REPLACE → collapsed to a single 'upsert'.
    await put(data({ content: 'server v2', updatedAt: 2 }))
    await observer.flush()

    // The local edit survives (skip-staled), and the queue still fully drains.
    expect(await blocks()).toEqual([{ id: 'b1', content: 'local edit' }])
    expect(await queueLen()).toBe(0)
  })

  it('skip-if-staged: a lone delete whose staging row still exists does not drop the block (defense-in-depth)', async () => {
    // The enqueue-collapse means a REPLACE nets a single 'upsert', so a lone
    // 'delete' with the staging row still present no longer arises from the
    // normal trigger path. The materialize guard (readExistingStagingIds) stays
    // as defense-in-depth: if such a 'delete' ever reaches the drain, the
    // still-present staging row proves the row is alive (a REPLACE artifact, not
    // a stream-exit), so the block must survive.
    await put(data({ content: 'server v1', updatedAt: 1 }))
    const { observer } = start({ getMaterializability: constMat('copy') })
    await observer.flush()
    expect(await blocks()).toEqual([{ id: 'b1', content: 'server v1' }])

    // The staging row for b1 is still present. Manually enqueue a lone 'delete'
    // (the artifact the collapse would normally absorb) to exercise the guard.
    await env.db.execute("INSERT INTO blocks_synced_changes (id, op) VALUES ('b1', 'delete')")
    await observer.flush()

    // The block survives because its staging row still exists; queue drains.
    expect(await blocks()).toEqual([{ id: 'b1', content: 'server v1' }])
    expect(await queueLen()).toBe(0)
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

  it('emits cycleDetected for a sync-applied 3-cycle (startIds cover all three members)', async () => {
    // The 2-cycle test above only walks one hop; this drives the cycleScanSql
    // recursion across three members (A→B→C→A) to confirm n>2 loops are caught.
    const events: CycleDetectedEvent[] = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { observer } = start({
      getMaterializability: constMat('copy'),
      onCycleDetected: e => events.push(e),
    })

    await put(data({ id: 'A', parentId: null, updatedAt: 1 }))
    await put(data({ id: 'B', parentId: null, updatedAt: 1 }))
    await put(data({ id: 'C', parentId: null, updatedAt: 1 }))
    await observer.flush()

    // Three sync-applied moves close the loop A→B→C→A (all strictly newer).
    await put(data({ id: 'A', parentId: 'B', updatedAt: 2 }))
    await put(data({ id: 'B', parentId: 'C', updatedAt: 2 }))
    await put(data({ id: 'C', parentId: 'A', updatedAt: 2 }))
    await observer.flush()

    expect(events.length).toBeGreaterThanOrEqual(1)
    const startIds = new Set<string>()
    for (const ev of events) {
      expect(ev.workspaceId).toBe('ws-plain')
      ev.startIds.forEach(id => startIds.add(id))
    }
    expect([...startIds].sort()).toEqual(['A', 'B', 'C'])
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
