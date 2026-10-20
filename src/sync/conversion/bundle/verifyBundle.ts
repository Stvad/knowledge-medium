/**
 * Re-opening a recovery bundle and checking it (docs/workspace-e2ee-conversion.md
 * §6.3 step 3, and again before the purge, step 6): every part matches the
 * manifest, the manifest and every row name this workspace, and `blocks.jsonl`
 * holds exactly the server's block count, each id once. Key-loss recovery
 * tombstones every row the file lacks, so a truncated file must never pass.
 *
 * Total: anything wrong with what it reads is a {@link BundleInvalid}, so a
 * caller can always decide between asking again and taking a new bundle.
 * And what it returns it counted on disk, so the purge's arguments are what
 * the folder holds, not what the manifest claims.
 */

import { SEALED_COLUMNS } from '../../transform.js'
import { isSealedRow } from '../sealing.js'
import { untilStopped } from '@/utils/untilStopped.js'
import { scanPart, sha256Hex, stoppableFolder, type BundleFolder, type PartDigest } from './bundleParts.js'
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, BUNDLE_PARTS, type BundleManifest } from './manifest.js'

export type BundleProblem =
  /** The folder itself can't be read: moved, deleted, on a drive that's gone,
   *  or no longer accessible. */
  | 'unreadable'
  /** A part is missing, or its bytes can't be read or decoded. */
  | 'part-unreadable'
  | 'manifest-unreadable'
  | 'manifest-changed'
  | 'other-workspace'
  | 'part-mismatch'
  | 'row-unreadable'
  | 'row-other-workspace'
  | 'duplicate-row'
  | 'sealed-row'
  | 'row-count'
  | 'history-order'
  | 'history-through'

export class BundleInvalid extends Error {
  constructor(
    readonly problem: BundleProblem,
    detail: string,
  ) {
    super(`the recovery bundle doesn't check out: ${detail}`)
    this.name = 'BundleInvalid'
  }
}

export interface VerifiedBundle {
  readonly manifest: BundleManifest
  /** Lowercase hex sha256 of `manifest.json` as read. */
  readonly manifestSha256: string
  /** What the folder holds, counted as it was read. */
  readonly counted: {
    readonly blockRows: number
    readonly historyRows: number
    /** The last history event in the file, 0 when it holds none. */
    readonly through: number
  }
}

export interface VerifyBundleOptions {
  readonly folder: BundleFolder
  readonly workspaceId: string
  /** The bundle record's manifest digest: the folder must be that bundle. */
  readonly manifestSha256?: string
  readonly signal?: AbortSignal
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Streams one part, turning anything but its own verdicts and an abort into
 *  `part-unreadable`: a byte that isn't UTF-8, a file changed while being
 *  read, a part that's gone. */
const scanFolderPart = async (
  folder: BundleFolder,
  name: string,
  onLine: ((line: string) => void) | undefined,
  signal?: AbortSignal,
): Promise<PartDigest> => {
  try {
    return await scanPart(await (await folder.getFileHandle(name)).getFile(), onLine, signal)
  } catch (error) {
    if (error instanceof BundleInvalid || signal?.aborted) throw error
    throw new BundleInvalid('part-unreadable', `${name} can't be read (${describe(error)})`)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseManifest = (bytes: Uint8Array, workspaceId: string): BundleManifest => {
  let manifest: unknown
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes))
  } catch {
    throw new BundleInvalid('manifest-unreadable', `${BUNDLE_PARTS.manifest} isn't JSON`)
  }
  if (!isRecord(manifest) || manifest.format !== BUNDLE_FORMAT || manifest.version !== BUNDLE_FORMAT_VERSION || !isRecord(manifest.parts)) {
    throw new BundleInvalid('manifest-unreadable', `${BUNDLE_PARTS.manifest} isn't a version ${BUNDLE_FORMAT_VERSION} bundle manifest`)
  }
  if (manifest.workspaceId !== workspaceId) {
    throw new BundleInvalid('other-workspace', `it is the bundle of workspace ${String(manifest.workspaceId)}`)
  }
  return manifest as unknown as BundleManifest
}

const requireDigest = (name: string, expected: PartDigest | undefined, actual: PartDigest): void => {
  if (!expected || expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes) {
    throw new BundleInvalid('part-mismatch', `${name} differs from the manifest`)
  }
}

/** A `.jsonl` part: each line a row of this workspace, checked by `checkRow`;
 *  then its digest and its line count against the manifest. Returns the lines
 *  it counted. */
const verifyJsonlPart = async (
  folder: BundleFolder,
  manifest: BundleManifest,
  name: typeof BUNDLE_PARTS.blocks | typeof BUNDLE_PARTS.history,
  checkRow: (row: Record<string, unknown>, line: number) => void,
  signal?: AbortSignal,
): Promise<number> => {
  let lines = 0
  const digest = await scanFolderPart(folder, name, text => {
    const line = ++lines
    let row: unknown
    try {
      row = JSON.parse(text)
    } catch {
      throw new BundleInvalid('row-unreadable', `${name} line ${line} isn't JSON`)
    }
    if (!isRecord(row)) throw new BundleInvalid('row-unreadable', `${name} line ${line} isn't a row`)
    if (row.workspace_id !== manifest.workspaceId) {
      throw new BundleInvalid('row-other-workspace', `${name} line ${line} belongs to workspace ${String(row.workspace_id)}`)
    }
    checkRow(row, line)
  }, signal)
  requireDigest(name, manifest.parts[name], digest)
  if (lines !== manifest.parts[name].lines) {
    throw new BundleInvalid('row-count', `${name} has ${lines} rows; the manifest says ${manifest.parts[name].lines}`)
  }
  return lines
}

const verifyBlocks = async (folder: BundleFolder, manifest: BundleManifest, signal?: AbortSignal): Promise<number> => {
  const name = BUNDLE_PARTS.blocks
  // Every id, not just the last: the rows come in the server's collation,
  // which a JS string comparison can't stand in for. About 40-100 MB per
  // million blocks.
  const ids = new Set<string>()
  const lines = await verifyJsonlPart(folder, manifest, name, (row, line) => {
    if (typeof row.id !== 'string' || ids.has(row.id)) {
      throw new BundleInvalid('duplicate-row', `${name} line ${line} repeats block ${String(row.id)}`)
    }
    ids.add(row.id)
    if (!SEALED_COLUMNS.every(column => typeof row[column] === 'string')) {
      throw new BundleInvalid('row-unreadable', `${name} line ${line} has no content columns`)
    }
    // The file is plaintext by construction; a sealed row is a writer bug that
    // would leave that row unrecoverable once the key is lost.
    if (isSealedRow(row as Record<(typeof SEALED_COLUMNS)[number], string>)) {
      throw new BundleInvalid('sealed-row', `${name} line ${line} holds sealed content`)
    }
  }, signal)
  if (lines !== manifest.serverBlockCount) {
    throw new BundleInvalid('row-count', `${name} has ${lines} rows; the server held ${manifest.serverBlockCount}`)
  }
  return lines
}

const verifyHistory = async (
  folder: BundleFolder,
  manifest: BundleManifest,
  signal?: AbortSignal,
): Promise<{historyRows: number; through: number}> => {
  const name = BUNDLE_PARTS.history
  let through = 0
  const historyRows = await verifyJsonlPart(folder, manifest, name, (row, line) => {
    if (typeof row.event_id !== 'number' || row.event_id <= through) {
      throw new BundleInvalid('history-order', `${name} line ${line} is out of event order`)
    }
    through = row.event_id
  }, signal)
  // A workspace whose rows predate the history trigger has no history at all.
  if (through !== manifest.through) {
    throw new BundleInvalid('history-through', `${name} ends at event ${through}; the manifest says ${manifest.through}`)
  }
  return {historyRows, through}
}

const readManifest = async (folder: BundleFolder, signal?: AbortSignal): Promise<Uint8Array> => {
  try {
    const file = await (await folder.getFileHandle(BUNDLE_PARTS.manifest)).getFile()
    return new Uint8Array(await untilStopped(file.arrayBuffer(), signal))
  } catch (error) {
    if (signal?.aborted) throw error
    throw new BundleInvalid('unreadable', `the folder can't be read (${describe(error)})`)
  }
}

export const verifyBundle = async ({folder: given, workspaceId, manifestSha256, signal}: VerifyBundleOptions): Promise<VerifiedBundle> => {
  const folder = stoppableFolder(given, signal)
  const manifestBytes = await readManifest(folder, signal)
  const digest = sha256Hex(manifestBytes)
  if (manifestSha256 !== undefined && digest !== manifestSha256) {
    throw new BundleInvalid('manifest-changed', `${BUNDLE_PARTS.manifest} isn't the one this device recorded`)
  }
  const manifest = parseManifest(manifestBytes, workspaceId)
  const blockRows = await verifyBlocks(folder, manifest, signal)
  const {historyRows, through} = await verifyHistory(folder, manifest, signal)
  const localDb = BUNDLE_PARTS.localDb
  requireDigest(localDb, manifest.parts[localDb], await scanFolderPart(folder, localDb, undefined, signal))
  return {manifest, manifestSha256: digest, counted: {blockRows, historyRows, through}}
}
