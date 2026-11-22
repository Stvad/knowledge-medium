// @vitest-environment node
import {createHash} from 'node:crypto'
import {rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest'
import {base64} from '@scure/base'
import type {AddMediaResult, ReadMediaResult} from '@knowledge-medium/agent-cli/protocol'
import {createTestDb, resetTestDb} from '@/data/test/createTestDb'
import {stubLocalStorage} from '@/data/test/e2eeFixtures'
import type {BlockData} from '@/data/api'
import {clearSyncState, serverWorkspace, syncServer, testWorkspaceRow} from '@/data/test/syncCheckpoint'
import {readWorkspaceEncryptionMode} from '@/data/workspaceSchema'
import {BlobPutError, type BlobStore} from '@/plugins/attachments/blobStore'
import {UPLOAD_QUEUE_TABLE} from '@/plugins/attachments/uploadStore'
import {getWorkspaceKeyStore} from '@/sync/keys/keyStore'
import {mintWorkspaceKey} from '@/sync/keys/mintWorkspaceKey'
import {createSyncResolver} from '@/sync/keys/resolver'
import {computeContentHash} from '@/sync/crypto/contentHash'
import type {HeadlessConfig} from './config'
import {MEDIA_DIR, openHostMedia, type HostMediaRemote} from './media'
import {startHost} from './test/startHost'

const {rpc} = vi.hoisted(() => ({rpc: vi.fn(() => ({abortSignal: async () => ({error: null, status: 200})}))}))
vi.mock('@/services/supabase', async importOriginal => ({
  ...await importOriginal<typeof import('@/services/supabase')>(),
  supabase: {rpc},
}))

const workspaceId = 'scratch'
const user = {id: 'member', name: 'Test'}
const member = {type: 'workspace_members' as const, id: 'membership', data: {
  workspace_id: workspaceId, user_id: user.id, role: 'editor', create_time: 1,
}}
let fixture: Awaited<ReturnType<typeof createTestDb>>
beforeAll(async () => { fixture = await createTestDb() })
beforeEach(async () => {
  await clearSyncState(fixture.db)
  await resetTestDb(fixture.db)
  await fixture.db.execute(`DROP TABLE IF EXISTS ${UPLOAD_QUEUE_TABLE}`)
  stubLocalStorage()
  vi.stubGlobal('document', {querySelectorAll: () => [], baseURI: 'node:headless'})
  vi.spyOn(Object.getPrototypeOf(fixture.db.currentStatus), 'connected', 'get').mockReturnValue(true)
})
afterEach(async () => {
  await getWorkspaceKeyStore().delete(user.id, workspaceId)
  await rm(join(fixture.dir, MEDIA_DIR), {recursive: true, force: true})
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterAll(async () => { await fixture.cleanup() })

/** Storage: content-addressed, first write wins. `offline` fails every request transiently. */
class MemoryStorage implements BlobStore {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>()
  offline = false
  private reach() {
    if (this.offline) throw new BlobPutError('offline', false, undefined, 'network')
  }
  async put(ws: string, key: string, bytes: Uint8Array<ArrayBuffer>) {
    this.reach()
    if (this.objects.has(`${ws}/${key}`)) return 'exists' as const
    this.objects.set(`${ws}/${key}`, new Uint8Array(bytes))
    return 'written' as const
  }
  async get(ws: string, key: string) {
    this.reach()
    const object = this.objects.get(`${ws}/${key}`)
    if (!object) throw new Error('not found')
    return new Uint8Array(object)
  }
  async probe(ws: string, key: string) {
    this.reach()
    return this.objects.get(`${ws}/${key}`) ?? null
  }
  async delete(ws: string, key: string) {
    this.reach()
    this.objects.delete(`${ws}/${key}`)
  }
}

const IMAGE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])

async function encryptedHost(storage: MemoryStorage) {
  const key = await mintWorkspaceKey(workspaceId)
  const keyFile = join(fixture.dir, 'fixture-key')
  await writeFile(keyFile, key.displayed, {mode: 0o600})
  const config: HeadlessConfig = {mode: 'e2ee', keyFile, writable: true, workspaceId, profile: 'fixture', stateDir: fixture.dir}
  const deliver = syncServer(fixture.db)
  const rows = [
    serverWorkspace({...testWorkspaceRow(workspaceId), encryption_mode: 'e2ee', wk_canary: key.canary}),
    member,
  ]
  const media: HostMediaRemote = {
    blobStore: storage,
    readLiveWorkspace: async () => { throw new Error('An encrypted upload needs no live mode read') },
  }
  const start = () => {
    const host = startHost(fixture.db, config, user, {connect: () => deliver(rows), media})
    return {
      ...host,
      health: async () => (await host.execute({type: 'health'}) as {host: Record<string, unknown>}).host,
      writable: () => vi.waitFor(async () => {
        expect(await host.execute({type: 'health'})).toMatchObject({host: {readOnly: false, closedReason: null}})
      }, {timeout: 25_000}),
    }
  }
  return {start}
}

const addImage = (execute: ReturnType<typeof startHost>['execute']) => execute({
  type: 'add-media', base64: base64.encode(IMAGE), filename: 'dot.png', mime: 'image/png', contributorId: null,
}) as Promise<AddMediaResult>

// A writable encrypted boot with its workspace bootstrap took 13.7 s in the focused run.
it('uploads an attachment sealed, and reads it back from Storage once this device has no copy', async () => {
  const storage = new MemoryStorage()
  const host = (await encryptedHost(storage)).start()
  try {
    await host.writable()
    const added = await addImage(host.execute)
    await vi.waitFor(() => expect(storage.objects.size).toBe(1))
    expect(await host.health()).toMatchObject({mediaUploads: {staged: 0, pending: 0, failed: 0}})

    const [[path, object]] = storage.objects
    const plaintextHash = createHash('sha256').update(IMAGE).digest('hex')
    expect(path.startsWith(`${workspaceId}/`)).toBe(true)
    expect(path).not.toContain(plaintextHash)
    expect(Buffer.from(object).includes(Buffer.from(IMAGE.subarray(8)))).toBe(false)

    const read = () => host.execute({type: 'read-media', ref: added.id}) as Promise<ReadMediaResult>
    expect(await read()).toMatchObject({id: added.id, mime: 'image/png', filename: 'dot.png', base64: base64.encode(IMAGE)})
    await rm(join(fixture.dir, MEDIA_DIR), {recursive: true, force: true})
    expect((await read()).base64).toBe(base64.encode(IMAGE))
  } finally {
    await host.stop()
  }
}, 60_000)

// A writable encrypted boot over an already-seeded workspace took 2.2 s in the focused run.
it('keeps an upload that could not reach Storage for the next process, which sends it when it starts', async () => {
  const storage = new MemoryStorage()
  storage.offline = true
  const first = (await encryptedHost(storage)).start()
  let added: AddMediaResult
  try {
    await first.writable()
    added = await addImage(first.execute)
    expect(await first.health()).toMatchObject({mediaUploads: {staged: 0, pending: 1, failed: 0}})
  } finally {
    await first.stop()
  }
  expect(storage.objects.size).toBe(0)

  // What the next process builds over the same state directory and database.
  storage.offline = false
  const keys = createSyncResolver(() => user.id, getWorkspaceKeyStore(), id => readWorkspaceEncryptionMode(fixture.db, id))
  const next = openHostMedia(fixture.db, fixture.dir, user.id, true, keys, {blobStore: storage, readLiveWorkspace: async () => {
    throw new Error('An encrypted upload needs no live mode read')
  }})
  next.start({load: async id => await fixture.db.getOptional<BlockData>('SELECT * FROM blocks WHERE id = ?', [id])})
  await vi.waitFor(() => expect(storage.objects.size).toBe(1))
  await next.stop()
  expect(await next.health()).toEqual({staged: 0, pending: 0, failed: 0})
  expect(await fixture.db.getOptional('SELECT 1 FROM blocks WHERE id = ?', [added.id])).not.toBeNull()
  expect(await next.agent.resolve({workspaceId, contentHash: await computeContentHash(IMAGE)}))
    .toMatchObject({ok: true, bytes: IMAGE})
}, 30_000)
