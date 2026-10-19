/**
 * Preflight (docs/workspace-e2ee-conversion.md §6.3 step 0): what must hold
 * before the flip, since nothing after it can be taken back. Ownership and the
 * plaintext mode are the run's stage read; the flip re-checks both.
 */

import type { ConversionServer } from './conversionServer.js'
import { idsOf, isSealedRow, RESEAL_PAGE_SIZE, serverPages } from './sealing.js'

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
}

export type PreflightBlocker =
  /** Plaintext rows the re-seal would count as sealed: after the flip they
   *  could not be told apart from sealed ones. */
  | {readonly kind: 'sealed-looking-rows'; readonly blockIds: readonly string[]}
  | {readonly kind: 'pending-uploads'; readonly count: number}
  | {readonly kind: 'rejected-uploads'; readonly count: number}
  | {readonly kind: 'pins-not-durable'}
  | {readonly kind: 'key-store-not-durable'}
  | {readonly kind: 'no-directory-picker'}

export interface PreflightReport {
  readonly blockers: readonly PreflightBlocker[]
}

/** Enough to show the user; the scan stops once it has this many. */
const SEALED_LOOKING_SAMPLE = 20

/** Pages every row by id, as the re-seal does: each read is one bounded index
 *  scan, where a server-side filter would walk the whole workspace in one
 *  statement and hit the statement timeout on a large one. */
const sealedLookingRows = async (
  server: ConversionServer,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const found: string[] = []
  for await (const page of serverPages(server, workspaceId, RESEAL_PAGE_SIZE, signal)) {
    found.push(...idsOf(page.filter(isSealedRow)))
    if (found.length >= SEALED_LOOKING_SAMPLE) break
  }
  return found.slice(0, SEALED_LOOKING_SAMPLE)
}

export const runPreflight = async ({
  server,
  workspaceId,
  environment,
  signal,
}: {
  readonly server: ConversionServer
  readonly workspaceId: string
  readonly environment: PreflightEnvironment
  readonly signal?: AbortSignal
}): Promise<PreflightReport> => {
  const blockers: PreflightBlocker[] = []
  if (!environment.canPersistPins()) blockers.push({kind: 'pins-not-durable'})
  if (!environment.keyStoreIsDurable) blockers.push({kind: 'key-store-not-durable'})
  if (!environment.supportsDirectoryPicker) blockers.push({kind: 'no-directory-picker'})

  const queue = await environment.uploadQueue(signal)
  if (queue.pending > 0) blockers.push({kind: 'pending-uploads', count: queue.pending})
  if (queue.rejected > 0) blockers.push({kind: 'rejected-uploads', count: queue.rejected})

  const sealedLooking = await sealedLookingRows(server, workspaceId, signal)
  if (sealedLooking.length > 0) blockers.push({kind: 'sealed-looking-rows', blockIds: sealedLooking})

  return {blockers}
}
