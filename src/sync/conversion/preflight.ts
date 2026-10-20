/**
 * Preflight (docs/workspace-e2ee-conversion.md §6.3 step 0): what must hold
 * before the flip, since nothing after it can be taken back. Ownership and the
 * plaintext mode are the run's stage read; the flip re-checks both.
 */

import { SEALED_COLUMNS } from '../transform.js'
import type { ConversionServer } from './conversionServer.js'
import type { UnrecoverableMedia } from './attachmentCleaner.js'
import {
  MediaBlocks,
  surveyAttachments,
  type AttachmentSource,
  type OversizedObject,
  type SurveyProgress,
} from './bundle/attachmentParts.js'
import type { ConversionAttachmentsIO } from './conversionAttachments.js'
import { encodeJsonlLine } from './bundle/bundleParts.js'
import { BUNDLE_PAGE_SIZE, blockRowPages, historyRowPages } from './bundle/takeBundle.js'
import { idsOf, isSealedRow } from './sealing.js'

export interface PreflightEnvironment {
  /** Mode pins persist (`canPersistPins`): the pin upgrade writes one. */
  readonly canPersistPins: () => boolean
  /** The key store outlives the page, rather than being the in-memory fallback. */
  readonly keyStoreIsDurable: boolean
  /** The recovery bundle is a folder written through `showDirectoryPicker`. */
  readonly supportsDirectoryPicker: boolean
  /** This device's upload queue, every workspace's: writes not uploaded yet,
   *  and uploads the server rejected that wait for Retry. A write held for any
   *  workspace stops this device's downloads, which the pin upgrade needs. */
  readonly uploadQueue: (signal?: AbortSignal) => Promise<{readonly pending: number; readonly rejected: number}>
  /** The size of this device's database, which the bundle copies whole. */
  readonly localDbBytes: () => Promise<number>
  /** What this site's storage can still take, or null when the browser can't
   *  say: preflight keeps there every attachment only Storage holds. */
  readonly freeLocalBytes: () => Promise<number | null>
}

export type PreflightBlocker =
  /** Plaintext rows the re-seal would count as sealed: after the flip they
   *  could not be told apart from sealed ones. */
  | {readonly kind: 'sealed-looking-rows'; readonly blockIds: readonly string[]}
  | {readonly kind: 'pending-uploads'; readonly count: number}
  /** Attachment uploads this device hasn't had confirmed. */
  | {readonly kind: 'pending-attachment-uploads'; readonly count: number}
  | {readonly kind: 'rejected-uploads'; readonly count: number}
  | {readonly kind: 'pins-not-durable'}
  | {readonly kind: 'key-store-not-durable'}
  | {readonly kind: 'no-directory-picker'}
  /** No room here for the attachments only Storage holds, which preflight keeps. */
  | {readonly kind: 'local-space'; readonly neededBytes: number; readonly freeBytes: number}

/** What the recovery bundle and the conversion will take, measured by a dry
 *  run of the bundle's own paging and line encoding. A bundle that can't be written after the
 *  flip leaves every device waiting until it is. */
export interface ConversionSizes {
  readonly blockRows: number
  /** `blocks.jsonl`, as the bundle writes it. */
  readonly blocksBytes: number
  readonly historyRows: number
  /** `server-history.jsonl`. */
  readonly historyBytes: number
  readonly localDbBytes: number
  /** `attachments/` and `other-objects/`. */
  readonly attachmentBytes: number
  /** The content columns' total: the server needs several times this free
   *  while it re-seals and keeps history of both versions (runbook step 6). */
  readonly contentBytes: number
}

/** What the user confirms before the flip. */
export interface PreflightReport {
  readonly sizes: ConversionSizes
  /** Objects whose sealed upload the limits would refuse: the user raises the
   *  limits before going on. */
  readonly oversized: readonly OversizedObject[]
  /** Media with no hash-verified copy anywhere, which no step after the flip
   *  can bring back. */
  readonly noVerifiedSource: readonly UnrecoverableMedia[]
}

export type PreflightOutcome =
  | {readonly kind: 'blocked'; readonly blockers: readonly PreflightBlocker[]}
  | {readonly kind: 'ready'; readonly report: PreflightReport}

/** Enough to show the user. */
const SEALED_LOOKING_SAMPLE = 20

const encoder = new TextEncoder()

/** The dry run of the bundle's own paging, in two halves: the blocks, which
 *  also finds sealed-looking rows and the media they carry, then the history.
 *  Every read is one bounded index scan by id, where a server-side filter over
 *  the whole workspace would hit the statement timeout on a large one. */
const scanBlocks = async (
  server: ConversionServer,
  workspaceId: string,
  attachments: AttachmentSource,
  signal?: AbortSignal,
) => {
  const sealedLooking: string[] = []
  const media = new MediaBlocks(attachments.mediaHashOf)
  let blockRows = 0
  let blocksBytes = 0
  let contentBytes = 0
  for await (const page of blockRowPages(server, workspaceId, BUNDLE_PAGE_SIZE, signal)) {
    for (const row of page) {
      blocksBytes += encodeJsonlLine(row).length
      for (const column of SEALED_COLUMNS) contentBytes += encoder.encode(row[column]).length
      media.add(row)
    }
    if (sealedLooking.length < SEALED_LOOKING_SAMPLE) sealedLooking.push(...idsOf(page.filter(isSealedRow)))
    blockRows += page.length
    // Blocked whatever the rest holds, and nothing measured is used then.
    if (sealedLooking.length >= SEALED_LOOKING_SAMPLE) break
  }
  return {sealedLooking: sealedLooking.slice(0, SEALED_LOOKING_SAMPLE), media, sizes: {blockRows, blocksBytes, contentBytes}}
}

const scanHistory = async (server: ConversionServer, workspaceId: string, signal?: AbortSignal) => {
  const {maxEventId} = await server.workspaceCounts(workspaceId)
  let historyRows = 0
  let historyBytes = 0
  for await (const page of historyRowPages(server, workspaceId, maxEventId, BUNDLE_PAGE_SIZE, signal)) {
    for (const row of page) historyBytes += encodeJsonlLine(row).length
    historyRows += page.length
  }
  return {historyRows, historyBytes}
}

/** The blockers this device can change on its own at any moment: checked in
 *  preflight, and again before every flip request. */
export const localBlockers = async (
  environment: PreflightEnvironment,
  attachments: Pick<ConversionAttachmentsIO, 'pendingUploads'>,
  signal?: AbortSignal,
): Promise<PreflightBlocker[]> => {
  const blockers: PreflightBlocker[] = []
  if (!environment.canPersistPins()) blockers.push({kind: 'pins-not-durable'})
  if (!environment.keyStoreIsDurable) blockers.push({kind: 'key-store-not-durable'})
  if (!environment.supportsDirectoryPicker) blockers.push({kind: 'no-directory-picker'})

  const queue = await environment.uploadQueue(signal)
  if (queue.pending > 0) blockers.push({kind: 'pending-uploads', count: queue.pending})
  if (queue.rejected > 0) blockers.push({kind: 'rejected-uploads', count: queue.rejected})
  const attachmentUploads = await attachments.pendingUploads()
  if (attachmentUploads > 0) blockers.push({kind: 'pending-attachment-uploads', count: attachmentUploads})
  return blockers
}

/** Room left for the database to grow while the conversion runs (the pin
 *  upgrade rewrites every row's version). */
const LOCAL_HEADROOM_BYTES = 512 * 1024 * 1024

export const runPreflight = async ({
  server,
  workspaceId,
  environment,
  attachments,
  signal,
  onProgress,
}: {
  readonly server: ConversionServer
  readonly workspaceId: string
  readonly environment: PreflightEnvironment
  readonly attachments: ConversionAttachmentsIO
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: SurveyProgress) => void
}): Promise<PreflightOutcome> => {
  const blockers = await localBlockers(environment, attachments, signal)
  // Before the scan, which reads every row of the workspace: these the user
  // can fix in moments.
  if (blockers.length > 0) return {kind: 'blocked', blockers}
  const blocks = await scanBlocks(server, workspaceId, attachments, signal)
  // Before the history, which can be the larger read.
  if (blocks.sealedLooking.length > 0) return {kind: 'blocked', blockers: [{kind: 'sealed-looking-rows', blockIds: blocks.sealedLooking}]}
  const history = await scanHistory(server, workspaceId, signal)
  const free = await environment.freeLocalBytes()
  const keepBudget = free === null ? null : free - LOCAL_HEADROOM_BYTES
  const survey = await surveyAttachments({source: attachments, mediaHashes: blocks.media.hashes(), keepBudget, signal, onProgress})
  if (survey.unkeptBytes > 0) {
    const neededBytes = survey.unkeptBytes - survey.spareBytes
    return {kind: 'blocked', blockers: [{kind: 'local-space', neededBytes, freeBytes: Math.max(0, survey.spareBytes)}]}
  }
  return {
    kind: 'ready',
    report: {
      sizes: {...blocks.sizes, ...history, localDbBytes: await environment.localDbBytes(), attachmentBytes: survey.bundleBytes},
      oversized: survey.oversized,
      noVerifiedSource: blocks.media.blocksOf(survey.noVerifiedSource),
    },
  }
}
