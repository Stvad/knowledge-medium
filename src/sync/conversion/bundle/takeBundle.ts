/**
 * Taking the recovery bundle (docs/workspace-e2ee-conversion.md §6.3 step 3),
 * right after the flip. It reads the server, never this device's database
 * image, so no download gap can make it stale; and it needs no key, so until
 * the purge the server alone can rebuild it.
 */

import { contentColumnsOf, idsOf, isSealedRow } from '../sealing.js'
import type { ConversionServer, FullServerBlockRow, FullServerHistoryRow } from '../conversionServer.js'
import { keysetPages } from '../pages.js'
import { latestResealWrites } from '../verifyReseal.js'
import type { UnrecoverableMedia } from '../attachmentCleaner.js'
import { MediaBlocks, writeAttachmentParts, type AttachmentSource } from './attachmentParts.js'
import { writeBytesPart, writeJsonlPart, type BundleFolder, type JsonlDigest, type PartDigest } from './bundleParts.js'
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_VERSION,
  BUNDLE_PARTS,
  type BundleManifest,
} from './manifest.js'

export type BundleProgress =
  | {readonly part: 'blocks'; readonly rows: number}
  | {readonly part: 'history'; readonly rows: number}
  | {readonly part: 'local-db'}
  | {readonly part: 'attachments'; readonly files: number}

export type BundleRefusalReason =
  /** Sealed rows with no re-seal record: something other than the re-seal
   *  sealed them, so the bundle can't say what they held. */
  | 'no-record'
  /** The workspace kept being written during every read. */
  | 'unstable'

export class BundleRefusal extends Error {
  constructor(
    readonly reason: BundleRefusalReason,
    readonly blockIds: readonly string[] = [],
  ) {
    super(reason === 'no-record'
      ? `the recovery bundle can't be taken: rows were sealed outside the re-seal (${blockIds.join(', ')})`
      : 'the recovery bundle can\'t be taken: the workspace kept changing while it was read')
    this.name = 'BundleRefusal'
  }
}

export interface TakeBundleOptions {
  readonly server: ConversionServer
  readonly workspaceId: string
  /** An empty folder for this bundle alone. */
  readonly folder: BundleFolder
  /** Write this device's database, copied under its lock, into `folder` as
   *  {@link BUNDLE_PARTS.localDb}, and return its digest. */
  readonly writeLocalDb: (folder: BundleFolder, signal?: AbortSignal) => Promise<PartDigest>
  readonly attachments: {
    readonly source: AttachmentSource
    /** The user accepts that this media has no hash-verified copy anywhere:
     *  its hashes go in the manifest, and the bundle holds no bytes for them.
     *  Asked again after the flip, since nothing can bring them back. */
    readonly confirmNoVerifiedSource: (media: readonly UnrecoverableMedia[]) => Promise<void>
  }
  readonly now?: () => Date
  readonly pageSize?: number
  readonly onProgress?: (progress: BundleProgress) => void
  readonly signal?: AbortSignal
}

export interface TakenBundle {
  readonly manifest: BundleManifest
}

/** Rows per page, for the bundle and for preflight's dry run of it. */
export const BUNDLE_PAGE_SIZE = 500
/** Each read that a concurrent write invalidates is retried this many times. */
const READ_ATTEMPTS = 3

/** A page of server rows as the bundle archives them: verbatim, except that a
 *  row the re-seal counts as sealed takes its content columns from its re-seal
 *  record, so the file is plaintext whether or not the re-seal has run. */
const archivedRows = async (
  server: ConversionServer,
  workspaceId: string,
  page: readonly FullServerBlockRow[],
): Promise<FullServerBlockRow[]> => {
  const sealed = page.filter(isSealedRow)
  if (sealed.length === 0) return [...page]
  const records = latestResealWrites(await server.readContentSealHistory(workspaceId, idsOf(sealed)))
  const unrecorded = sealed.filter(row => !records.has(row.id))
  if (unrecorded.length > 0) throw new BundleRefusal('no-record', idsOf(unrecorded))
  return page.map(row => {
    const record = records.get(row.id)
    return record && isSealedRow(row) ? {...row, ...contentColumnsOf(record.before)} : row
  })
}

/** Every block row, by id. */
export const blockRowPages = (
  server: ConversionServer,
  workspaceId: string,
  pageSize: number,
  signal?: AbortSignal,
): AsyncGenerator<readonly FullServerBlockRow[]> =>
  keysetPages<FullServerBlockRow, string | null>({
    read: (after, limit) => server.readFullBlockPage(workspaceId, after, limit),
    first: null,
    cursorOf: row => row.id,
    pageSize,
    signal,
  })

/** Every history row up to `through`, by event id. */
export const historyRowPages = (
  server: ConversionServer,
  workspaceId: string,
  through: number,
  pageSize: number,
  signal?: AbortSignal,
): AsyncGenerator<readonly FullServerHistoryRow[]> =>
  keysetPages<FullServerHistoryRow, number>({
    read: (after, limit) => server.readHistoryPage(workspaceId, after, through, limit),
    first: 0,
    cursorOf: row => row.event_id,
    pageSize,
    done: after => after >= through,
    signal,
  })

/** `blocks.jsonl`, and the media its rows carry. */
const writeBlocks = async (options: TakeBundleOptions): Promise<{digest: JsonlDigest; media: MediaBlocks}> => {
  const media = new MediaBlocks(options.attachments.source.mediaHashOf)
  const digest = await writeJsonlPart(options.folder, BUNDLE_PARTS.blocks, async writeRow => {
    const {server, workspaceId, signal} = options
    let rows = 0
    for await (const page of blockRowPages(server, workspaceId, options.pageSize ?? BUNDLE_PAGE_SIZE, signal)) {
      for (const row of await archivedRows(server, workspaceId, page)) {
        await writeRow(row)
        media.add(row)
      }
      rows += page.length
      options.onProgress?.({part: 'blocks', rows})
    }
  })
  return {digest, media}
}

const writeHistory = (options: TakeBundleOptions, through: number): Promise<JsonlDigest> =>
  writeJsonlPart(options.folder, BUNDLE_PARTS.history, async writeRow => {
    const {server, workspaceId, signal} = options
    let rows = 0
    for await (const page of historyRowPages(server, workspaceId, through, options.pageSize ?? BUNDLE_PAGE_SIZE, signal)) {
      for (const row of page) await writeRow(row)
      rows += page.length
      options.onProgress?.({part: 'history', rows})
    }
  })

interface ServerSnapshot {
  readonly through: number
  readonly blocks: JsonlDigest
  readonly media: MediaBlocks
  readonly history: JsonlDigest
  readonly serverBlockCount: number
  readonly propertiesMigration: string
}

/** Both `.jsonl` parts, consistent with each other and with the block count:
 *  every write to a block adds a history row, so an unchanged history count
 *  across the reads means nothing was written during them. */
const readServerSnapshot = async (options: TakeBundleOptions): Promise<ServerSnapshot> => {
  const {server, workspaceId} = options
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    const before = await server.workspaceCounts(workspaceId)
    const history = await writeHistory(options, before.maxEventId)
    const {digest: blocks, media} = await writeBlocks(options)
    // A lost session reads every table as empty; this one is an error instead.
    const workspace = await server.readWorkspace(workspaceId)
    if (!workspace) throw new Error(`conversion: workspace ${workspaceId} is not visible to this session`)
    const after = await server.workspaceCounts(workspaceId)
    if (after.history !== before.history) continue
    // With the history count unchanged, the block count is the one the pages
    // saw, and every history row is at or below `through`.
    if (blocks.lines !== after.blocks || history.lines !== before.history) {
      throw new Error(
        `conversion: the bundle read ${blocks.lines} of the workspace's ${after.blocks} rows and ` +
          `${history.lines} of its ${before.history} history rows; take it again`,
      )
    }
    return {
      through: before.maxEventId,
      blocks,
      media,
      history,
      serverBlockCount: after.blocks,
      propertiesMigration: workspace.properties_migration,
    }
  }
  throw new BundleRefusal('unstable')
}

export const takeBundle = async (options: TakeBundleOptions): Promise<TakenBundle> => {
  // First: it is the part a slow destination can't take in time, and it
  // should fail before the long server read rather than after it.
  options.onProgress?.({part: 'local-db'})
  const localDb = await options.writeLocalDb(options.folder, options.signal)
  options.signal?.throwIfAborted()
  const snapshot = await readServerSnapshot(options)

  // Storage isn't in the history window: nothing writes it after the flip, so
  // it's read once, after the rows.
  const {source, confirmNoVerifiedSource} = options.attachments
  options.onProgress?.({part: 'attachments', files: 0})
  const {missing, otherObjects} = await writeAttachmentParts({
    folder: options.folder,
    source,
    mediaHashes: snapshot.media.hashes(),
    signal: options.signal,
    onProgress: files => options.onProgress?.({part: 'attachments', files}),
  })
  // Before the manifest: a cancel leaves a folder that never verifies.
  if (missing.length > 0) await confirmNoVerifiedSource(snapshot.media.blocksOf(missing))

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_FORMAT_VERSION,
    workspaceId: options.workspaceId,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    through: snapshot.through,
    serverBlockCount: snapshot.serverBlockCount,
    propertiesMigration: snapshot.propertiesMigration,
    parts: {
      [BUNDLE_PARTS.blocks]: snapshot.blocks,
      [BUNDLE_PARTS.history]: snapshot.history,
      [BUNDLE_PARTS.localDb]: localDb,
    },
    noVerifiedSource: missing,
    otherObjects,
  }
  await writeBytesPart(options.folder, BUNDLE_PARTS.manifest, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`))
  return {manifest}
}
