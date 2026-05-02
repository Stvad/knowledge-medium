import { v5 as uuidv5 } from 'uuid'
import { dailyNoteBlockId } from '@/data/dailyNotes'
import { parseRelativeDate } from '@/utils/relativeDate'
import type { RoamPage } from './types'

// Fixed namespace for Roam-import block ids. Picking it once and never
// changing it keeps re-imports of the same export idempotent: a second
// run upserts the same ids instead of creating duplicates.
export const ROAM_IMPORT_NS = 'b8d6f1c2-7e9a-4f4d-a4f1-2c0a3a6e7f01'

// Deterministic id for a non-daily Roam block. Workspace-scoped so the
// same Roam graph imported into two workspaces produces distinct ids.
export const roamBlockId = (workspaceId: string, roamUid: string): string =>
  uuidv5(`${workspaceId}:roam:${roamUid}`, ROAM_IMPORT_NS)

export interface DailyPageInfo {
  iso: string
  blockId: string
}

// Detect a daily Roam page and resolve its our-side id via the existing
// daily-note id derivation. Returns null for non-daily pages so the
// caller can fall back to the generic id.
//
// Rules:
//   - Roam marks daily pages with `:log/id` (epoch-ms midnight UTC).
//   - Roam's daily-page uid is `MM-DD-YYYY`; we accept that as the
//     primary signal.
//   - We also accept titles that chrono-node parses to a single date
//     (Roam's "April 28th, 2026" long form).
export const resolveDailyPage = (
  workspaceId: string,
  page: RoamPage,
): DailyPageInfo | null => {
  const isoFromUid = isoFromDateUid(page.uid)
  if (isoFromUid) {
    return {iso: isoFromUid, blockId: dailyNoteBlockId(workspaceId, isoFromUid)}
  }

  if (page[':log/id'] !== undefined) {
    const iso = isoFromLogId(page[':log/id'])
    if (iso) return {iso, blockId: dailyNoteBlockId(workspaceId, iso)}
  }

  const parsed = parseRelativeDate(page.title)
  if (parsed) {
    return {iso: parsed.iso, blockId: dailyNoteBlockId(workspaceId, parsed.iso)}
  }

  return null
}

const isoFromDateUid = (uid: string): string | null => {
  // Roam daily-page uid format: MM-DD-YYYY
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(uid)
  if (!match) return null
  const [, mm, dd, yyyy] = match
  return `${yyyy}-${mm}-${dd}`
}

const isoFromLogId = (logId: number): string | null => {
  if (!Number.isFinite(logId)) return null
  const date = new Date(logId)
  if (Number.isNaN(date.getTime())) return null
  // `:log/id` is midnight UTC of the calendar day, so reading UTC
  // components keeps us aligned across timezones.
  const yyyy = date.getUTCFullYear()
  // Reject implausible years for the same reason parseRelativeDate
  // does: a corrupt or oversized `:log/id` in the export can yield a
  // 5-digit year, which then fails the strict `\d{4}-\d{2}-\d{2}`
  // regex in dailyNotes.ts and crashes the entire import.
  if (yyyy < 1000 || yyyy > 9999) return null
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}
