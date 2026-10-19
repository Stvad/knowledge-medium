/**
 * Re-opening a recovery bundle and checking it (docs/workspace-e2ee-conversion.md
 * §6.3 step 3, and again before the purge, step 6): every part matches the
 * manifest, the manifest and every row name this workspace, and `blocks.jsonl`
 * holds exactly the server's block count, each id once. Key-loss recovery
 * tombstones every row the file lacks, so a truncated file must never pass.
 */

import { SEALED_COLUMNS } from '../../transform.js'
import { isSealedRow } from '../sealing.js'
import { scanPart, sha256Hex, type BundleFolder, type PartDigest } from './bundleParts.js'
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION, BUNDLE_PARTS, type BundleManifest } from './manifest.js'

export type BundleProblem =
  | 'missing-part'
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
}

export interface VerifyBundleOptions {
  readonly folder: BundleFolder
  readonly workspaceId: string
  /** The bundle record's manifest digest: the folder must be that bundle. */
  readonly manifestSha256?: string
  readonly signal?: AbortSignal
}

const readPart = async (folder: BundleFolder, name: string): Promise<Blob> => {
  try {
    return await (await folder.getFileHandle(name)).getFile()
  } catch (error) {
    throw new BundleInvalid('missing-part', `${name} can't be read (${error instanceof Error ? error.message : String(error)})`)
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

const parseLine = (name: string, line: string, lineNumber: number): Record<string, unknown> => {
  let row: unknown
  try {
    row = JSON.parse(line)
  } catch {
    throw new BundleInvalid('row-unreadable', `${name} line ${lineNumber} isn't JSON`)
  }
  if (!isRecord(row)) throw new BundleInvalid('row-unreadable', `${name} line ${lineNumber} isn't a row`)
  return row
}

const verifyBlocks = async (folder: BundleFolder, manifest: BundleManifest, signal?: AbortSignal): Promise<void> => {
  const name = BUNDLE_PARTS.blocks
  const ids = new Set<string>()
  let lines = 0
  const digest = await scanPart(await readPart(folder, name), line => {
    const row = parseLine(name, line, ++lines)
    if (row.workspace_id !== manifest.workspaceId) {
      throw new BundleInvalid('row-other-workspace', `${name} line ${lines} belongs to workspace ${String(row.workspace_id)}`)
    }
    if (typeof row.id !== 'string' || ids.has(row.id)) {
      throw new BundleInvalid('duplicate-row', `${name} line ${lines} repeats block ${String(row.id)}`)
    }
    ids.add(row.id)
    if (!SEALED_COLUMNS.every(column => typeof row[column] === 'string')) {
      throw new BundleInvalid('row-unreadable', `${name} line ${lines} has no content columns`)
    }
    // The file is plaintext by construction; a sealed row is a writer bug that
    // would leave that row unrecoverable once the key is lost.
    if (isSealedRow(row as Record<(typeof SEALED_COLUMNS)[number], string>)) {
      throw new BundleInvalid('sealed-row', `${name} line ${lines} holds sealed content`)
    }
  }, signal)
  requireDigest(name, manifest.parts[name], digest)
  if (lines !== manifest.parts[name].lines || lines !== manifest.serverBlockCount) {
    throw new BundleInvalid('row-count', `${name} has ${lines} rows; the server held ${manifest.serverBlockCount}`)
  }
}

const verifyHistory = async (folder: BundleFolder, manifest: BundleManifest, signal?: AbortSignal): Promise<void> => {
  const name = BUNDLE_PARTS.history
  let lines = 0
  let lastEventId = 0
  const digest = await scanPart(await readPart(folder, name), line => {
    const row = parseLine(name, line, ++lines)
    if (row.workspace_id !== manifest.workspaceId) {
      throw new BundleInvalid('row-other-workspace', `${name} line ${lines} belongs to workspace ${String(row.workspace_id)}`)
    }
    if (typeof row.event_id !== 'number' || row.event_id <= lastEventId) {
      throw new BundleInvalid('history-order', `${name} line ${lines} is out of event order`)
    }
    lastEventId = row.event_id
  }, signal)
  requireDigest(name, manifest.parts[name], digest)
  if (lines !== manifest.parts[name].lines) {
    throw new BundleInvalid('row-count', `${name} has ${lines} rows; the manifest says ${manifest.parts[name].lines}`)
  }
  // A workspace whose rows predate the history trigger has no history at all.
  if (lastEventId !== manifest.through) {
    throw new BundleInvalid('history-through', `${name} ends at event ${lastEventId}; the manifest says ${manifest.through}`)
  }
}

export const verifyBundle = async ({folder, workspaceId, manifestSha256, signal}: VerifyBundleOptions): Promise<VerifiedBundle> => {
  const manifestBytes = new Uint8Array(await (await readPart(folder, BUNDLE_PARTS.manifest)).arrayBuffer())
  const digest = sha256Hex(manifestBytes)
  if (manifestSha256 !== undefined && digest !== manifestSha256) {
    throw new BundleInvalid('manifest-changed', `${BUNDLE_PARTS.manifest} isn't the one this device recorded`)
  }
  const manifest = parseManifest(manifestBytes, workspaceId)
  await verifyBlocks(folder, manifest, signal)
  await verifyHistory(folder, manifest, signal)
  const localDb = BUNDLE_PARTS.localDb
  requireDigest(localDb, manifest.parts[localDb], await scanPart(await readPart(folder, localDb), undefined, signal))
  return {manifest, manifestSha256: digest}
}
