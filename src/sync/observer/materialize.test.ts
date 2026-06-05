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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BLOCKS_SYNCED_RAW_TABLE,
  BLOCK_STORAGE_COLUMNS,
  blockToRowParams,
} from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { materializeStagingRows, type Materializability } from './materialize.js'
import { encodeForWire, type GetCek } from '../transform.js'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '../crypto/workspaceKey.js'
import type { BlockData } from '@/data/api'

const COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map(c => c.name)
const INSERT_BLOCK_SQL = `INSERT INTO blocks (${COLUMN_NAMES.join(', ')}) VALUES (${COLUMN_NAMES.map(() => '?').join(', ')})`

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
  createdBy: 'user-1',
  updatedBy: 'user-1',
  deleted: false,
  ...overrides,
})

/** Build positional staging-row params, replacing the three content columns
 *  with already-encoded (ciphertext) strings. */
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
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
// Reuse one DB across the file; reset (not reopen) per test.
beforeEach(async () => { await resetTestDb(sharedDb.db); env = sharedDb })

const stageRow = (data: BlockData, params?: unknown[]) =>
  env.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, params ?? blockToRowParams(data))

const seedLocalBlock = (data: BlockData) =>
  env.db.execute(INSERT_BLOCK_SQL, blockToRowParams(data))

const allBlocks = () =>
  env.db.getAll<{ id: string; content: string; properties_json: string; updated_at: number }>(
    'SELECT id, content, properties_json, updated_at FROM blocks ORDER BY id',
  )

const crudCount = async () =>
  (await env.db.getAll('SELECT id FROM ps_crud')).length

const constMat = (m: Materializability) => () => m

const noKey: GetCek = async () => null

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

  it('skips when the local row is newer than the staging snapshot', async () => {
    await seedLocalBlock(blockData({ content: 'newer local', updatedAt: 500 }))
    await stageRow(blockData({ content: 'older server', updatedAt: 200 }))

    const out = await materializeStagingRows(
      env.db,
      { upserted: ['b1'], removed: [] },
      { getMaterializability: constMat('copy'), getCek: noKey },
    )

    expect(out.skippedStale).toEqual(['b1'])
    expect((await allBlocks())[0]!.content).toBe('newer local')
  })

  it('skips a stale e2ee row WITHOUT decrypting it (undecryptable stale ciphertext cannot abort the batch)', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    const getCek: GetCek = async () => key
    // Local row is newer than the staging snapshot.
    await seedLocalBlock(blockData({ id: 'x', workspaceId: 'ws-e2ee', content: 'local', updatedAt: 500 }))
    // Staging holds *undecryptable* ciphertext — decodeFromWire would throw if
    // ever called — but the row is stale, so it must be skipped before decrypt.
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
    // skip: local row is newer than the staging snapshot.
    await seedLocalBlock(blockData({ id: 'newer', content: 'local newer', updatedAt: 500 }))
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

    expect(out.applied).toEqual(['apply'])
    expect([...out.skippedStale].sort()).toEqual(['newer', 'pending'])
    const byId = Object.fromEntries((await allBlocks()).map(b => [b.id, b.content]))
    expect(byId).toEqual({ apply: 'fresh', newer: 'local newer', pending: 'local pending' })
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
})
