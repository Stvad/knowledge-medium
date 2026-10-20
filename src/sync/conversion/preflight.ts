/**
 * Preflight (docs/workspace-e2ee-conversion.md §6.3 step 0): what must hold
 * before the flip, since nothing after it can be taken back. Ownership and the
 * plaintext mode are the run's stage read; the flip re-checks both.
 */

import { SEALED_COLUMNS } from '../transform.js'
import type { ConversionServer } from './conversionServer.js'
import type { AttachmentCleanerIO, UnrecoverableMedia } from './attachmentCleaner.js'
import { MediaBlocks, surveyAttachments, type AttachmentSource, type OversizedObject } from './bundle/attachmentParts.js'
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

/** The dry run of the bundle's own paging, which also finds sealed-looking
 *  rows. Every read is one bounded index scan by id, where a server-side
 *  filter over the whole workspace would hit the statement timeout on a large
 *  one. */
const scanServer = async (
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
  }

  const {maxEventId} = await server.workspaceCounts(workspaceId)
  let historyRows = 0
  let historyBytes = 0
  for await (const page of historyRowPages(server, workspaceId, maxEventId, BUNDLE_PAGE_SIZE, signal)) {
    for (const row of page) historyBytes += encodeJsonlLine(row).length
    historyRows += page.length
  }
  return {
    sealedLooking: sealedLooking.slice(0, SEALED_LOOKING_SAMPLE),
    media,
    sizes: {blockRows, blocksBytes, historyRows, historyBytes, contentBytes},
  }
}

/** The blockers this device can change on its own at any moment: checked in
 *  preflight, and again right before the flip, since the prompts in between
 *  can stay open indefinitely. */
export const localBlockers = async (
  environment: PreflightEnvironment,
  attachments: Pick<AttachmentCleanerIO, 'pendingUploads'>,
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

export const runPreflight = async ({
  server,
  workspaceId,
  environment,
  attachments,
  signal,
}: {
  readonly server: ConversionServer
  readonly workspaceId: string
  readonly environment: PreflightEnvironment
  readonly attachments: AttachmentCleanerIO
  readonly signal?: AbortSignal
}): Promise<PreflightOutcome> => {
  const blockers = await localBlockers(environment, attachments, signal)
  const scan = await scanServer(server, workspaceId, attachments, signal)
  if (scan.sealedLooking.length > 0) blockers.push({kind: 'sealed-looking-rows', blockIds: scan.sealedLooking})
  // Before the survey, which downloads every attachment only Storage holds.
  if (blockers.length > 0) return {kind: 'blocked', blockers}
  // A copy only Storage holds is kept here once verified: Storage could
  // change it after the flip.
  const survey = await surveyAttachments({source: attachments, mediaHashes: scan.media.hashes(), preflight: true, signal})
  return {
    kind: 'ready',
    report: {
      sizes: {
        ...scan.sizes,
        localDbBytes: await environment.localDbBytes(),
        attachmentBytes: survey.mediaBytes + survey.otherBytes,
      },
      oversized: survey.oversized,
      noVerifiedSource: scan.media.blocksOf(survey.noVerifiedSource),
    },
  }
}
