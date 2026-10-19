// @vitest-environment happy-dom
// A workspace converted in place, seen by a device whose pin still says
// plaintext (docs/workspace-e2ee-conversion.md §6.2): the real §6 resolver, the
// real synced `workspaces` row, and the real observer.
import { beforeEach, describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { InMemoryWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin, upgradeModePinToE2ee } from '@/sync/keys/modePin'
import { createSyncResolver } from '@/sync/keys/resolver'
import { generateWorkspaceKeyBytes, importWorkspaceKey } from '@/sync/crypto/workspaceKey'
import { encodeForWire } from '@/sync/transform'
import { setupObserverTestDb, stagingCiphertextParams } from './test/harness.js'

const USER = 'user-1'
const WS = 'ws-converted'

const { env, start, seedLocalBlock, stageRow, allBlocks } = setupObserverTestDb()

const block = (over: Partial<BlockData> = {}): BlockData => ({
  id: 'b1',
  workspaceId: WS,
  parentId: null,
  orderKey: 'a0',
  content: 'pre-conversion text',
  properties: {},
  references: [],
  createdAt: 1000,
  updatedAt: 1000,
  userUpdatedAt: 1000,
  createdBy: USER,
  updatedBy: USER,
  deleted: false,
  ...over,
})

let keyStore: InMemoryWorkspaceKeyStore
let key: CryptoKey

beforeEach(async () => {
  localStorage.clear()
  keyStore = new InMemoryWorkspaceKeyStore()
  key = await importWorkspaceKey(generateWorkspaceKeyBytes())
  setModePin(USER, WS, 'plaintext')
  await env.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode)
     VALUES (?, 'ws', ?, 1, 1, 'none')`,
    [WS, USER],
  )
})

const resolver = () =>
  createSyncResolver(() => USER, keyStore, ws => readWorkspaceEncryptionMode(env.db, ws))

/** The re-seal of `plain`: same plaintext, sealed, at a later version. */
const stageResealed = async (plain: BlockData) => {
  const wire = await encodeForWire({
    id: plain.id,
    workspace_id: plain.workspaceId,
    content: plain.content,
    properties_json: JSON.stringify(plain.properties),
    references_json: JSON.stringify(plain.references),
  }, 'e2ee', async () => key)
  await stageRow(plain, stagingCiphertextParams(plain, wire))
}

describe('materialization across an in-place conversion', () => {
  it('defers the re-sealed rows, so local blocks keep their plaintext, and decrypts them after the upgrade', async () => {
    const before = block()
    await seedLocalBlock(before)
    const r = resolver()
    const {observer} = start({getMaterializability: r.getMaterializability, getCek: r.getCek})

    // The flip and the re-seal arrive in one checkpoint: the row first.
    await env.db.execute(`UPDATE workspaces SET encryption_mode = 'e2ee' WHERE id = ?`, [WS])
    const resealed = block({updatedAt: 2000})
    await stageResealed(resealed)
    await observer.flush()

    expect(await allBlocks()).toEqual([
      expect.objectContaining({id: 'b1', content: 'pre-conversion text', updated_at: 1000}),
    ])

    await keyStore.put(USER, WS, {wk: key, contentKeyHmac: null})
    upgradeModePinToE2ee(USER, WS)
    await observer.drainWorkspace(WS, 'all')

    expect(await allBlocks()).toEqual([
      expect.objectContaining({id: 'b1', content: 'pre-conversion text', updated_at: 2000}),
    ])
  })

  it('a plaintext workspace the server did not convert copies as before', async () => {
    const r = resolver()
    const {observer} = start({getMaterializability: r.getMaterializability, getCek: r.getCek})
    await stageRow(block({content: 'plain arrival'}))
    await observer.flush()
    expect(await allBlocks()).toEqual([expect.objectContaining({content: 'plain arrival'})])
  })
})
