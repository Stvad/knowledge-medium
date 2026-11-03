/**
 * The conversion flow end to end against a real stack: Supabase's Postgres
 * image, GoTrue, PostgREST and Storage, which `pnpm check:db` starts. The run
 * is the app's own composition (`conversionFlowDeps`) over a real local
 * database, with the attachments plugin's Storage adapter, and this device's
 * own writes go up through the app's upload path and mode resolver. Only what
 * a browser provides is test-side: the bundle folder (a directory on disk),
 * the key store and the bundle record store (in memory, outliving each run as
 * IndexedDB does), and localStorage. The run lock is `navigator.locks`, which
 * node has.
 *
 * The unit tests run the flow against in-memory servers; this one shows what
 * the RPCs, PostgREST's pages, the history trigger and Storage make of it,
 * and what this device's UI-state writes do to it while it runs.
 *
 * `pnpm test` skips it. `pnpm check:db --hold` keeps a stack up to run it alone.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { conversionFlowDeps, type ConversionPlatform } from '@/components/workspace/conversion/conversionFlowDeps'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { stubLocalStorage } from '@/data/test/e2eeFixtures'
import { readWorkspaceEncryptionMode } from '@/data/workspaceSchema'
import { createAttachmentCleanerIO } from '@/plugins/attachments/attachmentCleanerIO'
import { ATTACHMENTS_BUCKET, createSupabaseBlobStore } from '@/plugins/attachments/blobStore'
import { InMemoryByteStore } from '@/plugins/attachments/byteStore'
import { mediaHashOfStoredRow } from '@/plugins/attachments/mediaBlock'
import { InMemoryByteUploadStore } from '@/plugins/attachments/uploadStore'
import { createPowerSyncConnector, UploadHeldError } from '@/services/powersync'
import { verifyObjectBytes } from '@/sync/byteTransform'
import { validateCanary } from '@/sync/crypto/canary'
import { computeContentHash } from '@/sync/crypto/contentHash'
import { deriveContentKey } from '@/sync/crypto/contentKey'
import { InMemoryWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { getModePin, setModePin, type ModePin } from '@/sync/keys/modePin'
import { createSyncResolver } from '@/sync/keys/resolver'
import { connectStackDb, signedInUser, stackClient, supabaseStack, type StackDb, type StackTap, type StackUser } from '@/test/supabaseStack'
import { abortableSleep } from '@/utils/abortableSleep'
import { SEALED_COLUMNS } from '../transform.js'
import { rawNameOf } from './bundle/attachmentParts.js'
import type { BundleFolder } from './bundle/bundleParts.js'
import { InMemoryBundleRecordStore } from './bundle/bundleRecord.js'
import { BUNDLE_PARTS } from './bundle/manifest.js'
import { BundleInvalid, verifyBundle } from './bundle/verifyBundle.js'
import type { SavedKeyPrompt, SaveKeyPrompt } from './conversionKey.js'
import { ConversionErrorCode, type ContentColumns } from './conversionServer.js'
import type { FinishPrompt } from './cleaningStage.js'
import type { PreflightReport } from './preflight.js'
import { webConversionLock } from './runLock.js'
import { runConversion, type ActiveStage, type ConversionRunResult, type ConversionStatus, type ConversionUi } from './runConversion.js'
import type { BundleRetakeReason, ReopenBundlePrompt } from './sealingStage.js'
import { contentColumnsOf, isSealedValue, RESEAL_PAGE_SIZE } from './sealing.js'
import { mediaPropertiesJson, openRow } from './test/conversionFixtures.js'
import { FAKE_LOCAL_DB, writeFakeLocalDb } from './test/flowFixtures.js'
import { FsBundleFolder } from './test/fsBundleFolder.js'

/** The app's global client is the owner's: the stage read, the pin upgrade's
 *  server check and the upload path all take it from there. */
const app = vi.hoisted(() => ({client: null as SupabaseClient | null}))
vi.mock('@/services/supabase', async importOriginal => ({
  ...(await importOriginal<typeof import('@/services/supabase')>()),
  get supabase() {
    return app.client
  },
}))

/** More rows than one re-seal page, and so than one PostgREST page (`max_rows` 150). */
const ROWS = RESEAL_PAGE_SIZE + 30

const BLOCK_COLUMNS =
  'id, workspace_id, parent_id, order_key, content, properties_json, references_json, ' +
  'created_at, updated_at, user_updated_at, created_by, updated_by, deleted'

const bytesOf = (size: number) => new Uint8Array(randomBytes(size)) as Uint8Array<ArrayBuffer>

/** A request's path under its API: `rpc/<name>`, or a table. */
const endpointOf = (url: URL): string => url.pathname.replace(/^\/(rest|storage)\/v1\//, '')

/** The SQLSTATE of a PostgREST error response. */
const errorCode = async (response: Response): Promise<string> => (await response.clone().json()).code

// Measured alone against a fresh stack: 0.7–3 s a test, the slowest the crash
// chain and the lost purge's response (2 s of it the purge's real retry wait).
describe('the conversion flow against the real stack', {timeout: 30_000}, () => {
  const stack = supabaseStack()
  /** RLS doesn't filter it: plants what an older client or an operator left. */
  const admin = stackClient(stack, stack.serviceKey)
  let db: StackDb
  let owner: StackUser
  let testDb: TestDb
  /** What the owner's requests pass through on their way to the stack. */
  let tap: StackTap | null = null
  const tempDirs: string[] = []

  beforeAll(async () => {
    db = await connectStackDb(stack)
    owner = await signedInUser(stack, (url, init, send) => (tap ? tap(url, init, send) : send()))
    app.client = owner.client
    testDb = await createTestDb()
  })
  afterAll(async () => {
    await db?.end()
    await testDb?.cleanup()
    await Promise.all(tempDirs.map(dir => rm(dir, {recursive: true, force: true})))
  })
  beforeEach(async () => {
    await resetTestDb(testDb.db)
    stubLocalStorage()
  })
  afterEach(() => {
    tap = null
    vi.unstubAllGlobals()
  })

  const query: StackDb['query'] = (sql, params) => db.query(sql, params)

  const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'km-conversion-'))
    tempDirs.push(dir)
    return dir
  }

  // ── the server ──

  type Attachment = readonly [contentHash: string, bytes: Uint8Array<ArrayBuffer>]

  interface Seeded {
    readonly ws: string
    /** Each seeded row's content columns, by id. */
    readonly plaintext: ReadonlyMap<string, ContentColumns>
    /** Media blocks' bytes, by where they are; null without attachments. */
    readonly media: {readonly inStorage: Attachment; readonly onDeviceOnly: Attachment; readonly deleted: Attachment} | null
    /** A raw Storage object no media block names. */
    readonly orphan: Attachment | null
  }

  const plant = async (ws: string, path: string, body: Uint8Array<ArrayBuffer>) => {
    const {error} = await admin.storage.from(ATTACHMENTS_BUCKET).upload(`${ws}/${path}`, body, {upsert: false})
    if (error) throw error
  }

  const contentOf = async (ws: string): Promise<Map<string, ContentColumns>> =>
    new Map(
      (await query<ContentColumns & {id: string}>(
        'select id, content, properties_json, references_json from public.blocks where workspace_id = $1',
        [ws],
      )).map(row => [row.id, contentColumnsOf(row)]),
    )

  /** A plaintext workspace the owner owns, with history; with `attachments`,
   *  media blocks and Storage objects of every kind the cleaner meets. */
  const seedWorkspace = async ({attachments = false}: {attachments?: boolean} = {}): Promise<Seeded> => {
    const ws = randomUUID()
    // A minute back, so the clamp trigger leaves the seeded versions alone.
    const at = Date.now() - 60_000
    await db.insertWorkspace({id: ws, name: 'conversion', at, members: [[owner.id, 'owner']]})
    // Text JSON has to escape, outside the BMP; every 50th row soft-deleted.
    await query(
      `insert into public.blocks (${BLOCK_COLUMNS})
       select gen_random_uuid()::text, $1, null, 'a' || n, 'note ' || n || ' · ünïcödé ✓ 😀 \\ " ' || chr(9),
              json_build_object('n', n)::text, json_build_array('ref-' || n)::text, $2, $2, $2, $3, $3, n % 50 = 0
       from generate_series(1, $4::int) as n`,
      [ws, at, owner.id, ROWS],
    )
    // Edits, so history holds updates as well as inserts.
    await query(
      `update public.blocks set content = content || ' (edited)'
       where id in (select id from public.blocks where workspace_id = $1 order by id limit 20)`,
      [ws],
    )

    if (!attachments) return {ws, plaintext: await contentOf(ws), media: null, orphan: null}

    const attachment = async (size: number): Promise<Attachment> => {
      const bytes = bytesOf(size)
      return [await computeContentHash(bytes), bytes]
    }
    const media = {inStorage: await attachment(4_000), onDeviceOnly: await attachment(4_001), deleted: await attachment(4_002)}
    for (const [hash] of Object.values(media)) {
      await query(
        `insert into public.blocks (${BLOCK_COLUMNS})
         values (gen_random_uuid()::text, $1, null, 'm', 'a photo', $2, '[]', $3, $3, $3, $4, $4, $5)`,
        [ws, mediaPropertiesJson(hash), at, owner.id, hash === media.deleted[0]],
      )
    }
    const orphan = await attachment(3_000)
    for (const [hash, bytes] of [media.inStorage, media.deleted, orphan]) await plant(ws, rawNameOf(hash), bytes)
    // An object no app would write: the bundle archives it, and the cleaner deletes it.
    await plant(ws, 'notes/readme.txt', new TextEncoder().encode('left by hand') as Uint8Array<ArrayBuffer>)
    return {ws, plaintext: await contentOf(ws), media, orphan}
  }

  const serverWorkspace = async (ws: string) =>
    (await query<{encryption_mode: string; wk_canary: string | null; phase: string | null}>(
      `select w.encryption_mode, w.wk_canary, c.phase
       from public.workspaces w left join public.workspace_conversions c on c.workspace_id = w.id where w.id = $1`,
      [ws],
    ))[0]

  const sealedRowCount = async (ws: string): Promise<number> =>
    (await query<{count: number}>(
      `select count(*) from public.blocks
       where workspace_id = $1 and public.is_sealed_block(content, properties_json, references_json)`,
      [ws],
    ))[0].count

  const storedObjects = async (ws: string): Promise<string[]> =>
    (await query<{name: string}>(
      `select name from storage.objects where bucket_id = $1 and starts_with(name, $2 || '/')`,
      [ATTACHMENTS_BUCKET, ws],
    )).map(row => row.name.slice(ws.length + 1)).sort()

  // ── this device ──

  interface UiWrite {
    /** This device's synced copy of the workspace's mode, and its pin, as it wrote. */
    readonly localMode: string | null
    readonly pin: ModePin | null
    readonly upload: 'uploaded' | 'held'
  }

  interface Device {
    readonly ws: string
    readonly keyStore: InMemoryWorkspaceKeyStore
    readonly bundles: InMemoryBundleRecordStore
    /** The folder the user picks for every new bundle. */
    readonly picked: FsBundleFolder
    /** One pass of the app's upload path over this device's queue: what it did. */
    upload(): Promise<UiWrite['upload']>
    /** From now on, before each request the run sends, this device makes a
     *  UI-state write and runs its upload pass, as the app does all the time. */
    keepWriting(): void
    readonly uiWrites: UiWrite[]
    /** This page may read `folder` and what it holds, until the next run. */
    grant(folder: BundleFolder): void
    /** One page load's run: the grants of the last one are gone. */
    run(ui: ScriptedUi, signal?: AbortSignal): Promise<ConversionRunResult>
  }

  /** This device, plaintext-pinned to `ws`, holding its own copy of the media
   *  the server holds no object for. */
  const deviceFor = async ({ws, media}: Seeded): Promise<Device> => {
    const {repo} = createTestRepo({db: testDb.db, user: {id: owner.id}, now: Date.now, newId: randomUUID})
    repo.setActiveWorkspaceId(ws)
    await testDb.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time, encryption_mode)
       VALUES (?, 'conversion', ?, 1, 1, 'none')`,
      [ws, owner.id],
    )
    setModePin(owner.id, ws, 'plaintext')
    const keyStore = new InMemoryWorkspaceKeyStore()
    const bundles = new InMemoryBundleRecordStore()
    const byteStore = new InMemoryByteStore()
    if (media) await byteStore.put(owner.id, ws, rawNameOf(media.onDeviceOnly[0]), media.onDeviceOnly[1])

    const resolver = createSyncResolver(() => owner.id, keyStore, id => readWorkspaceEncryptionMode(testDb.db, id))
    const connector = createPowerSyncConnector({encryption: {getWorkspaceMode: resolver.getUploadMode, getCek: resolver.getCek}})
    const attachments = createAttachmentCleanerIO({
      client: owner.client,
      blobStore: createSupabaseBlobStore({
        client: owner.client,
        getAccessToken: async () => (await owner.client.auth.getSession()).data.session?.access_token ?? null,
      }),
      byteStore,
      uploadStore: new InMemoryByteUploadStore(),
      repo,
      userId: owner.id,
      workspaceId: ws,
      isRemoteSyncActive: () => true,
    })
    // Chromium keeps a folder's grant for the page's lifetime, so a handle
    // restored after a reload asks again; a moved folder keeps it and fails
    // on read.
    const granted = new Set<string>()
    const platform: ConversionPlatform = {
      keyStore,
      bundles,
      canReadFolder: async folder => {
        const {path} = folder as FsBundleFolder
        return [...granted].some(root => path === root || path.startsWith(root + sep))
      },
      writeLocalDb: folder => writeFakeLocalDb(folder),
      keepAwake: async () => () => {},
      environment: {
        keyStoreIsDurable: true,
        supportsDirectoryPicker: true,
        localDbBytes: async () => FAKE_LOCAL_DB.length,
        freeLocalBytes: async () => null,
      },
    }
    const lock = webConversionLock()
    if (!lock) throw new Error('this node has no navigator.locks')

    let uploading = false
    const upload = async (): Promise<UiWrite['upload']> => {
      uploading = true
      try {
        await connector.uploadData(testDb.db)
        return 'uploaded'
      } catch (error) {
        if (error instanceof UploadHeldError) return 'held'
        throw error
      } finally {
        uploading = false
      }
    }
    const uiBlocks: string[] = []
    const uiWrites: UiWrite[] = []
    /** A new panel, and an edit to the last one: a create and a patch. */
    const writeUiState = async () => {
      const id = randomUUID()
      const last = uiBlocks.at(-1)
      uiBlocks.push(id)
      await repo.tx(async tx => {
        await tx.create({id, workspaceId: ws, parentId: null, orderKey: `u${uiBlocks.length}`, content: `panel ${uiBlocks.length}`})
        if (last) await tx.update(last, {content: `panel ${uiBlocks.length - 1}, moved`})
      }, {scope: ChangeScope.UiState, description: 'ui state'})
    }

    return {
      ws,
      keyStore,
      bundles,
      picked: new FsBundleFolder(await tempDir()),
      upload,
      keepWriting() {
        tap = (async (_url, _init, send) => {
          // Not for this device's own upload pass, whose requests come through here too.
          if (!uploading) {
            const localMode = await readWorkspaceEncryptionMode(testDb.db, ws)
            const pin = getModePin(owner.id, ws)
            await writeUiState()
            uiWrites.push({localMode, pin, upload: await upload()})
          }
          return send()
        })
      },
      uiWrites,
      grant: folder => void granted.add((folder as FsBundleFolder).path),
      run: (ui, signal = new AbortController().signal) => {
        granted.clear()
        return runConversion(conversionFlowDeps({repo, workspaceId: ws, client: owner.client, lock, attachments, platform, ui, signal}))
      },
    }
  }

  const localQueue = () =>
    testDb.db.get<{pending: number; rejected: number}>(
      'SELECT (SELECT COUNT(*) FROM ps_crud) AS pending, (SELECT COUNT(*) FROM ps_crud_rejected) AS rejected',
    )

  /** This device's UI-state blocks, as the user last left them. */
  const localUiState = async (ws: string): Promise<Map<string, string>> =>
    new Map(
      (await testDb.db.getAll<{id: string; content: string}>(
        `SELECT id, content FROM blocks WHERE workspace_id = ? AND content LIKE 'panel %'`,
        [ws],
      )).map(row => [row.id, row.content]),
    )

  /** The bundle folders this device's runs left, oldest first. */
  const bundleFoldersOf = (device: Device): FsBundleFolder[] =>
    readdirSync(device.picked.path)
      .filter(name => !name.startsWith('.'))
      .sort()
      .map(name => new FsBundleFolder(join(device.picked.path, name)))

  // ── the user ──

  /** A user who answers every prompt as told, and remembers what was asked. */
  class ScriptedUi implements ConversionUi {
    readonly statuses: ConversionStatus[] = []
    readonly contracts: ActiveStage['kind'][] = []
    readonly preflights: PreflightReport[] = []
    readonly bundleReasons: Array<BundleRetakeReason | null> = []
    readonly reopens: ReopenBundlePrompt[] = []
    readonly savedKeyPrompts: SavedKeyPrompt[] = []
    readonly finishes: FinishPrompt[] = []
    /** Runs at each status: may change the world, or throw to stand for a crash. */
    onStatus: (status: ConversionStatus) => void = () => {}
    /** By default the user grants access to the folder the run recorded. */
    reopen: (prompt: ReopenBundlePrompt) => Promise<BundleFolder | null> = async prompt => prompt.recorded

    /** `savedKey`: the key the user saved from an earlier run's reveal. */
    constructor(private readonly device: Device, public savedKey: string | null = null) {}

    async confirmContract(stage: ActiveStage) {
      this.contracts.push(stage.kind)
    }

    async confirmPreflight(report: PreflightReport) {
      this.preflights.push(report)
    }

    async saveKey(prompt: SaveKeyPrompt) {
      this.savedKey = prompt.displayed
      return prompt.displayed
    }

    async enterSavedKey(prompt: SavedKeyPrompt) {
      this.savedKeyPrompts.push(prompt)
      if (!this.savedKey) throw new Error('the user saved no key')
      return this.savedKey
    }

    async confirmNoVerifiedSource(): Promise<void> {
      throw new Error('every attachment has a verified copy')
    }

    async chooseBundleFolder({reason}: {reason: BundleRetakeReason | null}): Promise<BundleFolder> {
      this.bundleReasons.push(reason)
      this.device.grant(this.device.picked)
      return this.device.picked
    }

    async reopenBundleFolder(prompt: ReopenBundlePrompt) {
      this.reopens.push(prompt)
      const folder = await this.reopen(prompt)
      if (folder) this.device.grant(folder)
      return folder
    }

    async chooseExistingBundle(): Promise<BundleFolder> {
      throw new Error('this device holds the bundle record')
    }

    async confirmFinish(prompt: FinishPrompt) {
      this.finishes.push(prompt)
    }

    status(status: ConversionStatus) {
      this.statuses.push(status)
      this.onStatus(status)
    }

    /** Each step it showed, once per stretch. */
    steps(): ConversionStatus['kind'][] {
      return this.statuses.map(status => status.kind).filter((kind, i, kinds) => kinds[i - 1] !== kind)
    }
  }

  // ── the checks ──

  /** Done: e2ee under this device's key, every row sealed and holding what it
   *  held (or this device's latest UI state), no plaintext left in history,
   *  and this device upgraded, with nothing queued or refused. */
  const expectConverted = async (device: Device, plaintext: ReadonlyMap<string, ContentColumns>) => {
    const {ws} = device
    const key = await device.keyStore.get(owner.id, ws)
    const workspace = await serverWorkspace(ws)
    expect(workspace).toMatchObject({encryption_mode: 'e2ee', phase: null})
    expect(await validateCanary(key!.wk, workspace.wk_canary!, ws)).toBe(true)

    // The pin upgrade lets held writes go; the run doesn't wait for them.
    expect(await device.upload()).toBe('uploaded')
    expect(await localQueue()).toEqual({pending: 0, rejected: 0})
    expect(getModePin(owner.id, ws)).toBe('e2ee')
    expect(await testDb.db.get('SELECT encryption_mode, wk_canary FROM workspaces WHERE id = ?', [ws]))
      .toEqual({encryption_mode: 'e2ee', wk_canary: workspace.wk_canary})
    expect(await device.bundles.get(owner.id, ws)).toBeNull()

    const rows = await query<ContentColumns & {id: string; workspace_id: string}>(
      'select id, workspace_id, content, properties_json, references_json from public.blocks where workspace_id = $1',
      [ws],
    )
    const uiState = await localUiState(ws)
    expect(rows).toHaveLength(plaintext.size + uiState.size)
    for (const row of rows) {
      expect(SEALED_COLUMNS.every(column => isSealedValue(row[column])), row.id).toBe(true)
      const opened = await openRow(key!.wk, row)
      if (uiState.has(row.id)) expect(opened.content, row.id).toBe(uiState.get(row.id))
      else expect(opened, row.id).toEqual(plaintext.get(row.id))
    }
    const history = await query<{event_id: number; before_diff: Record<string, unknown> | null; after_diff: Record<string, unknown> | null}>(
      'select event_id, before_diff, after_diff from public.blocks_history where workspace_id = $1',
      [ws],
    )
    for (const event of history) {
      for (const diff of [event.before_diff, event.after_diff]) {
        for (const column of SEALED_COLUMNS) {
          const value = diff?.[column]
          if (typeof value === 'string') expect(isSealedValue(value), `history ${event.event_id} ${column}`).toBe(true)
        }
      }
    }
  }

  const verified = (device: Device, folder: FsBundleFolder) =>
    verifyBundle({folder, workspaceId: device.ws, mediaHashOf: mediaHashOfStoredRow})

  const bundlePart = async (folder: FsBundleFolder, part: string): Promise<Array<Record<string, unknown>>> =>
    (await readFile(join(folder.path, part), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))

  const bundleRows = async (folder: FsBundleFolder): Promise<Map<string, ContentColumns>> =>
    new Map((await bundlePart(folder, BUNDLE_PARTS.blocks)).map(row => [String(row.id), contentColumnsOf(row as unknown as ContentColumns)]))

  it('converts a workspace with attachments, while this device keeps writing UI state', async () => {
    const seeded = await seedWorkspace({attachments: true})
    const device = await deviceFor(seeded)
    device.keepWriting()
    const ui = new ScriptedUi(device)

    expect(await device.run(ui)).toEqual({kind: 'done', bundleFolder: expect.stringMatching(/^e2ee-recovery-/)})

    expect(ui.contracts).toEqual(['plaintext'])
    expect(ui.preflights).toEqual([expect.objectContaining({oversized: [], noVerifiedSource: []})])
    expect(ui.finishes).toEqual([{unrecoverable: [], left: [], refused: [], bundleRead: true}])
    // Until the flip each write goes up as plaintext. From the flip until the
    // pin upgrade each one waits on this device, so the server sees none.
    const before = device.uiWrites.filter(write => write.localMode === 'none')
    const held = device.uiWrites.filter(write => write.localMode === 'e2ee' && write.pin === 'plaintext')
    const after = device.uiWrites.filter(write => write.pin === 'e2ee')
    expect(before.length + held.length + after.length).toBe(device.uiWrites.length)
    expect(new Set(before.map(write => write.upload))).toEqual(new Set(['uploaded']))
    expect(new Set(held.map(write => write.upload))).toEqual(new Set(['held']))
    expect(new Set(after.map(write => write.upload))).toEqual(new Set(['uploaded']))

    // The bundle holds the server as the flip left it, this device's writes
    // before it included.
    const [bundle] = bundleFoldersOf(device)
    await verified(device, bundle)
    const archived = await bundleRows(bundle)
    for (const [id, columns] of seeded.plaintext) expect(archived.get(id), id).toEqual(columns)
    expect(archived.size).toBe(seeded.plaintext.size + before.length)

    await expectConverted(device, seeded.plaintext)

    // Each media hash's keyed copy, the orphan's included, verified; every raw
    // object and every object the bundle archived is gone.
    const {wk, contentKeyHmac} = (await device.keyStore.get(owner.id, seeded.ws))!
    const keyed = new Map<string, Uint8Array<ArrayBuffer>>()
    for (const [hash, bytes] of [...Object.values(seeded.media!), seeded.orphan!]) {
      keyed.set(await deriveContentKey({contentHash: hash, mode: 'e2ee', contentKeyHmac: contentKeyHmac!}), bytes)
    }
    expect(await storedObjects(seeded.ws)).toEqual([...keyed.keys()].sort())
    for (const [name, bytes] of keyed) {
      const {data} = await admin.storage.from(ATTACHMENTS_BUCKET).download(`${seeded.ws}/${name}`)
      expect(await verifyObjectBytes(new Uint8Array(await data!.arrayBuffer()), 'e2ee', async () => wk, {
        contentHash: await computeContentHash(bytes),
        workspaceId: seeded.ws,
      })).toEqual({ok: true, plaintext: bytes})
    }
  })

  it('resumes after a crash at each step, the steps past the purge of a workspace with no attachments included', async () => {
    const seeded = await seedWorkspace()
    const device = await deviceFor(seeded)
    device.keepWriting()
    const crashes: Array<readonly [at: string, when: (status: ConversionStatus) => boolean, leaves: string]> = [
      // The key is stored and the flip about to go out, under it.
      ['the flip', status => status.kind === 'flipping', 'none'],
      ['the bundle', status => status.kind === 'taking-bundle' && status.progress?.part === 'blocks', 'sealing'],
      ['the re-seal', status => status.kind === 'resealing' && status.progress !== null, 'sealing'],
      ['the verify', status => status.kind === 'verifying' && status.progress !== null, 'sealing'],
      ['the purge', status => status.kind === 'purging', 'sealing'],
      ['the pin upgrade', status => status.kind === 'upgrading-pin', 'cleaning'],
      ['the cleanup', status => status.kind === 'cleaning', 'cleaning'],
      ['the finish', status => status.kind === 'finishing', 'cleaning'],
    ]
    // Thrown from a status, a crash still runs the stage's own cleanup, which a
    // page that dies doesn't: a half-written bundle is removed here, and left
    // there. Either way the next run reads only the folder it recorded.
    let savedKey: string | null = null
    const reopened: ReopenBundlePrompt['purpose'][] = []
    for (const [at, when, leaves] of crashes) {
      const ui: ScriptedUi = new ScriptedUi(device, savedKey)
      ui.onStatus = status => {
        if (when(status)) throw new Error(`crashed at ${at}`)
      }
      ui.reopen = async prompt => (reopened.push(prompt.purpose), prompt.recorded)
      await expect(device.run(ui), at).rejects.toThrow(`crashed at ${at}`)
      savedKey = ui.savedKey
      const workspace = await serverWorkspace(seeded.ws)
      expect(workspace.phase ?? workspace.encryption_mode, at).toBe(leaves)
      if (at === 'the re-seal') {
        // Part of the way through, which the next run carries on from.
        const sealed = await sealedRowCount(seeded.ws)
        expect(sealed).toBeGreaterThan(0)
        expect(sealed).toBeLessThan(seeded.plaintext.size)
      }
    }
    // Each run past the bundle is a new page, which has to be granted the
    // recorded folder again.
    expect(new Set(reopened)).toEqual(new Set(['purge', 'cleanup']))

    // With no attachments, the cleanup needs nothing from the bundle.
    const last = new ScriptedUi(device, savedKey)
    last.reopen = async () => null
    const done = await device.run(last)
    expect(done).toMatchObject({kind: 'done'})
    expect(last.finishes).toEqual([{unrecoverable: [], left: [], refused: [], bundleRead: false}])
    const recorded = bundleFoldersOf(device).find(folder => done.kind === 'done' && folder.name === done.bundleFolder)
    await verified(device, recorded!)
    await expectConverted(device, seeded.plaintext)
  })

  it("carries on past a purge whose response was lost, from the server's refusal to purge again", async () => {
    const seeded = await seedWorkspace()
    const device = await deviceFor(seeded)
    const answers: string[] = []
    tap = (async (url, _init, send) => {
      if (endpointOf(url) !== 'rpc/purge_workspace_history') return send()
      const response = await send()
      if (answers.length === 0 && response.ok) {
        answers.push('purged, response lost')
        throw new TypeError('fetch failed')
      }
      answers.push(response.ok ? 'purged' : await errorCode(response))
      return response
    })

    expect(await device.run(new ScriptedUi(device))).toMatchObject({kind: 'done'})
    expect(answers).toEqual(['purged, response lost', ConversionErrorCode.refused])
    await expectConverted(device, seeded.plaintext)
  })

  it('holds the purge back from a bundle moved during the re-seal until the user finds it again', async () => {
    const seeded = await seedWorkspace()
    const device = await deviceFor(seeded)
    const elsewhere = new FsBundleFolder(await tempDir())
    const ui = new ScriptedUi(device)
    ui.onStatus = status => {
      const [bundle] = bundleFoldersOf(device)
      if (status.kind === 'resealing' && status.progress !== null && bundle) renameSync(bundle.path, join(elsewhere.path, bundle.name))
    }
    const phasesAsked: Array<string | null> = []
    ui.reopen = async () => {
      phasesAsked.push((await serverWorkspace(seeded.ws)).phase)
      return elsewhere
    }

    expect(await device.run(ui)).toMatchObject({kind: 'done'})
    expect(ui.reopens).toEqual([expect.objectContaining({purpose: 'purge', problem: expect.stringContaining("can't be read")})])
    expect(phasesAsked).toEqual(['sealing'])
    // The bundle it found again is the one the purge went ahead under.
    expect(ui.bundleReasons).toEqual([null])
    await expectConverted(device, seeded.plaintext)
  })

  it('takes a new bundle for one edited during the re-seal, holding plaintext for the rows already sealed', async () => {
    const seeded = await seedWorkspace()
    const device = await deviceFor(seeded)
    const ui = new ScriptedUi(device)
    let edited = false
    ui.onStatus = status => {
      if (status.kind !== 'resealing' || status.progress === null || edited) return
      edited = true
      const blocks = join(bundleFoldersOf(device)[0].path, BUNDLE_PARTS.blocks)
      writeFileSync(blocks, readFileSync(blocks, 'utf8').replace('note 1 ', 'note one '))
    }

    expect(await device.run(ui)).toMatchObject({kind: 'done'})
    expect(ui.bundleReasons).toEqual([null, 'changed'])
    const [first, retaken] = bundleFoldersOf(device)
    await expect(verified(device, first)).rejects.toThrow(BundleInvalid)
    await verified(device, retaken)
    expect(await bundleRows(retaken)).toEqual(seeded.plaintext)
    // It archives the re-seal's writes too, whose before_diff is the plaintext.
    const [firstHistory, retakenHistory] = [await bundlePart(first, BUNDLE_PARTS.history), await bundlePart(retaken, BUNDLE_PARTS.history)]
    expect(retakenHistory).toHaveLength(firstHistory.length + seeded.plaintext.size)
    await expectConverted(device, seeded.plaintext)
  })

  it('re-seals a row the purge finds unsealed, and purges again under the same bundle', async () => {
    const seeded = await seedWorkspace()
    const device = await deviceFor(seeded)
    const [[unsealed, columns]] = seeded.plaintext
    const answers: string[] = []
    tap = (async (url, _init, send) => {
      if (endpointOf(url) !== 'rpc/purge_workspace_history') return send()
      // Plaintext back in a sealed row, by a write past the server's checks.
      if (answers.length === 0) {
        await db.writeWithoutTriggers(
          'update public.blocks set content = $2, properties_json = $3, references_json = $4 where id = $1',
          [unsealed, columns.content, columns.properties_json, columns.references_json],
        )
      }
      const response = await send()
      answers.push(response.ok ? 'purged' : await errorCode(response))
      return response
    })
    const ui = new ScriptedUi(device)

    expect(await device.run(ui)).toMatchObject({kind: 'done'})
    expect(answers).toEqual([ConversionErrorCode.refused, 'purged'])
    expect(ui.bundleReasons).toEqual([null])
    expect(ui.steps().filter(step => step === 'resealing')).toHaveLength(2)
    await expectConverted(device, seeded.plaintext)
  })

  it('reads the bundle again when a write lands while it pages through the blocks', async () => {
    const seeded = await seedWorkspace()
    const device = await deviceFor(seeded)
    const [removed] = [...seeded.plaintext.keys()].sort()
    let firstPages = 0
    tap = (async (url, init, send) => {
      const isBlockPage = endpointOf(url) === 'blocks' && url.searchParams.get('select') === '*' && (init?.method ?? 'GET') === 'GET'
      if (isBlockPage && (await serverWorkspace(seeded.ws)).phase === 'sealing') {
        if (!url.searchParams.has('id')) firstPages++
        // An operator's hard delete, of a row the first page already read.
        else if (firstPages === 1) await query('delete from public.blocks where id = $1 and workspace_id = $2', [removed, seeded.ws])
      }
      return send()
    })

    expect(await device.run(new ScriptedUi(device))).toMatchObject({kind: 'done'})
    expect(firstPages).toBe(2)
    const [bundle] = bundleFoldersOf(device)
    const archived = await bundleRows(bundle)
    expect(archived.has(removed)).toBe(false)
    expect(archived.size).toBe(seeded.plaintext.size - 1)
    expect((await verified(device, bundle)).manifest.serverBlockCount).toBe(seeded.plaintext.size - 1)
    // Its history ends with the delete, which the bundle's `through` covers.
    expect((await bundlePart(bundle, BUNDLE_PARTS.history)).filter(row => row.block_id === removed).at(-1)).toMatchObject({op: 'D'})
    await expectConverted(device, new Map([...seeded.plaintext].filter(([id]) => id !== removed)))
  })

  it('never starts the re-seal under a bundle the user stopped, or one cut short', async () => {
    const seeded = await seedWorkspace()
    const device = await deviceFor(seeded)
    const stop = new AbortController()
    const stopped = new ScriptedUi(device)
    stopped.onStatus = status => {
      if (status.kind === 'taking-bundle' && status.progress?.part === 'blocks') stop.abort(new DOMException('Stopped', 'AbortError'))
    }
    await expect(device.run(stopped, stop.signal)).rejects.toThrow()
    expect(await serverWorkspace(seeded.ws)).toMatchObject({phase: 'sealing'})
    expect(await sealedRowCount(seeded.ws)).toBe(0)
    expect(await device.bundles.get(owner.id, seeded.ws)).toBeNull()
    expect(bundleFoldersOf(device)).toEqual([])

    const cut = new ScriptedUi(device, stopped.savedKey)
    cut.onStatus = status => {
      const [bundle] = bundleFoldersOf(device)
      // Right before it is re-opened for the check.
      if (status.kind !== 'checking-bundle' || !bundle) return
      const blocks = join(bundle.path, BUNDLE_PARTS.blocks)
      truncateSync(blocks, Math.floor(statSync(blocks).size / 2))
    }
    await expect(device.run(cut)).rejects.toThrow(BundleInvalid)
    expect(await sealedRowCount(seeded.ws)).toBe(0)
    expect(await device.bundles.get(owner.id, seeded.ws)).toBeNull()
    // The half bundle is plaintext nothing will use.
    expect(bundleFoldersOf(device)).toEqual([])

    expect(await device.run(new ScriptedUi(device, stopped.savedKey))).toMatchObject({kind: 'done'})
    await expectConverted(device, seeded.plaintext)
  })

  it('resumes under the same key a flip that committed after this device gave up on it', async () => {
    const seeded = await seedWorkspace()
    const device = await deviceFor(seeded)
    let late: (() => Promise<Response>) | null = null
    let landed = false
    const canaries: string[] = []
    tap = (async (url, init, send) => {
      if (endpointOf(url) !== 'rpc/convert_workspace_to_e2ee') return send()
      canaries.push(JSON.parse(String(init?.body)).p_wk_canary)
      if (!late) {
        // On its way, while this device has stopped waiting for it.
        late = send
        throw new TypeError('fetch failed')
      }
      if (!landed) {
        // It lands just before the second run's flip goes out. A block write
        // anywhere refuses either for now, which the stack's other tests make.
        for (let response = await late(); !response.ok; response = await late()) {
          expect(await errorCode(response)).toBe(ConversionErrorCode.lockNotAvailable)
          await abortableSleep(100)
        }
        landed = true
      }
      return send()
    })

    const first = new ScriptedUi(device)
    await expect(device.run(first)).rejects.toThrow('convert_workspace_to_e2ee failed')
    expect(await serverWorkspace(seeded.ws)).toMatchObject({encryption_mode: 'none', phase: null})

    const second = new ScriptedUi(device, first.savedKey)
    expect(await device.run(second)).toMatchObject({kind: 'done'})
    expect(second.savedKeyPrompts).toEqual([{context: 'earlier-attempt', problem: null, canStartOver: false}])
    // The second run sends its own canary, perhaps more than once.
    expect(new Set(canaries).size).toBe(2)
    expect((await serverWorkspace(seeded.ws)).wk_canary).toBe(canaries[0])
    await expectConverted(device, seeded.plaintext)
  })

  it('refuses a second run while one holds the lock', async () => {
    const seeded = await seedWorkspace()
    const device = await deviceFor(seeded)
    const first = new ScriptedUi(device)
    let asked!: () => void
    const contractAsked = new Promise<void>(resolve => (asked = resolve))
    let confirm!: () => void
    first.confirmContract = async stage => {
      first.contracts.push(stage.kind)
      asked()
      await new Promise<void>(resolve => (confirm = resolve))
    }
    const running = device.run(first)
    await contractAsked

    const second = new ScriptedUi(device)
    expect(await device.run(second)).toEqual({kind: 'busy'})
    expect(second.statuses).toEqual([])
    confirm()
    expect(await running).toMatchObject({kind: 'done'})
    await expectConverted(device, seeded.plaintext)
  })
})
