/**
 * The `cleaning` stage past the pin upgrade (docs/workspace-e2ee-conversion.md
 * §6.3 steps 8–9): the attachment cleaner, run with the recovery bundle, then
 * `finish_conversion` once its proof passes and the user has seen everything
 * it left behind. Every step is safe to run again; the stage keeps no state
 * the server and the bundle record don't.
 */

import type { WorkspaceKeyRecord } from '../keys/keyStore.js'
import {
  attachmentCleanerLockName,
  cleanAttachments,
  type AttachmentCleanerIO,
  type CleanerProgress,
  type CleanerReport,
  type ConversionBundle,
  type LeftReason,
  type ObjectPath,
  type UnrecoverableMedia,
} from './attachmentCleaner.js'
import { ATTACHMENTS_DIR, OTHER_OBJECTS_DIR, rawNameOf } from './bundle/attachmentParts.js'
import { bundleFolderIn, sha256Hex, type BundleFolder } from './bundle/bundleParts.js'
import { bundleRecordOf, type BundleRecord, type BundleRecordStore } from './bundle/bundleRecord.js'
import { BundleInvalid, verifyBundle } from './bundle/verifyBundle.js'
import type { ConversionServer } from './conversionServer.js'
import type { ConversionLock } from './runLock.js'
import type { ReopenBundlePrompt } from './sealingStage.js'

export interface FinishPrompt {
  /** Media whose bytes exist nowhere. */
  readonly unrecoverable: readonly UnrecoverableMedia[]
  /** Objects the cleaner kept and reported, with why. */
  readonly left: CleanerReport['left']
  /** Sealed uploads Storage refused. */
  readonly refused: CleanerReport['refused']
}

export interface CleaningPrompts {
  /** This device has no record of the bundle (another device took it): resolve
   *  with the folder the user picks. `problem`: why the last pick didn't do. */
  chooseExistingBundle(prompt: {readonly problem: string | null}): Promise<BundleFolder>
  /** Resolve with the bundle's folder readable again, as for the purge. */
  reopenBundleFolder(prompt: ReopenBundlePrompt): Promise<BundleFolder | null>
  /** The proof passed: the user confirms finishing with what is left. */
  confirmFinish(prompt: FinishPrompt): Promise<void>
}

export type CleaningStatus =
  | {readonly kind: 'cleaning'; readonly progress: CleanerProgress | null}
  | {readonly kind: 'finishing'}

export interface CleaningDeps {
  readonly userId: string
  readonly workspaceId: string
  readonly server: ConversionServer
  readonly bundles: BundleRecordStore
  readonly attachments: AttachmentCleanerIO
  readonly canReadFolder: (folder: BundleFolder) => Promise<boolean>
  readonly keepAwake: () => Promise<() => void>
  /** The cleaner's own lock, which the owner's "Clean up attachments" holds too. */
  readonly lock: ConversionLock
  readonly ui: CleaningPrompts & {status(status: CleaningStatus): void}
  readonly signal?: AbortSignal
}

export type CleaningPass =
  | {readonly kind: 'finished'}
  /** The proof didn't pass; the report says what holds it back. */
  | {readonly kind: 'not-proved'; readonly report: CleanerReport}
  /** A "Clean up attachments" run holds the cleaner. */
  | {readonly kind: 'busy'}

/** Picks and verifies the bundle another device took. Its server history is
 *  gone, so only the folder's own consistency can be checked. */
const adoptBundle = async (deps: CleaningDeps): Promise<BundleRecord> => {
  const {userId, workspaceId, ui, signal} = deps
  for (let problem: string | null = null; ;) {
    const folder = await ui.chooseExistingBundle({problem})
    try {
      const record = bundleRecordOf(await verifyBundle({folder, workspaceId, mediaHashOf: deps.attachments.mediaHashOf, signal}), folder)
      await deps.bundles.put(userId, workspaceId, record)
      return record
    } catch (error) {
      if (!(error instanceof BundleInvalid)) throw error
      problem = error.message
    }
  }
}

/** The recorded folder, readable now: asking for access again, or for the
 *  folder if it moved. Null when the user would rather go on without it. A
 *  wrong pick needs no check here: the cleaner deletes an archived object only
 *  once the folder's entry holds its bytes. */
const readableFolder = async (deps: CleaningDeps, record: BundleRecord, problem: string | null): Promise<BundleFolder | null> => {
  if (problem === null && (await deps.canReadFolder(record.folder))) return record.folder
  const picked = await deps.ui.reopenBundleFolder({recorded: record.folder, problem, purpose: 'cleanup'})
  return picked && picked !== record.folder ? bundleFolderIn(picked, record.folder.name) : picked
}

const encoder = new TextEncoder()

/** An entry, or null when the folder holds none; throws when the folder
 *  itself can't be read, or the user went on without it, which the cleaner
 *  reports as unreadable. */
const readEntry = async (folder: BundleFolder | null, dir: string, name: string): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (!folder) throw new Error('conversion: the user went on without the recovery bundle')
  const entries = await folder.getDirectoryHandle(dir)
  let file
  try {
    file = await entries.getFileHandle(name)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null
    throw error
  }
  return new Uint8Array(await (await file.getFile()).arrayBuffer())
}

/** The bundle as the cleaner reads it: the record's lists, the folder's bytes.
 *  Without a folder the lists still hold, so what the bundle archived stays and
 *  holds the proof back. */
export const conversionBundleOf = (record: BundleRecord, folder: BundleFolder | null): ConversionBundle => ({
  archivedPaths: new Set<ObjectPath>(record.otherObjectPaths),
  noVerifiedSource: new Set(record.noVerifiedSource),
  readArchivedObject: path => readEntry(folder, OTHER_OBJECTS_DIR, sha256Hex(encoder.encode(path))),
  readAttachment: contentHash => readEntry(folder, ATTACHMENTS_DIR, rawNameOf(contentHash)),
})

const BUNDLE_UNREADABLE: LeftReason = 'bundle-unreadable'
/** Re-picks of an unreadable bundle folder per pass. */
const MAX_FOLDER_ASKS = 2

export const runCleaningPass = async (
  deps: CleaningDeps,
  key: WorkspaceKeyRecord,
  canary: string,
): Promise<CleaningPass> => {
  const {userId, workspaceId, ui, signal} = deps
  if (!key.contentKeyHmac) throw new Error('conversion: the workspace key on this device has no K_id')
  const keys = {cek: key.wk, contentKeyHmac: key.contentKeyHmac}
  let record = (await deps.bundles.get(userId, workspaceId)) ?? (await adoptBundle(deps))

  let report: CleanerReport
  for (let asks = 0, problem: string | null = null; ; asks++) {
    // Null: the user goes on without the bundle, and what it archived stays.
    const folder = await readableFolder(deps, record, problem)
    if (folder && folder !== record.folder) {
      record = {...record, folder}
      await deps.bundles.put(userId, workspaceId, record)
    }
    const release = await deps.keepAwake()
    let result
    try {
      ui.status({kind: 'cleaning', progress: null})
      const bundle = conversionBundleOf(record, folder)
      result = await deps.lock(attachmentCleanerLockName(userId, workspaceId), () => cleanAttachments({
        workspaceId,
        io: deps.attachments,
        keys,
        canary,
        bundle,
        signal,
        onProgress: progress => ui.status({kind: 'cleaning', progress}),
      }))
    } finally {
      release()
    }
    if (!result.acquired) return {kind: 'busy'}
    report = result.value
    if (report.proof.kind === 'passed') break
    const unreadable = report.left.some(item => item.reason === BUNDLE_UNREADABLE)
    if (!unreadable || folder === null || asks >= MAX_FOLDER_ASKS) return {kind: 'not-proved', report}
    problem = 'The recovery bundle folder could not be read.'
  }

  if (report.proof.kind !== 'passed') return {kind: 'not-proved', report}
  // Nothing left behind is silent: every unrecoverable block, and every object
  // the cleaner kept and reported, before the conversion is declared done.
  await ui.confirmFinish({unrecoverable: report.proof.unrecoverable, left: report.left, refused: report.refused})
  ui.status({kind: 'finishing'})
  await deps.server.finishConversion(workspaceId)
  return {kind: 'finished'}
}
