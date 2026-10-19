/**
 * Re-seal (docs/workspace-e2ee-conversion.md §6.3 step 4). Page through a
 * workspace's rows on the server and seal the content columns of every row its
 * plaintext source supplies, sending each page through `apply_block_patches`.
 * It keeps no state between runs: resuming just runs it again.
 */

import type { ConversionServer, ServerBlockRow } from './conversionServer.js'
import {
  contentColumnsOf,
  isSealedRow,
  RESEAL_PAGE_SIZE,
  requireWorkspaceKey,
  sealAndSend,
  serverPages,
  type ContentColumns,
  type SealTarget,
} from './sealing.js'

/** The plaintext to seal for one page of server rows, by row id. A row with no
 *  entry is left as it is, and a sent row's base version is always the server
 *  row's. Conversion seals a row from its own value; key-loss recovery (#1302)
 *  supplies a recovery point's. */
export type PlaintextSource = (page: readonly ServerBlockRow[]) => Promise<ReadonlyMap<string, ContentColumns>>

/** Conversion's source: every row the server holds unsealed, as it holds it. */
export const unsealedServerRows: PlaintextSource = async page =>
  new Map(page.filter(row => !isSealedRow(row)).map(row => [row.id, contentColumnsOf(row)]))

export interface ResealProgress {
  readonly scanned: number
  readonly sealed: number
}

export interface ResealOptions {
  readonly server: ConversionServer
  readonly workspaceId: string
  /** The workspace key: the run refuses one that doesn't open the server canary. */
  readonly wk: CryptoKey
  readonly source?: PlaintextSource
  readonly pageSize?: number
  readonly onProgress?: (progress: ResealProgress) => void
  readonly signal?: AbortSignal
}

export const resealWorkspace = async ({
  server,
  workspaceId,
  wk,
  source = unsealedServerRows,
  pageSize = RESEAL_PAGE_SIZE,
  onProgress,
  signal,
}: ResealOptions): Promise<ResealProgress> => {
  await requireWorkspaceKey(server, workspaceId, wk)
  let scanned = 0
  let sealed = 0
  for await (const page of serverPages(server, workspaceId, pageSize, signal)) {
    const plaintext = await source(page)
    const targets = page.flatMap((row): SealTarget[] => {
      const columns = plaintext.get(row.id)
      return columns ? [{row, plaintext: columns}] : []
    })
    await sealAndSend(server, workspaceId, targets, wk)
    scanned += page.length
    sealed += targets.length
    onProgress?.({scanned, sealed})
  }
  return {scanned, sealed}
}
