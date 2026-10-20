/**
 * The attachment cleaner's Storage adapter against a real stack: Supabase's
 * Postgres image, GoTrue and the Storage API, which `pnpm check:db` starts
 * with the attachments bucket and its policies migrated in. The unit tests run
 * the adapter against a faked storage-js; this one shows what Storage's
 * listing, RLS and single-object delete do with the adapter's requests, and
 * runs the cleaner end to end.
 *
 * `pnpm test` skips it. `pnpm check:db --hold` keeps a stack up to run it alone.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo'
import { verifyObjectBytes } from '@/sync/byteTransform'
import { BINARY_ENVELOPE_OVERHEAD_BYTES } from '@/sync/crypto/binaryEnvelope'
import { mintCanary } from '@/sync/crypto/canary'
import { computeContentHash } from '@/sync/crypto/contentHash'
import { deriveContentKey, deriveContentKeyHmac } from '@/sync/crypto/contentKey'
import { importWorkspaceKey } from '@/sync/crypto/workspaceKey'
import { cleanAttachments, type MediaRef } from '@/sync/conversion/attachmentCleaner'
import { signedInUser, stackClient, supabaseStack, type StackUser } from '@/test/supabaseStack'
import { createAttachmentCleanerIO, listWorkspaceObjects } from './attachmentCleanerIO.js'
import { ATTACHMENTS_BUCKET, createSupabaseBlobStore, type BlobStore } from './blobStore.js'
import { InMemoryByteStore } from './byteStore.js'

const bytes = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
const randomObject = (size: number) => new Uint8Array(randomBytes(size)) as Uint8Array<ArrayBuffer>
const rawNameOf = async (body: Uint8Array<ArrayBuffer>) => (await computeContentHash(body)).slice('sha256:'.length)

// The end-to-end test takes 1–3 s against a fresh stack; the 413 one, which
// uploads ~100 MiB, has its own budget.
describe('the attachment cleaner over real Storage', {timeout: 30_000}, () => {
  const stack = supabaseStack()
  /** RLS doesn't filter it: plants what only a write from outside the app makes. */
  const admin = stackClient(stack, stack.serviceKey)
  let db: pg.Client
  let owner: StackUser
  let viewer: StackUser
  let outsider: StackUser

  beforeAll(async () => {
    db = new pg.Client({connectionString: stack.databaseUrl})
    await db.connect()
    ;[owner, viewer, outsider] = await Promise.all([signedInUser(stack), signedInUser(stack), signedInUser(stack)])
  })
  afterAll(() => db?.end())
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const query = async <Row extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await db.query<Row>(sql, params)).rows

  /** A workspace `owner` owns and `viewer` can only read. */
  const insertWorkspace = async ({ws = randomUUID(), e2ee}: {ws?: string; e2ee?: {canary: string}} = {}) => {
    const at = Date.now() - 60_000
    await query(
      `insert into public.workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary)
       values ($1, 'attachments', $2, $3, $3, $4, $5)`,
      [ws, owner.id, at, e2ee ? 'e2ee' : 'none', e2ee?.canary ?? null],
    )
    for (const [user, role] of [[owner, 'owner'], [viewer, 'viewer']] as const) {
      await query(
        `insert into public.workspace_members (id, workspace_id, user_id, role, create_time)
         values (gen_random_uuid()::text, $1, $2, $3, $4)`,
        [ws, user.id, role, at],
      )
    }
    return ws
  }

  /** What the folder holds, relative to it, read past RLS. */
  const storedNames = async (ws: string): Promise<string[]> =>
    (await query<{name: string}>(
      `select name from storage.objects where bucket_id = $1 and starts_with(name, $2 || '/')`,
      [ATTACHMENTS_BUCKET, ws],
    )).map(row => row.name.slice(ws.length + 1)).sort()

  const plant = async (ws: string, path: string, body: Uint8Array<ArrayBuffer> = bytes(path)) => {
    const {error} = await admin.storage.from(ATTACHMENTS_BUCKET).upload(`${ws}/${path}`, body, {upsert: false})
    if (error) throw error
  }

  const blobStoreOf = (user: StackUser): BlobStore =>
    createSupabaseBlobStore({
      client: user.client,
      getAccessToken: async () => (await user.client.auth.getSession()).data.session?.access_token ?? null,
    })

  const list = (user: StackUser, ws: string, userId = user.id) =>
    listWorkspaceObjects({client: user.client, userId, workspaceId: ws, isRemoteSyncActive: () => true})

  describe('listWorkspaceObjects', () => {
    let ws: string
    beforeAll(async () => {
      ws = await insertWorkspace()
      // More flat objects than one page. A listing reads only these rows, so
      // they go in directly, with no bytes behind them.
      await query(
        `insert into storage.objects (bucket_id, name)
         select $1, $2 || '/' || encode(sha256(n::text::bytea), 'hex') from generate_series(1, 1005) as n`,
        [ATTACHMENTS_BUCKET, ws],
      )
      // Nested folders, two that differ only in case, and two that one
      // character of LIKE-wildcard would merge.
      for (const path of ['sub/a', 'sub/deeper/b', 'Dir/x', 'dir/x', 'dir/y', 'a_b/z', 'axb/w']) await plant(ws, path)
    })

    it('lists every object of the folder by its exact name, past a page and through nested folders', async () => {
      const stored = await storedNames(ws)
      expect(stored).toHaveLength(1005 + 7)
      expect(await list(owner, ws)).toEqual(stored)
    })

    it('lists under the token of the session it checked, not one the client holds by the request', async () => {
      const ownerSession = (await owner.client.auth.getSession()).data.session
      // The adapter's check sees the owner's session; the client's own token is the outsider's.
      vi.spyOn(outsider.client.auth, 'getSession').mockResolvedValueOnce({data: {session: ownerSession!}, error: null})
      expect(await list(outsider, ws, owner.id)).toEqual(await storedNames(ws))
    })

    it('another account, or none, reads the folder as empty, so the adapter refuses either', async () => {
      // The premise: RLS filters a listing rather than refusing it.
      const anon = stackClient(stack)
      for (const client of [outsider.client, anon]) {
        expect(await client.storage.from(ATTACHMENTS_BUCKET).listV2({prefix: `${ws}/`})).toMatchObject({
          data: {objects: [], folders: []},
          error: null,
        })
      }
      await expect(list(outsider, ws, owner.id)).rejects.toThrow(/session/)
      await expect(
        listWorkspaceObjects({client: anon, userId: owner.id, workspaceId: ws, isRemoteSyncActive: () => true}),
      ).rejects.toThrow(/session/)
    })
  })

  describe("the blob store's single-object delete", () => {
    it('deletes the object for a writer, and refuses a reader, an outsider, and an absent object', async () => {
      const ws = await insertWorkspace()
      const name = await rawNameOf(bytes('a photo'))
      expect(await blobStoreOf(owner).put(ws, name, bytes('a photo'))).toBe('written')

      for (const user of [viewer, outsider]) {
        await expect(blobStoreOf(user).delete(ws, name)).rejects.toThrow(/blob delete failed \(\d+ AccessDenied\)/)
      }
      expect(await storedNames(ws)).toEqual([name])

      await blobStoreOf(owner).delete(ws, name)
      expect(await storedNames(ws)).toEqual([])
      expect(await blobStoreOf(owner).probe(ws, name)).toBeNull()
      await expect(blobStoreOf(owner).delete(ws, name)).rejects.toThrow(/blob delete failed \(\d+ NoSuchKey\)/)
    })

    it('deletes a nested object by its path', async () => {
      const ws = await insertWorkspace()
      await plant(ws, 'outside/deeper/note')
      await plant(ws, 'outside/kept')
      await blobStoreOf(owner).delete(ws, 'outside/deeper/note')
      expect(await storedNames(ws)).toEqual(['outside/kept'])
    })
  })

  describe('cleanAttachments', () => {
    /** An e2ee workspace, its keys and its canary. */
    const e2eeWorkspace = async () => {
      const wk = new Uint8Array(randomBytes(32)) as Uint8Array<ArrayBuffer>
      const cek = await importWorkspaceKey(wk)
      const contentKeyHmac = await deriveContentKeyHmac(wk)
      const ws = randomUUID()
      const canary = await mintCanary(cek, ws)
      await insertWorkspace({ws, e2ee: {canary}})
      return {ws, keys: {cek, contentKeyHmac}, canary}
    }

    const ioFor = (ws: string, media: readonly MediaRef[]) => ({
      ...createAttachmentCleanerIO({
        client: owner.client,
        blobStore: blobStoreOf(owner),
        byteStore: new InMemoryByteStore(),
        // Read only by `mediaBlocks`, which is given here instead.
        repo: {} as Repo,
        userId: owner.id,
        workspaceId: ws,
        isRemoteSyncActive: () => true,
      }),
      mediaBlocks: async () => media,
    })

    it("converts a raw object an older client uploaded: its keyed copy verified, the raw object deleted, the proof passed", async () => {
      const {ws, keys, canary} = await e2eeWorkspace()
      const photo = randomObject(300_000)
      const contentHash = await computeContentHash(photo)
      const rawName = await rawNameOf(photo)
      const keyedName = await deriveContentKey({contentHash, mode: 'e2ee', contentKeyHmac: keys.contentKeyHmac})
      expect(await blobStoreOf(owner).put(ws, rawName, photo)).toBe('written')
      await plant(ws, 'outside/note')
      const io = ioFor(ws, [{blockId: 'block-1', contentHash}])

      expect(await cleanAttachments({workspaceId: ws, io, keys, canary, bundle: null})).toEqual({
        converted: [rawName],
        refused: [],
        deleted: [],
        left: [{path: 'outside/note', reason: 'not-archived'}],
        rebuilt: [],
        errors: [],
        proof: {kind: 'passed', unrecoverable: []},
      })
      expect(await storedNames(ws)).toEqual([keyedName, 'outside/note'].sort())
      const {data: sealed} = await admin.storage.from(ATTACHMENTS_BUCKET).download(`${ws}/${keyedName}`)
      const verified = await verifyObjectBytes(new Uint8Array(await sealed!.arrayBuffer()), 'e2ee', async () => keys.cek, {
        contentHash,
        workspaceId: ws,
      })
      expect(verified).toEqual({ok: true, plaintext: photo})

      // Running it again finds nothing to do and proves the same.
      expect(await cleanAttachments({workspaceId: ws, io, keys, canary, bundle: null})).toMatchObject({
        converted: [],
        errors: [],
        proof: {kind: 'passed', unrecoverable: []},
      })
      expect(await storedNames(ws)).toEqual([keyedName, 'outside/note'].sort())
    })

    it("keeps a raw object whose sealed copy is one byte over the bucket's limit, reporting Storage's 413", async () => {
      const {ws, keys, canary} = await e2eeWorkspace()
      const [{file_size_limit: limit}] = await query<{file_size_limit: string}>(
        'select file_size_limit from storage.buckets where id = $1',
        [ATTACHMENTS_BUCKET],
      )
      const tooBig = randomObject(Number(limit) - BINARY_ENVELOPE_OVERHEAD_BYTES + 1)
      const contentHash = await computeContentHash(tooBig)
      const rawName = await rawNameOf(tooBig)
      expect(await blobStoreOf(owner).put(ws, rawName, tooBig)).toBe('written')

      const report = await cleanAttachments({workspaceId: ws, io: ioFor(ws, [{blockId: 'block-1', contentHash}]), keys, canary, bundle: null})
      expect(report).toMatchObject({
        converted: [],
        refused: [{path: rawName, status: 413, sealedBytes: Number(limit) + 1}],
        errors: [],
        proof: {kind: 'not-passed', rawRemaining: [rawName], unverified: [contentHash], unsettled: false},
      })
      expect(await storedNames(ws)).toEqual([rawName])
    }, 60_000)
  })
})
