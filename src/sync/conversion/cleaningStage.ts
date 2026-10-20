/**
 * The `cleaning` stage past the pin upgrade (docs/workspace-e2ee-conversion.md
 * §6.3 step 8): the attachment cleaner, run with the recovery bundle, until its
 * proof passes and the user has seen everything it left behind. The run then
 * calls `finish_conversion`. Every step is safe to run again; the stage keeps
 * no state the server and the bundle record don't.
 */

import { objectKeysOf, type WorkspaceKeyRecord } from '../keys/keyStore.js'
import {
  attachmentCleanerLockName,
  cleanAttachments,
  type CleanerProgress,
  type CleanerReport,
  type ConversionBundle,
  type LeftReason,
  type UnrecoverableMedia,
} from './attachmentCleaner.js'
import { ATTACHMENTS_DIR, OTHER_OBJECTS_DIR, otherObjectNameOf, rawNameOf } from './bundle/attachmentParts.js'
import { untilStopped } from '@/utils/untilStopped.js'
import { stoppableFolder, type BundleFolder } from './bundle/bundleParts.js'
import { bundleRecordOf, type BundleRecord, type BundleRecordStore } from './bundle/bundleRecord.js'
import { BundleInvalid, checkManifest, verifyBundle } from './bundle/verifyBundle.js'
import type { ConversionAttachmentsIO } from './conversionAttachments.js'
import type { ConversionLock } from './runLock.js'
import { reopenRecordedFolder, withScreenAwake, type BundlePrompts } from './sealingStage.js'

export interface FinishPrompt {
  /** Media whose bytes exist nowhere. */
  readonly unrecoverable: readonly UnrecoverableMedia[]
  /** Objects the cleaner kept and reported, with why. */
  readonly left: CleanerReport['left']
  /** Sealed uploads Storage refused. */
  readonly refused: CleanerReport['refused']
  /** False when the user went on without the bundle folder this run. */
  readonly bundleRead: boolean
}

export interface CleaningPrompts extends Pick<BundlePrompts, 'reopenBundleFolder'> {
  /** This device has no record of the bundle (another device took it): resolve
   *  with the folder the user picks. `problem`: why the last pick didn't do. */
  chooseExistingBundle(prompt: {readonly problem: string | null}): Promise<BundleFolder>
  /** The proof passed: the user confirms finishing with what is left. */
  confirmFinish(prompt: FinishPrompt): Promise<void>
}

export type CleaningStatus =
  | {readonly kind: 'cleaning'; readonly progress: CleanerProgress | null}
  | {readonly kind: 'finishing'}

export interface CleaningDeps {
  readonly userId: string
  readonly workspaceId: string
  readonly bundles: BundleRecordStore
  readonly attachments: ConversionAttachmentsIO
  readonly canReadFolder: (folder: BundleFolder) => Promise<boolean>
  readonly keepAwake: () => Promise<() => void>
  /** The cleaner's own lock, which the owner's "Clean up attachments" holds too. */
  readonly lock: ConversionLock
  readonly ui: CleaningPrompts & {status(status: CleaningStatus | {readonly kind: 'checking-bundle'}): void}
  readonly signal?: AbortSignal
}

export type CleaningPass =
  /** The proof passed and the user confirmed what is left: the conversion can finish. */
  | {readonly kind: 'proved'}
  /** The proof didn't pass; the report says what holds it back. */
  | {readonly kind: 'not-proved'; readonly report: CleanerReport}
  /** A "Clean up attachments" run holds the cleaner. */
  | {readonly kind: 'busy'}

/** Picks and verifies the bundle another device took. Its server history is
 *  gone, so only the folder's own consistency can be checked. Accepted: an
 *  earlier take of this workspace verifies too, since the server keeps nothing
 *  to tell them apart; the cleaner still deletes only what its entry holds byte
 *  for byte. */
const adoptBundle = async (deps: CleaningDeps): Promise<BundleRecord> => {
  const {userId, workspaceId, ui, signal} = deps
  for (let problem: string | null = null; ;) {
    const folder = await ui.chooseExistingBundle({problem})
    try {
      ui.status({kind: 'checking-bundle'})
      const verified = await withScreenAwake(deps, () =>
        verifyBundle({folder, workspaceId, mediaHashOf: deps.attachments.mediaHashOf, signal}))
      const record = bundleRecordOf(verified, folder)
      await deps.bundles.put(userId, workspaceId, record)
      return record
    } catch (error) {
      if (!(error instanceof BundleInvalid)) throw error
      problem = error.message
    }
  }
}

/** The record's bundle folder, holding the very bundle the record vouches for,
 *  or null when the user goes on without it. A pick that holds another bundle,
 *  or none, is asked for again before the cleaner reads anything from it. */
const bundleFolder = async (deps: CleaningDeps, record: BundleRecord, problem: string | null): Promise<BundleFolder | null> => {
  for (;;) {
    const folder = await reopenRecordedFolder(deps, record, problem, 'cleanup')
    if (!folder) return null
    try {
      await checkManifest(folder, record.manifestSha256, deps.signal)
      return folder
    } catch (error) {
      if (!(error instanceof BundleInvalid)) throw error
      problem = `That folder doesn't hold this conversion's recovery bundle: ${error.message}.`
    }
  }
}

/** An entry, or null when the folder holds none; throws when the folder
 *  itself can't be read, or the user went on without it, which the cleaner
 *  reports as unreadable. */
const readEntry = async (
  folder: BundleFolder | null,
  dir: string,
  name: string,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | null> => {
  if (!folder) throw new Error('conversion: the user went on without the recovery bundle')
  const entries = await folder.getDirectoryHandle(dir)
  let file
  try {
    file = await entries.getFileHandle(name)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null
    throw error
  }
  return new Uint8Array(await untilStopped((await file.getFile()).arrayBuffer(), signal))
}

/** The bundle as the cleaner reads it: the record's lists, the folder's bytes.
 *  Without a folder the lists still hold, so what the bundle archived stays and
 *  holds the proof back. */
export const conversionBundleOf = (record: BundleRecord, folder: BundleFolder | null, signal?: AbortSignal): ConversionBundle => {
  const target = folder && stoppableFolder(folder, signal)
  return {
    archivedPaths: new Set(record.otherObjectPaths),
    noVerifiedSource: new Set(record.noVerifiedSource),
    readArchivedObject: path => readEntry(target, OTHER_OBJECTS_DIR, otherObjectNameOf(path), signal),
    readAttachment: contentHash => readEntry(target, ATTACHMENTS_DIR, rawNameOf(contentHash), signal),
  }
}

/** What a pass found wrong with the bundle folder, which another pick may fix. */
const BUNDLE_FAULT: Partial<Record<LeftReason, string>> = {
  'bundle-unreadable': 'The recovery bundle folder could not be read.',
  'archive-mismatch': "Some of the recovery bundle's copies are missing, or differ from the objects on the server. If you have an intact copy of the bundle, choose it.",
}
/** Cleaner passes per run after the first, each over a folder the user
 *  re-picked after a {@link BUNDLE_FAULT}: a pass downloads every attachment. */
const MAX_REPICKS = 2

export const runCleaningPass = async (
  deps: CleaningDeps,
  key: WorkspaceKeyRecord,
  canary: string,
): Promise<CleaningPass> => {
  const {userId, workspaceId, ui, signal} = deps
  const keys = objectKeysOf(key)
  if (!keys) throw new Error('conversion: the workspace key on this device has no K_id')
  let record = (await deps.bundles.get(userId, workspaceId)) ?? (await adoptBundle(deps))

  let report: CleanerReport | null = null
  for (let repicks = 0, problem: string | null = null; ; repicks++) {
    const folder = await bundleFolder(deps, record, problem)
    // Declined after a pass: another one without the bundle would change nothing.
    if (folder === null && report) return {kind: 'not-proved', report}
    if (folder && folder !== record.folder) {
      record = {...record, folder}
      await deps.bundles.put(userId, workspaceId, record)
    }
    ui.status({kind: 'cleaning', progress: null})
    const bundle = conversionBundleOf(record, folder, signal)
    const result = await withScreenAwake(deps, () =>
      deps.lock(attachmentCleanerLockName(userId, workspaceId), () => cleanAttachments({
        workspaceId,
        io: deps.attachments,
        keys,
        canary,
        bundle,
        signal,
        onProgress: progress => ui.status({kind: 'cleaning', progress}),
      })))
    if (!result.acquired) return {kind: 'busy'}
    report = result.value
    if (report.proof.kind === 'passed') {
      // Nothing left behind is silent: every unrecoverable block, and every
      // object the cleaner kept and reported, before the conversion is done.
      await ui.confirmFinish({
        unrecoverable: report.proof.unrecoverable,
        left: report.left,
        refused: report.refused,
        bundleRead: folder !== null,
      })
      return {kind: 'proved'}
    }
    const fault = report.left.map(item => BUNDLE_FAULT[item.reason]).find(message => message !== undefined)
    if (fault === undefined || folder === null || repicks >= MAX_REPICKS) return {kind: 'not-proved', report}
    problem = fault
  }
}
