// @vitest-environment happy-dom
// Uploads across an in-place conversion (docs/workspace-e2ee-conversion.md
// §6.2): the real §6 resolver decides, the real upload orchestrator acts.
import { CrudEntry, UpdateType, type AbstractPowerSyncDatabase, type CrudTransaction } from '@powersync/common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/supabase.js', () => ({
  supabase: {rpc: vi.fn(), from: vi.fn()},
  hasSupabaseAuthConfig: true,
}))

import {
  UploadHeldError,
  __encryptUploadOpsForTest,
  __uploadTransactionsWithFallbackForTest,
  type CompactedBlockOperation,
  type UploadDeps,
} from './powersync'
import { InMemoryWorkspaceKeyStore, type WorkspaceKeyRecord } from '@/sync/keys/keyStore'
import { mintWorkspaceKey } from '@/sync/keys/mintWorkspaceKey'
import { setModePin, upgradeModePinToE2ee } from '@/sync/keys/modePin'
import { createSyncResolver } from '@/sync/keys/resolver'
import { hasEnvelopePrefix } from '@/sync/crypto/envelope'
import { open } from '@/sync/crypto/aead'
import { contentAad } from '@/sync/crypto/aad'

const USER = 'user-1'
const WS = 'ws-converted'
const OTHER = 'ws-plain'

interface FakeTransaction {
  transactionId: number
  crud: CrudEntry[]
  completed: boolean
  complete: () => Promise<void>
}

const fakeTx = (transactionId: number, entries: CrudEntry[]): FakeTransaction => {
  const tx: FakeTransaction = {
    transactionId,
    crud: entries,
    completed: false,
    complete: async () => {
      tx.completed = true
    },
  }
  return tx
}

const fakeDb = {} as AbstractPowerSyncDatabase

let syncedMode: Map<string, string>
let keyStore: InMemoryWorkspaceKeyStore
let record: WorkspaceKeyRecord
let key: CryptoKey

const buildDeps = () => {
  const resolver = createSyncResolver(() => USER, keyStore, async ws => syncedMode.get(ws) ?? null)
  const applyOperations = vi.fn<UploadDeps['applyOperations']>().mockResolvedValue(undefined)
  const recordRejection = vi.fn<UploadDeps['recordRejection']>().mockResolvedValue(undefined)
  const deps: UploadDeps = {
    applyOperations,
    recordRejection,
    encryptOps: ops => __encryptUploadOpsForTest(ops, resolver.getUploadMode, resolver.getCek),
  }
  return {deps, applyOperations, recordRejection}
}

const contentEdit = (clientId: number, txId: number, workspaceId: string, content: string) =>
  new CrudEntry(clientId, UpdateType.PATCH, 'blocks', `block-${clientId}`, txId, {
    workspace_id: workspaceId,
    content,
  })

beforeEach(async () => {
  localStorage.clear()
  syncedMode = new Map([[WS, 'e2ee'], [OTHER, 'none']])
  keyStore = new InMemoryWorkspaceKeyStore()
  record = (await mintWorkspaceKey(WS)).record
  key = record.wk
  setModePin(USER, WS, 'plaintext')
  setModePin(USER, OTHER, 'plaintext')
})

describe('encryptUploadOps — held workspaces', () => {
  it('throws UploadHeldError naming the workspace rather than passing plaintext through', async () => {
    const op: CompactedBlockOperation = {kind: 'patch', id: 'b', order: 0, payload: {workspace_id: WS, content: 'x'}}
    const error = await __encryptUploadOpsForTest([op], () => 'hold', async () => null).catch(e => e)
    expect(error).toBeInstanceOf(UploadHeldError)
    expect((error as UploadHeldError).workspaceId).toBe(WS)
  })
})

describe('uploads for a workspace the server converted', () => {
  it('holds the write in the queue: nothing is sent, nothing is quarantined', async () => {
    const {deps, applyOperations, recordRejection} = buildDeps()
    const held = fakeTx(1, [contentEdit(1, 1, WS, 'secret')])

    await expect(
      __uploadTransactionsWithFallbackForTest(fakeDb, [held] as unknown as CrudTransaction[], deps),
    ).rejects.toBeInstanceOf(UploadHeldError)

    expect(applyOperations).not.toHaveBeenCalled()
    expect(recordRejection).not.toHaveBeenCalled()
    expect(held.completed).toBe(false)
  })

  it('holds even on the device that already holds the key (the converting device)', async () => {
    await keyStore.put(USER, WS, record)
    const {deps, applyOperations} = buildDeps()
    const held = fakeTx(1, [contentEdit(1, 1, WS, 'secret')])

    await expect(
      __uploadTransactionsWithFallbackForTest(fakeDb, [held] as unknown as CrudTransaction[], deps),
    ).rejects.toBeInstanceOf(UploadHeldError)
    // Sealed or not, nothing goes out before the purge: a write after the flip
    // that isn't a re-seal would make the purge refuse.
    expect(applyOperations).not.toHaveBeenCalled()
  })

  it('drains the queue up to the held write and stops there (FIFO is kept)', async () => {
    const {deps, applyOperations} = buildDeps()
    const before = fakeTx(1, [contentEdit(1, 1, OTHER, 'plain before')])
    const held = fakeTx(2, [contentEdit(2, 2, WS, 'secret')])
    const after = fakeTx(3, [contentEdit(3, 3, OTHER, 'plain after')])

    await expect(
      __uploadTransactionsWithFallbackForTest(
        fakeDb, [before, held, after] as unknown as CrudTransaction[], deps,
      ),
    ).rejects.toBeInstanceOf(UploadHeldError)

    expect(before.completed).toBe(true)
    expect(held.completed).toBe(false)
    expect(after.completed).toBe(false)
    const sent = applyOperations.mock.calls.flatMap(([, ops]) => ops)
    expect(sent.some(op => op.kind !== 'delete' && op.payload.content === 'secret')).toBe(false)
  })

  it('uploads the held write sealed once the pin is upgraded', async () => {
    const {deps, applyOperations} = buildDeps()
    const held = fakeTx(1, [contentEdit(1, 1, WS, 'secret')])
    await expect(
      __uploadTransactionsWithFallbackForTest(fakeDb, [held] as unknown as CrudTransaction[], deps),
    ).rejects.toBeInstanceOf(UploadHeldError)

    await keyStore.put(USER, WS, record)
    upgradeModePinToE2ee(USER, WS)
    await __uploadTransactionsWithFallbackForTest(fakeDb, [held] as unknown as CrudTransaction[], deps)

    expect(held.completed).toBe(true)
    const [op] = applyOperations.mock.calls.at(-1)![1]
    expect(op.kind).toBe('patch')
    const sealed = (op as Extract<CompactedBlockOperation, {kind: 'patch'}>).payload.content as string
    expect(hasEnvelopePrefix(sealed)).toBe(true)
  })

  // A device that wrote during the conversion window, before it learned the
  // workspace is e2ee, sent plaintext the server's ciphertext trigger refused, and
  // quarantined it to ps_crud_rejected. The System Status dialog's Retry inserts
  // the rejected envelope back into ps_crud verbatim; after the pin upgrade that
  // queued plaintext must go out SEALED.
  it('a quarantined edit retried after the upgrade uploads sealed', async () => {
    const rejectedEnvelope = JSON.stringify({
      op: 'PATCH',
      type: 'blocks',
      id: 'block-quarantined',
      data: {workspace_id: WS, content: 'written during the window', base_updated_at: 5},
    })
    await keyStore.put(USER, WS, record)
    upgradeModePinToE2ee(USER, WS)

    const {deps, applyOperations, recordRejection} = buildDeps()
    const retried = fakeTx(7, [CrudEntry.fromRow({id: '1', tx_id: 7, data: rejectedEnvelope})])
    await __uploadTransactionsWithFallbackForTest(fakeDb, [retried] as unknown as CrudTransaction[], deps)

    expect(recordRejection).not.toHaveBeenCalled()
    expect(retried.completed).toBe(true)
    const [op] = applyOperations.mock.calls[0][1] as Extract<CompactedBlockOperation, {kind: 'patch'}>[]
    expect(op.id).toBe('block-quarantined')
    expect(op.payload.base_updated_at).toBe(5)
    expect(await open(key, op.payload.content as string, contentAad(op.id, WS, 'content')))
      .toBe('written during the window')
  })
})
