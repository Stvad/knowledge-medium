/**
 * Preflight (docs/workspace-e2ee-conversion.md §6.3 step 0): what must hold
 * before the flip, since nothing after it can be taken back. Ownership and the
 * plaintext mode are the run's stage read; the flip re-checks both.
 */

import { SEALED_COLUMNS } from '../transform.js'
import type { ConversionServer } from './conversionServer.js'
import { idsOf, isSealedRow, RESEAL_PAGE_SIZE } from './sealing.js'

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
  | {readonly kind: 'rejected-uploads'; readonly count: number}
  | {readonly kind: 'pins-not-durable'}
  | {readonly kind: 'key-store-not-durable'}
  | {readonly kind: 'no-directory-picker'}

/** What the recovery bundle and the conversion will take, measured by a dry
 *  run of the bundle's own paging. A bundle that can't be written after the
 *  flip leaves every device waiting until it is. */
export interface ConversionSizes {
  readonly blockRows: number
  /** `blocks.jsonl`, as the bundle writes it. */
  readonly blocksBytes: number
  readonly historyRows: number
  /** `server-history.jsonl`. */
  readonly historyBytes: number
  readonly localDbBytes: number
  /** The content columns' total: the server needs several times this free
   *  while it re-seals and keeps history of both versions (runbook step 6). */
  readonly contentBytes: number
}

export interface PreflightReport {
  readonly blockers: readonly PreflightBlocker[]
  readonly sizes: ConversionSizes
}

/** Enough to show the user. */
const SEALED_LOOKING_SAMPLE = 20

const encoder = new TextEncoder()
/** One `.jsonl` line, as the bundle writes it. */
const lineBytes = (row: unknown): number => encoder.encode(JSON.stringify(row)).length + 1

/** The dry run, which also finds sealed-looking rows. Every read is one
 *  bounded index scan by id, where a server-side filter over the whole
 *  workspace would hit the statement timeout on a large one. */
const scanServer = async (server: ConversionServer, workspaceId: string, signal?: AbortSignal) => {
  const sealedLooking: string[] = []
  let blockRows = 0
  let blocksBytes = 0
  let contentBytes = 0
  for (let afterId: string | null = null; ;) {
    signal?.throwIfAborted()
    const page = await server.readFullBlockPage(workspaceId, afterId, RESEAL_PAGE_SIZE)
    if (page.length === 0) break
    for (const row of page) {
      blocksBytes += lineBytes(row)
      for (const column of SEALED_COLUMNS) contentBytes += encoder.encode(row[column]).length
    }
    if (sealedLooking.length < SEALED_LOOKING_SAMPLE) sealedLooking.push(...idsOf(page.filter(isSealedRow)))
    blockRows += page.length
    afterId = page[page.length - 1].id
  }

  const {maxEventId} = await server.historyBounds(workspaceId)
  let historyRows = 0
  let historyBytes = 0
  for (let afterEventId = 0; afterEventId < maxEventId;) {
    signal?.throwIfAborted()
    const page = await server.readHistoryPage(workspaceId, afterEventId, maxEventId, RESEAL_PAGE_SIZE)
    if (page.length === 0) break
    for (const row of page) historyBytes += lineBytes(row)
    historyRows += page.length
    afterEventId = page[page.length - 1].event_id
  }
  return {
    sealedLooking: sealedLooking.slice(0, SEALED_LOOKING_SAMPLE),
    sizes: {blockRows, blocksBytes, historyRows, historyBytes, contentBytes},
  }
}

/** The blockers this device can change on its own at any moment: checked in
 *  preflight, and again right before the flip, since the prompts in between
 *  can stay open indefinitely. */
export const localBlockers = async (
  environment: PreflightEnvironment,
  signal?: AbortSignal,
): Promise<PreflightBlocker[]> => {
  const blockers: PreflightBlocker[] = []
  if (!environment.canPersistPins()) blockers.push({kind: 'pins-not-durable'})
  if (!environment.keyStoreIsDurable) blockers.push({kind: 'key-store-not-durable'})
  if (!environment.supportsDirectoryPicker) blockers.push({kind: 'no-directory-picker'})

  const queue = await environment.uploadQueue(signal)
  if (queue.pending > 0) blockers.push({kind: 'pending-uploads', count: queue.pending})
  if (queue.rejected > 0) blockers.push({kind: 'rejected-uploads', count: queue.rejected})
  return blockers
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
  const blockers = await localBlockers(environment, signal)
  const scan = await scanServer(server, workspaceId, signal)
  if (scan.sealedLooking.length > 0) blockers.push({kind: 'sealed-looking-rows', blockIds: scan.sealedLooking})
  return {blockers, sizes: {...scan.sizes, localDbBytes: await environment.localDbBytes()}}
}
