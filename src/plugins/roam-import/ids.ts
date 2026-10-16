import { dailyNoteBlockId } from '@/plugins/daily-notes'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate'
import type { RoamPage } from './types'

export { ROAM_IMPORT_NS, roamBlockId } from './blockIds'

export interface DailyPageInfo {
  iso: string
  blockId: string
}

// Detect a daily Roam page and resolve its our-side id via the existing
// daily-note id derivation. Returns null for non-daily pages so the
// caller can fall back to the generic id.
//
// Rules:
//   - Literal daily-page titles are the canonical signal. Roam export
//     metadata can drift (e.g. `:log/id` reflecting creation/edit time
//     near a timezone boundary), but the page title is what Roam links
//     by and what users see.
//   - Roam's daily-page uid is often `MM-DD-YYYY`; accept it as a
//     fallback for title-less / non-standard-title exports.
//   - Roam also marks daily pages with `:log/id`; use that only after
//     title and uid fail.
//   - Title parsing is strict literal-only here — ISO or Roam long
//     form, e.g. "April 28th, 2026". A permissive natural-language
//     parser would treat a page literally
//     titled "today"/"may"/"friday" as a daily note keyed to the
//     current day, which is wrong (Roam keeps those as regular pages)
//     and would also stomp the day's daily on import.
export const resolveDailyPage = (
  workspaceId: string,
  page: RoamPage,
): DailyPageInfo | null => {
  const parsed = parseLiteralDailyPageTitle(page.title)
  if (parsed) {
    return {iso: parsed.iso, blockId: dailyNoteBlockId(workspaceId, parsed.iso)}
  }

  const isoFromUid = isoFromDateUid(page.uid)
  if (isoFromUid) {
    return {iso: isoFromUid, blockId: dailyNoteBlockId(workspaceId, isoFromUid)}
  }

  if (page[':log/id'] !== undefined) {
    const iso = isoFromLogId(page[':log/id'])
    if (iso) return {iso, blockId: dailyNoteBlockId(workspaceId, iso)}
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
