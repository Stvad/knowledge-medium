// @vitest-environment node
/**
 * Layout B observer driver (design doc §9.2, D-2c) — end-to-end against a real
 * `@powersync/node` DB: staging write → capture trigger → queue → drain →
 * materialize → invalidate, plus the drain's race/failure/restart robustness.
 */

import { describe, expect, it, vi } from 'vitest'
import type { GetMaterializability, Materializability } from './materialize.js'
import { encodeForWire, type GetCek } from '@/sync/transform.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '@/sync/crypto/workspaceKey.js'
import type { InvalidationRule } from '@/data/invalidation'
import type { BlockData, CycleDetectedEvent } from '@/data/api'
import { constMat, stagingCiphertextParams, setupObserverTestDb } from './test/harness.js'

const data = (o: Partial<BlockData> = {}): BlockData => ({
  id: 'b1', workspaceId: 'ws-plain', parentId: null, orderKey: 'a0', content: 'hello',
  properties: {}, references: [], createdAt: 1, updatedAt: 1, userUpdatedAt: 1, createdBy: 'u',
  updatedBy: 'u', deleted: false, ...o,
})

const { env, start, seedLocalBlock, stageRow: put, deleteStagingRow: del, blocks, queueLen } =
  setupObserverTestDb()

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

/** Ids of `workspaceId`'s staging rows the drain has not resolved — the durable
 *  gap `WORKSPACE_UNAPPLIED_SQL` counts, read directly. */
const unapplied = async (workspaceId: string): Promise<string[]> =>
  (await env.db.getAll<{ id: string }>(
    'SELECT id FROM blocks_synced WHERE workspace_id = ? AND needs_apply = 1 ORDER BY id',
    [workspaceId],
  )).map(row => row.id)

const waitFor = async (cond: () => Promise<boolean>, ms = 3000): Promise<void> => {
  const t0 = Date.now()
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out')
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
    // Cache (in-session): plain LWW accepts the server row because it out-stamps
    // the 0 sentinel — the LIVE heal, no reload, no force-heal needed.
    expect(cache.getSnapshot('b1')).toMatchObject({ content: 'real synced config' })
  })

  it('also overwrites a strictly-newer NON-pending local row ON DISK (replay transient, echo converges)', async () => {
    // No strictly-newer DISK protection. A nonzero local row strictly newer than
    // an older delivery, with no pending upload, is an acked edit facing a stale
    // in-flight replay. The gate applies the older server row on disk — a
    // transient revert the upload echo (server stamp >= local via the floor+bump)
    // converges. A genuinely-unsent edit would be pending and is still guarded.
    const localEdit = data({ content: 'my edit', updatedAt: 9000 })
    await seedLocalBlock(localEdit)
    const { observer } = start({ getMaterializability: constMat('copy') })

    await put(data({ content: 'stale server', updatedAt: 3000 }))
    await observer.flush()

    expect(await blocks()).toEqual([{ id: 'b1', content: 'stale server' }])
  })

  it('does NOT surface that disk transient in the live cache (no stale-echo flash)', async () => {
    // Same replay as above, but with the real edit live in the cache (the UI is
    // showing it). The disk gate still transiently reverts, but the cache write
    // is LWW: it rejects the older server row, so the cache keeps the edit and no
    // handle is woken — no new→old→new flash. The echo re-converges disk; a
    // reload would rehydrate from the (by-then healed) disk.
    const localEdit = data({ content: 'my edit', updatedAt: 9000 })
    await seedLocalBlock(localEdit)
    const { observer, cache } = start({ getMaterializability: constMat('copy') })
    cache.setSnapshot(localEdit)

    await put(data({ content: 'stale server', updatedAt: 3000 }))
    await observer.flush()

    // Disk took the transient revert; the live cache did not.
    expect(await blocks()).toEqual([{ id: 'b1', content: 'stale server' }])
    expect(cache.getSnapshot('b1')).toMatchObject({ content: 'my edit' })
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
    // And it REJECTS: the awaiters (the key gate, the once-per-client reconcile
    // rescan) treat resolution as "the workspace is materialized" and act on it
    // irreversibly, so a pass that stopped two windows in must not report
    // success (km-fsxp).
    await expect(observer.drainWorkspace('ws')).rejects.toThrow('boom')

    // Window 1 (b0,b1) committed; window 2's throw didn't roll it back.
    expect(await blocks()).toEqual([{ id: 'b0', content: 'c0' }, { id: 'b1', content: 'c1' }])
    expect(errors.some(e => e instanceof Error && e.message === 'boom')).toBe(true)
  })
})

describe('blocksSyncedObserver — the queue-blind rescan is observable', () => {
  it('flags a workspace rescan as in flight, and never flags a queue drain', async () => {
    // `drainWorkspace` rewrites `blocks` straight from `blocks_synced` and
    // stages nothing, so this flag is a reader's ONLY trace of it. A queue
    // drain must not set it: a flag that meant "the observer is busy" would
    // make every consumer refuse for the whole of ordinary sync.
    await put(data({ id: 'b1', workspaceId: 'ws', content: 'c1' }))
    const { observer } = start({ getMaterializability: constMat('copy') })

    const queued = observer.flush()
    expect(observer.isRematerializingWorkspace('ws')).toBe(false)
    await queued
    expect(observer.isRematerializingWorkspace('ws')).toBe(false)

    // Set at ENQUEUE, not at the first window: a rescan waiting its turn on the
    // chain will still rewrite `blocks` before any consumer hears otherwise.
    const rescan = observer.drainWorkspace('ws')
    expect(observer.isRematerializingWorkspace('ws')).toBe(true)
    // And scoped to it: someone who navigated to another workspace must not be
    // refused for the whole of this one's rescan.
    expect(observer.isRematerializingWorkspace('ws-other')).toBe(false)
    await rescan
    expect(observer.isRematerializingWorkspace('ws')).toBe(false)
  })

  it('clears the staging flag on rows it decided, and leaves it on the rest', async () => {
    // The durable record of "this device downloaded a row it has not applied",
    // written by the drain in the transaction that decides it — every one-way
    // pass reads exactly this. A delivery arrives flagged (the raw put omits
    // the column, so it takes its default); only a decision clears it.
    await put(data({ id: 'applied', workspaceId: 'ws', content: 'c1' }))
    let mode: Materializability = 'copy'
    const { observer } = start({ getMaterializability: () => mode })
    await observer.flush()
    expect(await unapplied('ws')).toEqual([])

    mode = 'defer'
    await put(data({ id: 'deferred', workspaceId: 'ws', content: 'c2' }))
    await observer.flush()
    expect(await unapplied('ws')).toEqual(['deferred'])

    // And the re-pass that can finally apply it clears it — the flag is state,
    // not a one-way tripwire.
    mode = 'copy'
    await observer.drainWorkspace('ws')
    expect(await unapplied('ws')).toEqual([])
  })

  it('clears the flag for its own echo, which no drain will ever apply', async () => {
    // Every local write comes back down the stream and re-stages carrying the
    // stamp it was written with, so I1 skip-stales it — no `blocks` write, and
    // the re-delivery has already reset the flag. Left set, a device that is
    // merely WRITING reads as permanently behind and refuses every one-way
    // pass: the refuse-on-your-own-progress bug, back through a new door.
    await put(data({ id: 'mine', workspaceId: 'ws', content: 'v1', updatedAt: 7 }))
    const { observer } = start({ getMaterializability: constMat('copy') })
    await observer.flush()
    expect(await unapplied('ws')).toEqual([])

    await put(data({ id: 'mine', workspaceId: 'ws', content: 'v1', updatedAt: 7 }))
    await observer.flush()

    expect(await unapplied('ws')).toEqual([])
  })

  it('clears the flag for a row it cannot apply but nobody can see either', async () => {
    // A staged tombstone with no local row shows the block to no reader on
    // either side, and every protected pass scans `deleted = 0`. Left flagged
    // it would be a gap no drain can clear and no pass can be harmed by — one
    // corrupt tombstone blocking the workspace forever.
    await put(data({ id: 'dead', workspaceId: 'ws', content: 'gone', deleted: true }))
    const { observer } = start({ getMaterializability: constMat('defer') })
    await observer.flush()

    expect(await unapplied('ws')).toEqual([])
  })

  it('keeps the flag on a tombstone whose local row is still live', async () => {
    // The other half of the same rule: this one the passes CAN see, and the
    // server says it is gone.
    await seedLocalBlock(data({ id: 'doomed', workspaceId: 'ws', content: 'visible' }))
    await put(data({ id: 'doomed', workspaceId: 'ws', content: 'gone', deleted: true, updatedAt: 9 }))
    const { observer } = start({ getMaterializability: constMat('defer') })
    await observer.flush()

    expect(await unapplied('ws')).toEqual(['doomed'])
  })

  it('rejects a rescan the observer was disposed before it ever started', async () => {
    // Same rule one step earlier: a rescan still waiting its turn on the chain
    // when the tab closes has materialized nothing, and its awaiter must not be
    // handed the resolution it writes the recovery marker on.
    await put(data({ id: 'b1', workspaceId: 'ws', content: 'c1' }))
    const { observer } = start({ getMaterializability: constMat('copy') })
    const rescan = observer.drainWorkspace('ws')
    observer.dispose()
    await expect(rescan).rejects.toThrow(/disposed/)
  })

  it('rejects a rescan that dispose() cut short, rather than reporting it done', async () => {
    // `runReconcileRescan` writes its once-per-(workspace, client) marker on
    // this promise resolving, and the key gate opens the workspace on it. A tab
    // closed partway through must retire neither (km-fsxp).
    for (let i = 0; i < 4; i++) await put(data({ id: `b${i}`, workspaceId: 'ws', content: `c${i}` }))
    let mode: Materializability = 'defer'
    let windows = 0
    let live: { dispose(): void } | null = null
    const getMaterializability: GetMaterializability = () => {
      if (mode === 'defer') return 'defer'
      windows += 1
      if (windows >= 1) live?.dispose()
      return 'copy'
    }
    const errors: unknown[] = []
    const { observer } = start({
      getMaterializability, drainChunkSize: 2, onError: e => errors.push(e),
    })
    await observer.flush()
    expect(await blocks()).toEqual([]) // all deferred; queue consumed

    mode = 'copy'
    live = observer
    await expect(observer.drainWorkspace('ws')).rejects.toThrow(/disposed/)
    // Window 1 committed before the teardown landed. That the pass is resumable
    // is exactly why its caller has to be told it did not finish.
    expect(await blocks()).toEqual([{ id: 'b0', content: 'c0' }, { id: 'b1', content: 'c1' }])
    // REJECTED but not REPORTED. The disposal checks inside the drain loops
    // reach the same catch as a genuine failure, and routing them to `onError`
    // means the default handler warns on every tab close mid-drain.
    expect(errors).toEqual([])
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

  it('isolates a throwing plugin invalidation rule: watermark still advances and the handle still invalidates (#191)', async () => {
    // A plugin InvalidationRule is a live extension point. Before #191's fix, a
    // throw from one rule propagated out of snapshotsToChangeNotification →
    // applySyncInvalidation, aborting the drain AFTER the committed materialize
    // but BEFORE its watermark DELETE: the row stayed queued, and on retry the
    // disk gate skip-staled the now-equal stamp so handleStore.invalidate never
    // re-fired — a permanently-stale UI. Per-rule isolation now lets the kernel
    // notification AND the watermark DELETE both run.
    //
    // The rule throws on EVERY call (the worst case: a permanently-buggy plugin,
    // which is also what could strand a window forever pre-fix). We then assert
    // it was invoked exactly once — proving the watermark advanced and the row
    // was NOT requeued for a (futile, skip-staled) reprocess.
    let calls = 0
    const flakyRule: InvalidationRule = {
      id: 'test.flaky-rule',
      collectFromSnapshots: () => { calls += 1; throw new Error('rule boom') },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await put(data({ content: 'fresh' }))
    const { observer, cache, notifications } = start({
      getMaterializability: constMat('copy'),
      getInvalidationRules: () => [flakyRule],
    })

    await observer.flush()
    // A second flush would re-run the rule if the row were still queued.
    await observer.flush()
    warn.mockRestore()

    // The throw didn't abort the watermark DELETE: the row materialized and the
    // queue fully drained — no retry-on-equal-stamp that would lose the notify.
    expect(await blocks()).toEqual([{ id: 'b1', content: 'fresh' }])
    expect(await queueLen()).toBe(0)
    expect(cache.getSnapshot('b1')).toMatchObject({ content: 'fresh' })
    expect(calls).toBe(1) // consumed once; not reprocessed despite the throw
    // The kernel notification still reached the handle store despite the throw —
    // the handle for b1 is invalidated, not permanently stale.
    expect(notifications).toHaveLength(1)
    expect([...(notifications[0]!.rowIds ?? [])]).toEqual(['b1'])
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

    await expect(observer.flush()).rejects.toThrow('boom')

    // First window (b0,b1) committed and consumed; the second window's failure
    // left its rows queued for a later retry rather than rolling back everything.
    expect(await blocks()).toEqual([{ id: 'b0', content: 'c0' }, { id: 'b1', content: 'c1' }])
    expect(await queueLen()).toBe(2)
    // The failure surfaced via onError (the initial start() drain and the
    // explicit flush both reach the throwing window) AND rejected the barrier
    // that was awaited on it.
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
