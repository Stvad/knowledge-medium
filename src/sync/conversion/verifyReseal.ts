/**
 * Verify (docs/workspace-e2ee-conversion.md §6.3 step 5). Check every row on
 * the server against the server's own record of its re-seal, and re-send any
 * row that differs from it. The record lives in `blocks_history` until the
 * purge, so a crash between a row's commit and this pass loses nothing.
 */

import { SEALED_COLUMNS } from '../transform.js'
import type { ContentColumns, ServerBlockRow, ServerHistoryRow } from './conversionServer.js'
import {
  ConversionRefusal,
  idsOf,
  isSealedRow,
  opensTo,
  openSealed,
  RESEAL_PAGE_SIZE,
  requireWorkspaceKey,
  sealAndSend,
  serverPages,
  type ConversionPassOptions,
} from './sealing.js'

/** Every column a re-seal write changes: the three it sends, and the version
 *  the clamp trigger bumps. */
const RESEAL_WRITE_COLUMNS: ReadonlySet<string> = new Set([...SEALED_COLUMNS, 'updated_at'])

const contentOf = (diff: Readonly<Record<string, unknown>> | null): ContentColumns | null => {
  if (!diff) return null
  const {content, properties_json, references_json} = diff
  if (typeof content !== 'string' || typeof properties_json !== 'string' || typeof references_json !== 'string') return null
  return {content, properties_json, references_json}
}

/** The plaintext a history row sealed, if it is a re-seal write: an UPDATE
 *  that changed only the re-seal's columns and took the row from short of
 *  sealed (the re-seal's own test, so a value that merely looks sealed still
 *  counts as plaintext) to sealed under `wk`. Until the conversion finishes
 *  only the re-seal seals under the workspace key, so a row sealed by any
 *  other writer, before the flip or after it, has no record and the run
 *  refuses rather than re-sending over it. */
export const sealRecordOf = async (
  history: ServerHistoryRow,
  workspaceId: string,
  wk: CryptoKey,
): Promise<ContentColumns | null> => {
  const {block_id: id, before_diff, after_diff} = history
  if (!after_diff || !Object.keys(after_diff).every(column => RESEAL_WRITE_COLUMNS.has(column))) return null
  const before = contentOf(before_diff)
  const after = contentOf(after_diff)
  if (!before || !after || isSealedRow(before)) return null
  return (await openSealed(wk, {id, workspace_id: workspaceId}, after)) ? before : null
}

/** Each block's record, found by content rather than by position in the
 *  history. Sorted so that a row with more than one, which no reachable history
 *  has, resolves to the latest. */
const sealRecords = async (
  history: readonly ServerHistoryRow[],
  workspaceId: string,
  wk: CryptoKey,
): Promise<Map<string, ContentColumns>> => {
  const sorted = [...history].sort((a, b) => a.event_id - b.event_id)
  const plaintexts = await Promise.all(sorted.map(row => sealRecordOf(row, workspaceId, wk)))
  const records = new Map<string, ContentColumns>()
  sorted.forEach((row, i) => {
    const plaintext = plaintexts[i]
    if (plaintext) records.set(row.block_id, plaintext)
  })
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

export type VerifyOptions = ConversionPassOptions<VerifyProgress>

export const verifyReseal = async ({
  server,
  workspaceId,
  wk,
  pageSize = RESEAL_PAGE_SIZE,
  onProgress,
  signal,
}: VerifyOptions): Promise<VerifyProgress> => {
  await requireWorkspaceKey(server, workspaceId, wk)
  let checked = 0
  let repaired = 0
  for await (const page of serverPages(server, workspaceId, pageSize, signal)) {
    const unsealed = page.filter(row => !isSealedRow(row))
    if (unsealed.length > 0) throw new ConversionRefusal('unsealed', idsOf(unsealed))

    const records = await sealRecords(await server.readContentSealHistory(workspaceId, idsOf(page)), workspaceId, wk)
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

  // A lost session reads as an empty table rather than as an error, so the
  // pass proves it saw every row: as many as the workspace holds, counted
  // while it is still visible to this session.
  const total = await server.countBlocks(workspaceId)
  await requireWorkspaceKey(server, workspaceId, wk)
  if (total !== checked) {
    throw new Error(`conversion: verify checked ${checked} of the workspace's ${total} rows; run it again`)
  }
  return {checked, repaired}
}
