/**
 * Taking the recovery bundle (docs/workspace-e2ee-conversion.md §6.3 step 3),
 * right after the flip. It reads the server, never this device's database
 * image, so no download gap can make it stale; and it needs no key, so until
 * the purge the server alone can rebuild it.
 */

import { contentColumnsOf, idsOf, isSealedRow } from '../sealing.js'
import type { ConversionServer, FullServerBlockRow } from '../conversionServer.js'
import { latestResealWrites } from '../verifyReseal.js'
import { scanPart, writeBytesPart, writeJsonlPart, type BundleFolder, type JsonlDigest } from './bundleParts.js'
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
   *  {@link BUNDLE_PARTS.localDb}. */
  readonly writeLocalDb: (folder: BundleFolder) => Promise<void>
  /** Media hashes the user confirmed in preflight have no verified source. */
  readonly noVerifiedSource?: readonly string[]
  readonly now?: () => Date
  readonly pageSize?: number
  readonly onProgress?: (progress: BundleProgress) => void
  readonly signal?: AbortSignal
}

export interface TakenBundle {
  readonly manifest: BundleManifest
}

const PAGE_SIZE = 500
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

const writeBlocks = (options: TakeBundleOptions): Promise<JsonlDigest> =>
  writeJsonlPart(options.folder, BUNDLE_PARTS.blocks, async writeRow => {
    const {server, workspaceId, signal} = options
    let rows = 0
    for (let afterId: string | null = null; ;) {
      signal?.throwIfAborted()
      const page = await server.readFullBlockPage(workspaceId, afterId, options.pageSize ?? PAGE_SIZE)
      if (page.length === 0) return
      for (const row of await archivedRows(server, workspaceId, page)) await writeRow(row)
      rows += page.length
      options.onProgress?.({part: 'blocks', rows})
      afterId = page[page.length - 1].id
    }
  })

const writeHistory = (options: TakeBundleOptions, through: number): Promise<JsonlDigest> =>
  writeJsonlPart(options.folder, BUNDLE_PARTS.history, async writeRow => {
    const {server, workspaceId, signal} = options
    let rows = 0
    for (let afterEventId = 0; afterEventId < through;) {
      signal?.throwIfAborted()
      const page = await server.readHistoryPage(workspaceId, afterEventId, through, options.pageSize ?? PAGE_SIZE)
      if (page.length === 0) return
      for (const row of page) await writeRow(row)
      rows += page.length
      options.onProgress?.({part: 'history', rows})
      afterEventId = page[page.length - 1].event_id
    }
  })

interface ServerSnapshot {
  readonly through: number
  readonly blocks: JsonlDigest
  readonly history: JsonlDigest
  readonly serverBlockCount: number
}

/** Both `.jsonl` parts, consistent with each other and with the block count:
 *  every write to a block adds a history row, so an unchanged history count
 *  across the reads means nothing was written during them. */
const readServerSnapshot = async (options: TakeBundleOptions): Promise<ServerSnapshot> => {
  const {server, workspaceId} = options
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    const before = await server.historyBounds(workspaceId)
    const history = await writeHistory(options, before.maxEventId)
    const blocks = await writeBlocks(options)
    const serverBlockCount = await server.countBlocks(workspaceId)
    // A lost session reads every table as empty; this one is an error instead.
    if (!(await server.readWorkspace(workspaceId))) {
      throw new Error(`conversion: workspace ${workspaceId} is not visible to this session`)
    }
    const after = await server.historyBounds(workspaceId)
    if (after.count !== before.count) continue
    if (blocks.lines !== serverBlockCount) {
      throw new Error(`conversion: the bundle read ${blocks.lines} of the workspace's ${serverBlockCount} rows; take it again`)
    }
    return {through: before.maxEventId, blocks, history, serverBlockCount}
  }
  throw new BundleRefusal('unstable')
}

export const takeBundle = async (options: TakeBundleOptions): Promise<TakenBundle> => {
  const snapshot = await readServerSnapshot(options)
  options.signal?.throwIfAborted()
  options.onProgress?.({part: 'local-db'})
  await options.writeLocalDb(options.folder)
  const localDb = await scanPart(await (await options.folder.getFileHandle(BUNDLE_PARTS.localDb)).getFile(), undefined, options.signal)

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_FORMAT_VERSION,
    workspaceId: options.workspaceId,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    through: snapshot.through,
    serverBlockCount: snapshot.serverBlockCount,
    parts: {
      [BUNDLE_PARTS.blocks]: snapshot.blocks,
      [BUNDLE_PARTS.history]: snapshot.history,
      [BUNDLE_PARTS.localDb]: localDb,
    },
    noVerifiedSource: options.noVerifiedSource ?? [],
  }
  await writeBytesPart(options.folder, BUNDLE_PARTS.manifest, new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`))
  return {manifest}
}
