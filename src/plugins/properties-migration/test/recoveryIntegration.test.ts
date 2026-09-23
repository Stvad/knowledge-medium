// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import { ChangeScope, seedProperty, type BlockData } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { BLOCKS_SYNCED_RAW_TABLE, BLOCKS_TABLE_COLUMN_NAMES, blockToRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { SEED_STAGING_NEEDS_APPLY_SQL } from '@/data/internals/syncObserver/reconcile'
import { stagingCiphertextParams } from '@/data/internals/syncObserver/test/harness'
import { encodeForWire, type Materializability } from '@/sync/transform'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '@/sync/crypto/workspaceKey'
import { deriveContentKeyHmac } from '@/sync/crypto/contentKey'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'

const ui = vi.hoisted(() => ({
  confirm: vi.fn(), info: vi.fn(), done: vi.fn(), fail: vi.fn(), flip: vi.fn(),
}))
vi.mock('@/utils/dialogs', () => ({openDialog: (...args: unknown[]) => ui.confirm(...args)}))
vi.mock('@/utils/toast', () => ({showInfo: (...args: unknown[]) => ui.info(...args), dismissToast: vi.fn()}))
vi.mock('../ConfirmMigrationDialog', () => ({ConfirmMigrationDialog: () => null}))
vi.mock('../progressReport', () => ({reportMigrationProgress: () => ({
  update: vi.fn(), done: ui.done, fail: ui.fail, settleUnreported: vi.fn(), addNote: vi.fn(),
})}))
vi.mock('@/data/repoProvider', () => ({isRemoteSyncActive: () => true}))
// The server flip is the sole external write. Model its local echo; the Repo,
// observer, eligibility checks, survey, claim and property backfill stay real.
vi.mock('@/data/workspaces', async original => ({
  ...(await original<typeof import('@/data/workspaces')>()),
  flipWorkspaceToChildBackedProperties: (...args: unknown[]) => ui.flip(...args),
}))

import { migratePropertiesToBlocksAction } from '../action'

const WS = 'fixture-encrypted'
const USER = 'fixture-user'
const property = seedProperty({
  seedKey: 'test/property/recovery-note', revision: 1, name: 'fixture:note',
  preset: 'optional-string', defaultValue: undefined, changeScope: ChangeScope.BlockDefault,
})
let shared: TestDb
let repo: Repo
let materializability: Materializability
let key: CryptoKey

beforeAll(async () => { shared = await createTestDb() })
afterAll(async () => { await shared.cleanup() })
beforeEach(async () => {
  vi.clearAllMocks()
  await resetTestDb(shared.db)
  const entries = new Map<string, string>()
  const localStorage = {
    getItem: (k: string) => entries.get(k) ?? null,
    setItem: (k: string, v: string) => { entries.set(k, v) },
    removeItem: (k: string) => { entries.delete(k) },
  }
  vi.stubGlobal('localStorage', localStorage)
  vi.stubGlobal('window', {localStorage})
  const bytes = generateWorkspaceKeyBytes()
  key = await importWorkspaceKey(bytes)
  await getWorkspaceKeyStore().put(USER, WS, {
    wk: key, contentKeyHmac: await deriveContentKeyHmac(bytes),
  })
  await shared.db.execute(
    `INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'Fixture', ?, 1, 1, 'e2ee', 'fixture-canary', 'cell')`, [WS, USER])
  setModePin(USER, WS, 'e2ee')
  materializability = 'defer'
  repo = createTestRepo({
    db: shared.db, user: {id: USER}, startSyncObserver: true,
    extensions: [definitionSeedsFacet.of(property, {source: 'test'})],
    syncObserverDeps: {getMaterializability: () => materializability, getCek: async () => key},
  }).repo
  repo.setActiveWorkspaceId(WS)
  ui.confirm.mockResolvedValue(true)
  ui.flip.mockImplementation(async () => {
    await shared.db.execute("UPDATE workspaces SET properties_migration = 'children' WHERE id = ?", [WS])
    return {localApplied: true}
  })
})
afterEach(async () => {
  repo.stopSyncObserver()
  await getWorkspaceKeyStore().delete(USER, WS)
  vi.unstubAllGlobals()
})

const strandEncrypted = async (encryptionKey = key, legacyLocalCopy = false) => {
  const block: BlockData = {
    id: 'encrypted-block', workspaceId: WS, parentId: null, orderKey: 'a0',
    content: 'Fixture content', properties: {'fixture:note': 'Fixture property'}, references: [],
    createdAt: 1, updatedAt: legacyLocalCopy ? 0 : 10, userUpdatedAt: legacyLocalCopy ? 0 : 10,
    createdBy: USER, updatedBy: USER, deleted: false,
  }
  const wire = await encodeForWire({
    id: block.id, workspace_id: WS, content: block.content,
    properties_json: JSON.stringify(block.properties), references_json: '[]',
  }, 'e2ee', async () => encryptionKey)
  await shared.db.writeTransaction(async tx => {
    if (legacyLocalCopy) {
      await tx.execute(
        `INSERT INTO blocks (${BLOCKS_TABLE_COLUMN_NAMES.join(', ')})
         VALUES (${BLOCKS_TABLE_COLUMN_NAMES.map(() => '?').join(', ')})`, blockToRowParams(block))
    }
    await tx.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, stagingCiphertextParams(block, wire))
    if (legacyLocalCopy) {
      // Legacy rows have no pending delivery; the upgrade's conservative seed
      // cannot compare encrypted wire bytes with the equal plaintext row.
      await tx.execute('DELETE FROM blocks_synced_changes')
      await tx.execute(SEED_STAGING_NEEDS_APPLY_SQL)
    }
  })
  await repo.flushSyncObserver()
  expect(await shared.db.getAll('SELECT id FROM blocks_synced_changes')).toEqual([])
  const local = await shared.db.getOptional('SELECT id FROM blocks WHERE id = ?', [block.id])
  if (legacyLocalCopy) expect(local).toEqual({id: block.id})
  else expect(local).toBeNull()
  expect(await repo.workspaceViewGap(WS)).toMatchObject({transient: false})
}

const invoke = () => migratePropertiesToBlocksAction({repo}).handler({} as never, {} as never)

describe('encrypted durable gap through the migration gesture', () => {
  it('recovers ciphertext before consent and migrates its actual property value after confirmation', async () => {
    await strandEncrypted()
    materializability = 'decrypt'
    const recovery = vi.spyOn(repo, 'rematerializeWorkspace')
    const claim = vi.spyOn(repo, 'withOperatorBackfillClaim')
    const historyDrop = vi.spyOn(repo.undoManagerFor(WS), 'beginHistoryDrop')
    ui.confirm.mockImplementation(async () => {
      expect(await repo.workspaceViewGap(WS)).toBeNull()
      expect(await shared.db.getOptional<{content: string}>(
        'SELECT content FROM blocks WHERE id = ?', ['encrypted-block']))
        .toEqual({content: 'Fixture content'})
      expect(claim).not.toHaveBeenCalled()
      expect(historyDrop).not.toHaveBeenCalled()
      expect(ui.flip).not.toHaveBeenCalled()
      return true
    })
    await invoke()
    expect(recovery).toHaveBeenCalledExactlyOnceWith(WS, {scope: 'unapplied'})
    expect(ui.confirm).toHaveBeenCalledOnce()
    expect(ui.flip).toHaveBeenCalledOnce()
    expect(ui.fail).not.toHaveBeenCalled()
    expect(ui.done).toHaveBeenCalledWith(expect.stringContaining('Migrated properties on'))
    const field = await shared.db.getOptional<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND is_field_form = 1 AND deleted = 0', ['encrypted-block'])
    expect(field).not.toBeNull()
    expect(await shared.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0', [field!.id]))
      .toContainEqual({content: 'Fixture property'})
  }, 20_000) // Real SQLite recovery plus migration; allow gate contention.

  it('reapplies an identical legacy encrypted stamp-zero row and clears its unverified flag before consent', async () => {
    materializability = 'decrypt'
    await strandEncrypted(key, true)
    const staged = await shared.db.getOptional<{content: string; updated_at: number; needs_apply: number}>(
      'SELECT content, updated_at, needs_apply FROM blocks_synced WHERE id = ?', ['encrypted-block'])
    expect(staged).toMatchObject({updated_at: 0, needs_apply: 1})
    expect(staged!.content).toMatch(/^enc:v1:/)
    const localBefore = await shared.db.getOptional('SELECT * FROM blocks WHERE id = ?', ['encrypted-block'])
    expect(localBefore).toMatchObject({updated_at: 0, content: 'Fixture content'})
    expect((await repo.workspaceViewGap(WS))?.reason).toMatch(/not been verified/)

    const recovery = vi.spyOn(repo, 'rematerializeWorkspace')
    const claim = vi.spyOn(repo, 'withOperatorBackfillClaim')
    ui.confirm.mockResolvedValue(false)
    await invoke()

    expect(recovery).toHaveBeenCalledExactlyOnceWith(WS, {scope: 'unapplied'})
    expect(await recovery.mock.results[0]!.value).toMatchObject({
      scanned: 1, applied: 1, resolved: 1, deferred: 0, quarantined: 0,
      unappliedBefore: 1, unappliedAfter: 0, remainingGap: null,
    })
    expect(await shared.db.getOptional('SELECT needs_apply FROM blocks_synced WHERE id = ?', ['encrypted-block']))
      .toEqual({needs_apply: 0})
    expect(await shared.db.getOptional('SELECT * FROM blocks WHERE id = ?', ['encrypted-block']))
      .toEqual(localBefore)
    expect(await repo.workspaceViewGap(WS)).toBeNull()
    expect(ui.confirm).toHaveBeenCalledOnce()
    expect(claim).not.toHaveBeenCalled()
    expect(ui.flip).not.toHaveBeenCalled()
  })

  it.each(['deferred', 'quarantined'] as const)('reports unresolved encrypted rows (%s) and refuses once', async cause => {
    const encryptedWith = cause === 'quarantined'
      ? await importWorkspaceKey(generateWorkspaceKeyBytes()) : key
    await strandEncrypted(encryptedWith)
    if (cause === 'quarantined') materializability = 'decrypt'
    const recovery = vi.spyOn(repo, 'rematerializeWorkspace')
    const claim = vi.spyOn(repo, 'withOperatorBackfillClaim')
    await invoke()
    expect(recovery).toHaveBeenCalledTimes(1)
    const report = await recovery.mock.results[0]!.value
    expect(report).toMatchObject({unappliedBefore: 1, unappliedAfter: 1, applied: 0, [cause]: 1})
    expect(ui.confirm).not.toHaveBeenCalled()
    expect(ui.flip).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
    expect(await shared.db.getOptional<{properties_migration: string}>(
      'SELECT properties_migration FROM workspaces WHERE id = ?', [WS]))
      .toEqual({properties_migration: 'cell'})
  })
})
