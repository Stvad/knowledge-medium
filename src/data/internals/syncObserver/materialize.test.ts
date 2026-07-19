// @vitest-environment node
/**
 * Layout B observer — materialization core (design doc §9.2, D-2a).
 *
 * `materializeStagingRows` is the data-movement heart of the observer: it
 * turns `blocks_synced` staging rows into the app-visible plaintext `blocks`
 * table. Decrypt for e2ee-with-WK, copy-through for plaintext, leave staged
 * for not-yet-materializable, skip when a newer/pending local edit must win,
 * hard-delete on stream-exit. All writes leave `tx_context.source` NULL so
 * the upload-routing triggers skip them (no echo) while the derived-index
 * triggers (aliases/types/FTS) still fire.
 *
 * Tested against a real `@powersync/node` DB with the production schema, so
 * the source-gating and trigger interactions are the real ones.
 */

import { describe, expect, it, vi } from 'vitest'
import { materializeStagingRows } from './materialize.js'
import { encodeForWire, type GetCek } from '@/sync/transform.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '@/sync/crypto/workspaceKey.js'
import type { BlockData } from '@/data/api'
import type { PowerSyncDb } from '@/data/internals/commitPipeline.js'
import { constMat, noKey, stagingCiphertextParams, setupObserverTestDb } from './test/harness.js'

const blockData = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: 'b1',
  workspaceId: 'ws-plain',
  parentId: null,
  orderKey: 'a0',
  content: 'hello',
  properties: {},
  references: [],
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
  userUpdatedAt: 1700000000000,
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
  ...overrides,
})

const { env, stageRow, seedLocalBlock, allBlocks, crudCount, queuePendingUpload } =
  setupObserverTestDb()

/** Wrap the test DB so a racing local write fires exactly once, AFTER the
 *  Phase-1 reads (which use the auto-commit `db`) but BEFORE the Phase-2 write
 *  transaction opens — the precise TOCTOU window the authoritative in-tx
 *  re-gate has to close. Everything else proxies straight through to the real
 *  DB, so the materialization runs against the production schema as usual. */
const racingDb = (real: PowerSyncDb, raceOnce: () => Promise<unknown>): PowerSyncDb => {
  let raced = false
  return new Proxy(real as object, {
    get(target, prop, receiver) {
      if (prop === 'writeTransaction') {
        return async (fn: Parameters<PowerSyncDb['writeTransaction']>[0]) => {
          if (!raced) { raced = true; await raceOnce() }
          return real.writeTransaction(fn)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(real)
        : value
    },
  }) as PowerSyncDb
}

describe('materializeStagingRows — copy-through (plaintext workspace)', () => {
  it('copies a staged plaintext row into blocks verbatim, with no upload echo', async () => {
    await stageRow(blockData({ content: 'plain text', properties: { alias: ['Inbox'] } }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.applied).toEqual(['b1'])
    // before/after snapshot is captured for the invalidation layer.
    expect(out.snapshots.get('b1')).toMatchObject({
      before: null,
      after: { id: 'b1', content: 'plain text' },
    })
    expect(await allBlocks()).toEqual([
      { id: 'b1', content: 'plain text', properties_json: '{"alias":["Inbox"]}', updated_at: 1700000000000 },
    ])
    // source = NULL ⇒ no echo back to the upload queue.
    expect(await crudCount()).toBe(0)
    // Ungated derived-index triggers fired on the plaintext write.
    const aliases = await env.db.getAll<{ alias: string }>('SELECT alias FROM block_aliases')
    expect(aliases).toEqual([{ alias: 'Inbox' }])
  })
})

describe('materializeStagingRows — decrypt (e2ee workspace with WK)', () => {
  it('decrypts staged ciphertext into plaintext blocks and fires derived indexes', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const getCek: GetCek = async () => key

    const plain = blockData({
      id: 'enc1',
      workspaceId: 'ws-e2ee',
      content: 'secret note',
      properties: { alias: ['Secret'] },
    })
    const wire = await encodeForWire(
      {
        id: plain.id,
        workspace_id: plain.workspaceId,
        content: plain.content,
        properties_json: JSON.stringify(plain.properties),
        references_json: JSON.stringify(plain.references),
      },
      'e2ee',
      getCek,
    )
    await stageRow(plain, stagingCiphertextParams(plain, wire))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['enc1'], removed: [] },
      { getMaterializability: constMat('decrypt'), getCek },
    )

    expect(out.applied).toEqual(['enc1'])
    const rows = await env.db.getAll<{ content: string; properties_json: string }>(
      'SELECT content, properties_json FROM blocks WHERE id = ?', ['enc1'],
    )
    expect(rows).toEqual([{ content: 'secret note', properties_json: '{"alias":["Secret"]}' }])
    // Staging still holds the ciphertext (never plaintext on disk in the mirror).
    const staged = await env.db.getAll<{ content: string }>(
      'SELECT content FROM blocks_synced WHERE id = ?', ['enc1'],
    )
    expect(staged[0]!.content.startsWith('enc:v1:')).toBe(true)
    expect(await crudCount()).toBe(0)
    const aliases = await env.db.getAll<{ alias: string }>('SELECT alias FROM block_aliases')
    expect(aliases).toEqual([{ alias: 'Secret' }])
  })
})

describe('materializeStagingRows — defer (not materializable yet)', () => {
  it('leaves the row staged and writes nothing to blocks', async () => {
    await stageRow(blockData({ id: 'locked', workspaceId: 'ws-locked' }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['locked'], removed: [] },
      { getMaterializability: constMat('defer'), getCek: noKey },
    )

    expect(out.deferred).toEqual(['locked'])
    expect(out.applied).toEqual([])
    expect(await allBlocks()).toEqual([])
    // It is NOT consumed from staging — a later drain re-processes it.
    const staged = await env.db.getAll('SELECT id FROM blocks_synced')
    expect(staged).toEqual([{ id: 'locked' }])
  })
})

describe('materializeStagingRows — skip-stale (local edit must win)', () => {
  it('skips when an unsent local edit is queued for the same id', async () => {
    await seedLocalBlock(blockData({ content: 'local edit', updatedAt: 100 }))
    await env.db.execute(
      "INSERT INTO ps_crud (tx_id, data) VALUES (1, json_object('op','PATCH','type','blocks','id',?,'data',json_object()))",
      ['b1'],
    )
    // Staging snapshot is even newer, but a pending upload always wins.
    await stageRow(blockData({ content: 'server snapshot', updatedAt: 999 }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.skippedStale).toEqual(['b1'])
    expect((await allBlocks())[0]!.content).toBe('local edit')
  })

  // (The "non-pending strictly-newer local row" case is now split by write
  //  provenance — heal vs replay-protect — and covered at DB level in the
  //  "provenance gate" describe below, and exhaustively in reconcile.test.ts.)

  it('skips a pending-protected e2ee row WITHOUT decrypting it (undecryptable ciphertext cannot abort the batch)', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const getCek: GetCek = async () => key
    // Local row has an unsent edit queued (pending) → the gate skips it before
    // decrypt regardless of stamps. (Pending is the protection that still skips;
    // a merely newer-stamped non-pending local row would now apply.)
    await seedLocalBlock(blockData({ id: 'x', workspaceId: 'ws-e2ee', content: 'local', updatedAt: 500 }))
    await env.db.execute(
      "INSERT INTO ps_crud (tx_id, data) VALUES (1, json_object('op','PATCH','type','blocks','id',?,'data',json_object()))",
      ['x'],
    )
    // Staging holds *undecryptable* ciphertext — decodeFromWire would throw if
    // ever called — but the row is skipped before decrypt.
    const stale = blockData({ id: 'x', workspaceId: 'ws-e2ee', updatedAt: 200 })
    await stageRow(stale, stagingCiphertextParams(stale, {
      content: 'enc:v1:not-real-ciphertext',
      properties_json: 'enc:v1:not-real-ciphertext',
      references_json: 'enc:v1:not-real-ciphertext',
    }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['x'], removed: [] },
      { getMaterializability: constMat('decrypt'), getCek },
    )

    expect(out.skippedStale).toEqual(['x'])
    expect((await allBlocks())[0]!.content).toBe('local')
  })

  it('applies when the staging snapshot is strictly newer and nothing is pending', async () => {
    await seedLocalBlock(blockData({ content: 'old', updatedAt: 200 }))
    await stageRow(blockData({ content: 'new from server', updatedAt: 300 }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.applied).toEqual(['b1'])
    expect((await allBlocks())[0]!.content).toBe('new from server')
  })
})

describe('materializeStagingRows — batched gate (mixed outcomes, chunked)', () => {
  it('keeps each id\'s gate state separate when the local reads are bulked across chunks', async () => {
    // The Phase-1/Phase-2 gate reads (local updated_at, pending uploads, before
    // rows) are bulked per batch rather than probed per row. Drive three ids to
    // three different outcomes in ONE pass, with a chunk size that splits them,
    // so a map that crossed an id with another's state would surface here.

    // apply: strictly-newer staging snapshot, no local row.
    await stageRow(blockData({ id: 'apply', content: 'fresh', updatedAt: 300 }))
    // apply: a strictly-newer NONZERO local row yields to the older server row
    // (no strictly-newer protection — the echo converges).
    await seedLocalBlock(blockData({
      id: 'newer', content: 'local newer', updatedAt: 500,
    }))
    await stageRow(blockData({ id: 'newer', content: 'stale server', updatedAt: 200 }))
    // skip: an unsent local edit is queued for this id (pending always wins).
    await seedLocalBlock(blockData({ id: 'pending', content: 'local pending', updatedAt: 100 }))
    await env.db.execute(
      "INSERT INTO ps_crud (tx_id, data) VALUES (1, json_object('op','PATCH','type','blocks','id',?,'data',json_object()))",
      ['pending'],
    )
    await stageRow(blockData({ id: 'pending', content: 'server snapshot', updatedAt: 999 }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['apply', 'newer', 'pending'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
      { readChunkSize: 2 }, // 3 ids → 2 read chunks, so the bulk maps span a boundary
    )

    expect([...out.applied].sort()).toEqual(['apply', 'newer'])
    expect(out.skippedStale).toEqual(['pending'])
    const byId = Object.fromEntries((await allBlocks()).map(b => [b.id, b.content]))
    expect(byId).toEqual({ apply: 'fresh', newer: 'stale server', pending: 'local pending' })
  })
})

describe('materializeStagingRows — stamp-0 sentinel (deterministic-id shadow)', () => {
  // The headline fix. A deterministic-id default minted on read-as-absent is
  // stamped updated_at = 0 (the pristine sentinel); the server's authoritative
  // row is nonzero. The gate yields the 0-stamped local row to the server.

  it('heals: a 0-stamped pristine local default yields to the server row', async () => {
    await seedLocalBlock(blockData({ content: 'local default', updatedAt: 0 }))
    await stageRow(blockData({ content: 'real synced config', updatedAt: 200 }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.applied).toEqual(['b1'])
    expect((await allBlocks())[0]!.content).toBe('real synced config')
  })

  it('applies the server row over a strictly-newer NONZERO local row (echo converges)', async () => {
    // No more strictly-newer protection. A nonzero local row strictly newer than
    // an in-flight older delivery is either pending (guarded) or acked; this
    // non-pending one is an acked edit facing a stale replay. The gate applies
    // the older server row — a transient revert the upload echo (server stamp >=
    // local, via the floor+bump) converges. Pre-split this was "protected".
    await seedLocalBlock(blockData({ content: 'my edit', updatedAt: 500 }))
    await stageRow(blockData({ content: 'stale server', updatedAt: 200 }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.applied).toEqual(['b1'])
    expect((await allBlocks())[0]!.content).toBe('stale server')
  })
})

describe('materializeStagingRows — quarantine (undecryptable)', () => {
  it('quarantines a row whose ciphertext fails AEAD, still applying a valid sibling', async () => {
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

    const good = blockData({ id: 'good', workspaceId: 'ws-e2ee', content: 'ok' })
    const bad = blockData({ id: 'bad', workspaceId: 'ws-e2ee', content: 'corrupt' })
    await stageRow(good, stagingCiphertextParams(good, await enc(key, good)))
    // 'bad' is a well-formed enc:v1: envelope, but sealed under a DIFFERENT key,
    // so AEAD verification fails when opened with `key` — what a tampered or
    // direct-writer row looks like.
    await stageRow(bad, stagingCiphertextParams(bad, await enc(wrongKey, bad)))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await materializeStagingRows(
      env.db,
      { upserted: ['good', 'bad'], removed: [] },
      { getMaterializability: constMat('decrypt'), getCek: async () => key },
    )
    warn.mockRestore()

    expect(out.applied).toEqual(['good'])
    expect(out.quarantined).toEqual(['bad']) // skipped, not thrown
    expect(await env.db.getAll('SELECT id FROM blocks ORDER BY id')).toEqual([{ id: 'good' }])
  })
})

describe('materializeStagingRows — chunked staging reads', () => {
  it('materializes more ids than the IN-clause chunk size (no bound-parameter overflow)', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `c${i}`)
    for (const id of ids) await stageRow(blockData({ id, content: `v-${id}` }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ids, removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
      { readChunkSize: 2 }, // 5 ids → 3 chunks (2, 2, 1)
    )

    expect([...out.applied].sort()).toEqual(ids)
    const rows = await env.db.getAll<{ id: string }>('SELECT id FROM blocks ORDER BY id')
    expect(rows.map(r => r.id)).toEqual(ids)
  })
})

describe('materializeStagingRows — removed (stream-exit)', () => {
  it('hard-deletes the local row and cleans its derived indexes, with no echo', async () => {
    await seedLocalBlock(blockData({ content: 'goodbye', properties: { alias: ['Gone'] } }))
    // Trigger-maintained alias index exists for the seeded row.
    await env.db.execute(
      "INSERT OR IGNORE INTO block_aliases (block_id, workspace_id, alias, alias_lower) VALUES ('b1','ws-plain','Gone','gone')",
    )

    const out = await materializeStagingRows(
      env.db,
      { upserted: [], removed: ['b1'] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.deleted).toEqual(['b1'])
    expect(out.snapshots.get('b1')).toMatchObject({
      before: { id: 'b1', content: 'goodbye' },
      after: null,
    })
    expect(await allBlocks()).toEqual([])
    const aliases = await env.db.getAll('SELECT alias FROM block_aliases')
    expect(aliases).toEqual([])
    expect(await crudCount()).toBe(0)
  })

  it('does NOT delete when the staging row still exists (INSERT OR REPLACE artifact, not a stream-exit)', async () => {
    // INSERT OR REPLACE re-delivery enqueues delete-then-upsert; drained in seq
    // windows the delete can arrive alone. But the staging row is still present
    // (the replace re-inserted it), so this is not a removal — dropping the
    // local row would clobber an unsent local edit and the gated upsert wouldn't
    // restore it. A delete is honored only once the staging row is truly gone.
    await seedLocalBlock(blockData({ content: 'local edit', updatedAt: 500 }))
    await stageRow(blockData({ content: 'server snapshot', updatedAt: 999 })) // staging row present

    const out = await materializeStagingRows(
      env.db,
      { upserted: [], removed: ['b1'] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.deleted).toEqual([])
    expect((await allBlocks())[0]?.content).toBe('local edit')
  })
})

describe('materializeStagingRows — Phase-1/Phase-2 TOCTOU re-gate', () => {
  // The Phase-1 staleness reads run outside the write tx, so a local edit can
  // land between them and the lock. These cover the race the second phase exists
  // to close — Phase 1 sees a clean gate, something changes in the window, and
  // the in-tx re-gate re-reads the AUTHORITATIVE state (both updated_at and
  // updated_by). Two ways a window change protects the local row: a pending
  // upload, and — under the strict provenance gate — a real (non-system) edit
  // that bumps the stamp strictly above staging. A window change to an own
  // system mint instead heals (applies), proving the re-gate isn't a mere
  // skip-detector.

  it('skips a candidate when a local edit is queued for upload in the window', async () => {
    await seedLocalBlock(blockData({ content: 'local v1', updatedAt: 200 }))
    await stageRow(blockData({ content: 'server v2', updatedAt: 300 }))

    const out = await materializeStagingRows(
      racingDb(env.db, () => queuePendingUpload('b1')),
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.applied).toEqual([])
    expect(out.skippedStale).toEqual(['b1'])
    expect(out.snapshots.has('b1')).toBe(false) // nothing written ⇒ nothing to invalidate
    expect((await allBlocks())[0]!.content).toBe('local v1')
  })

  it('skips when a racing write bumps the local stamp to EQUAL the staging stamp in the window', async () => {
    await seedLocalBlock(blockData({ content: 'local v1', updatedAt: 200 }))
    await stageRow(blockData({ content: 'server v2', updatedAt: 300 }))

    const out = await materializeStagingRows(
      racingDb(env.db, async () => {
        await env.db.execute('UPDATE blocks SET updated_at = ? WHERE id = ?', [300, 'b1'])
      }),
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    // Phase 1 saw local@200 < staging@300 (applyable). The window bumped the
    // local stamp to 300 — now EQUAL (and nonzero) to staging — so the re-gate's
    // equal-stamp guard skips it. Proves Phase 2 uses authoritative in-tx state,
    // not the stale Phase-1 read.
    expect(out.applied).toEqual([])
    expect(out.skippedStale).toEqual(['b1'])
    expect((await allBlocks())[0]!.content).toBe('local v1')
  })
})

describe('materializeStagingRows — soft-delete (tombstone) materialization', () => {
  const deletedFlag = (id: string) =>
    env.db.getAll<{ deleted: number }>('SELECT deleted FROM blocks WHERE id = ?', [id])

  it('materializes a deleted=true snapshot as a soft-deleted row, not a hard delete', async () => {
    // A tombstone arrives as an UPSERT (still in the synced set, just flagged
    // deleted) — distinct from the `removed` stream-exit path. It must land in
    // `blocks` as deleted=1 so it can still sync / LWW-merge, not vanish.
    await stageRow(blockData({ content: 'tombstone', deleted: true }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.applied).toEqual(['b1'])
    expect(out.deleted).toEqual([]) // not the hard-delete path
    expect(await deletedFlag('b1')).toEqual([{ deleted: 1 }])
    expect(out.snapshots.get('b1')).toMatchObject({
      before: null,
      after: { id: 'b1', deleted: true },
    })
  })

  it('soft-deletes a previously-live local row when a newer tombstone arrives', async () => {
    await seedLocalBlock(blockData({ content: 'alive', updatedAt: 100 }))
    await stageRow(blockData({ content: 'alive', deleted: true, updatedAt: 200 }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.applied).toEqual(['b1'])
    expect(out.deleted).toEqual([])
    expect(await deletedFlag('b1')).toEqual([{ deleted: 1 }])
    expect(out.snapshots.get('b1')).toMatchObject({
      before: { deleted: false },
      after: { deleted: true },
    })
  })
})

describe('materializeStagingRows — dev assertion: arrived references_json must be canonical (issue #404 item 2)', () => {
  // `setDevAssertionsEnabled(true)` in src/test/setup.ts keeps L2 assertions on
  // for the whole suite, so this exercises the real production gate rather
  // than flipping it locally.

  it('throws when the staged references array is not in canonical (sorted) order', async () => {
    await stageRow(blockData({
      references: [
        { id: 'b-target', alias: 'B' },
        { id: 'a-target', alias: 'A' },
      ],
    }))

    await expect(materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )).rejects.toThrow(/not canonical/)
  })

  it('applies normally when the staged references array is already canonical', async () => {
    await stageRow(blockData({
      references: [
        { id: 'a-target', alias: 'A' },
        { id: 'b-target', alias: 'B' },
      ],
    }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.applied).toEqual(['b1'])
  })
})
