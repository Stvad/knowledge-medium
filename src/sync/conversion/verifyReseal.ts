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
  sealedForRow,
  RESEAL_PAGE_SIZE,
  requireWholeWorkspace,
  requireWorkspaceKey,
  sealAndSend,
  serverPages,
  type ConversionPassOptions,
} from './sealing.js'

/** Every column a re-seal write changes: the three it sends, and the version
 *  the clamp trigger bumps. */
const RESEAL_WRITE_COLUMNS: ReadonlySet<string> = new Set([...SEALED_COLUMNS, 'updated_at'])

export interface SealRecord {
  /** The row's content just before the re-seal sealed it. */
  readonly plaintext: ContentColumns
  /** The row version the re-seal wrote: a row still at it has not been written since. */
  readonly version: unknown
}

const contentOf = (diff: Readonly<Record<string, unknown>> | null): ContentColumns | null => {
  if (!diff) return null
  const {content, properties_json, references_json} = diff
  if (typeof content !== 'string' || typeof properties_json !== 'string' || typeof references_json !== 'string') return null
  return {content, properties_json, references_json}
}

/** A history row that has the shape of a re-seal write: an UPDATE that changed
 *  only the re-seal's columns and took the row from short of sealed (the
 *  re-seal's own test, so a value that merely looks sealed still counts as
 *  plaintext) to sealed. Judged without the key, so a re-taken recovery bundle
 *  can read it even after the key that sealed it is lost. */
export interface ResealWrite {
  readonly before: ContentColumns
  readonly after: ContentColumns
  /** The row version the write produced. */
  readonly version: unknown
}

export const resealWriteOf = (history: ServerHistoryRow): ResealWrite | null => {
  const {before_diff, after_diff} = history
  if (!after_diff || !Object.keys(after_diff).every(column => RESEAL_WRITE_COLUMNS.has(column))) return null
  const before = contentOf(before_diff)
  const after = contentOf(after_diff)
  if (!before || !after || isSealedRow(before) || !isSealedRow(after)) return null
  return {before, after, version: after_diff.updated_at}
}

/** Each block's latest re-seal-shaped write. After the flip only the re-seal
 *  moves a row from plaintext to sealed, so the latest such write is the
 *  re-seal's, even when an older pre-conversion write had the same shape. */
export const latestResealWrites = (history: readonly ServerHistoryRow[]): Map<string, ResealWrite> => {
  const latest = new Map<string, {eventId: number; write: ResealWrite}>()
  for (const row of history) {
    const write = resealWriteOf(row)
    const current = latest.get(row.block_id)
    if (write && (!current || row.event_id > current.eventId)) latest.set(row.block_id, {eventId: row.event_id, write})
  }
  return new Map([...latest].map(([blockId, {write}]) => [blockId, write]))
}

/** The record a history row is, if it is a re-seal write sealed for this row
 *  under `wk`, in whichever column the server stored each value. Until the
 *  conversion finishes only the re-seal seals under the workspace key, so a row
 *  sealed by any other writer, before the flip or after it, has no record and
 *  the run refuses rather than re-sending over it. */
export const sealRecordOf = async (
  history: ServerHistoryRow,
  workspaceId: string,
  wk: CryptoKey,
): Promise<SealRecord | null> => {
  const write = resealWriteOf(history)
  if (!write || !(await sealedForRow(wk, {id: history.block_id, workspace_id: workspaceId}, write.after))) return null
  return {plaintext: write.before, version: write.version}
}

/** Each block's record, found by content rather than by position in the
 *  history. Sorted so that a row with more than one, which no reachable history
 *  has, resolves to the latest. */
const sealRecords = async (
  history: readonly ServerHistoryRow[],
  workspaceId: string,
  wk: CryptoKey,
): Promise<Map<string, SealRecord>> => {
  const sorted = [...history].sort((a, b) => a.event_id - b.event_id)
  const found = await Promise.all(sorted.map(row => sealRecordOf(row, workspaceId, wk)))
  const records = new Map<string, SealRecord>()
  sorted.forEach((row, i) => {
    const record = found[i]
    if (record) records.set(row.block_id, record)
  })
  return records
}

const differingFrom = async (
  rows: readonly ServerBlockRow[],
  records: ReadonlyMap<string, SealRecord>,
  wk: CryptoKey,
): Promise<ServerBlockRow[]> => {
  const matches = await Promise.all(rows.map(row => opensTo(wk, row, row, records.get(row.id)!.plaintext)))
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
    // Only what the re-seal itself wrote is repaired. A row written since then
    // holds someone else's write, which re-sending would overwrite.
    const writtenSince = differing.filter(row => row.updated_at !== records.get(row.id)!.version)
    if (writtenSince.length > 0) throw new ConversionRefusal('written-since-seal', idsOf(writtenSince))
    if (differing.length > 0) {
      await sealAndSend(server, workspaceId, differing.map(row => ({row, plaintext: records.get(row.id)!.plaintext})), wk)
      const stillDiffering = await differingFrom(await server.readBlocks(workspaceId, idsOf(differing)), records, wk)
      if (stillDiffering.length > 0) throw new ConversionRefusal('unrepaired', idsOf(stillDiffering))
    }

    checked += page.length
    repaired += differing.length
    onProgress?.({checked, repaired})
  }

  await requireWholeWorkspace(server, workspaceId, wk, checked)
  return {checked, repaired}
}
