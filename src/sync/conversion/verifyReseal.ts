/**
 * Verify (docs/workspace-e2ee-conversion.md §6.3 step 5). Check every row on
 * the server against the server's own record of its re-seal, and re-send any
 * row that differs from it. The record lives in `blocks_history` until the
 * purge, so a crash between a row's commit and this pass loses nothing.
 */

import { SEALED_COLUMNS } from '../transform.js'
import type { ConversionServer, ServerBlockRow, ServerHistoryRow } from './conversionServer.js'
import {
  ConversionRefusal,
  idsOf,
  isSealedRow,
  isSealedValue,
  opensTo,
  RESEAL_PAGE_SIZE,
  requireE2eeOnServer,
  sealAndSend,
  serverPages,
  type ContentColumns,
} from './sealing.js'

/** Every column a re-seal write changes: the three it sends, and the version
 *  the clamp trigger bumps. */
const RESEAL_WRITE_COLUMNS: ReadonlySet<string> = new Set([...SEALED_COLUMNS, 'updated_at'])

/** The plaintext a history row sealed, if it has the shape of a re-seal write:
 *  an UPDATE (the only op with both diffs) that changed only the re-seal's
 *  columns and took every content column from plaintext to an envelope.
 *  Matching the columns as well as the values makes a sealing write from any
 *  other path read as no record, so the run refuses rather than re-sending
 *  over it. */
export const sealRecordOf = (history: ServerHistoryRow): ContentColumns | null => {
  const {before_diff: before, after_diff: after} = history
  if (!before || !after) return null
  if (!Object.keys(after).every(column => RESEAL_WRITE_COLUMNS.has(column))) return null
  const plaintext: Partial<Record<keyof ContentColumns, string>> = {}
  for (const column of SEALED_COLUMNS) {
    const was = before[column]
    const now = after[column]
    if (typeof was !== 'string' || typeof now !== 'string') return null
    if (isSealedValue(was) || !isSealedValue(now)) return null
    plaintext[column] = was
  }
  return plaintext as ContentColumns
}

/** Each block's record: its last history row shaped like a re-seal write. It is
 *  found by content rather than by position, so a re-taken bundle doesn't move
 *  it. Last, not first: once the flip refuses plaintext writes a row can be
 *  sealed from plaintext only once, so an earlier such row predates the flip
 *  and was written by something else. */
const sealRecords = (history: readonly ServerHistoryRow[]): Map<string, ContentColumns> => {
  const records = new Map<string, ContentColumns>()
  for (const row of [...history].sort((a, b) => a.event_id - b.event_id)) {
    const plaintext = sealRecordOf(row)
    if (plaintext) records.set(row.block_id, plaintext)
  }
  return records
}

const differingFrom = async (
  rows: readonly ServerBlockRow[],
  records: ReadonlyMap<string, ContentColumns>,
  wk: CryptoKey,
): Promise<ServerBlockRow[]> => {
  const matches = await Promise.all(rows.map(row => opensTo(wk, row, row, records.get(row.id)!)))
  return rows.filter((_, i) => !matches[i])
}

export interface VerifyProgress {
  readonly checked: number
  readonly repaired: number
}

export interface VerifyOptions {
  readonly server: ConversionServer
  readonly workspaceId: string
  /** The workspace key, already checked against the server canary. */
  readonly wk: CryptoKey
  readonly pageSize?: number
  readonly onProgress?: (progress: VerifyProgress) => void
  readonly signal?: AbortSignal
}

export const verifyReseal = async ({
  server,
  workspaceId,
  wk,
  pageSize = RESEAL_PAGE_SIZE,
  onProgress,
  signal,
}: VerifyOptions): Promise<VerifyProgress> => {
  await requireE2eeOnServer(server, workspaceId)
  let checked = 0
  let repaired = 0
  for await (const page of serverPages(server, workspaceId, pageSize, signal)) {
    const unsealed = page.filter(row => !isSealedRow(row))
    if (unsealed.length > 0) throw new ConversionRefusal('unsealed', idsOf(unsealed))

    const records = sealRecords(await server.readContentSealHistory(workspaceId, idsOf(page)))
    const unrecorded = page.filter(row => !records.has(row.id))
    if (unrecorded.length > 0) throw new ConversionRefusal('no-record', idsOf(unrecorded))

    // A value that opens can still be wrong, such as another row's value, so
    // every column is compared, not just opened.
    const differing = await differingFrom(page, records, wk)
    if (differing.length > 0) {
      await sealAndSend(server, workspaceId, differing.map(row => ({row, plaintext: records.get(row.id)!})), wk)
      const stillDiffering = await differingFrom(await server.readBlocks(workspaceId, idsOf(differing)), records, wk)
      if (stillDiffering.length > 0) throw new ConversionRefusal('unrepaired', idsOf(stillDiffering))
    }

    checked += page.length
    repaired += differing.length
    onProgress?.({checked, repaired})
  }
  return {checked, repaired}
}
