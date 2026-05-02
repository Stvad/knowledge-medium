import * as chrono from 'chrono-node'
import { formatIsoDate, formatRoamDate } from '@/utils/dailyPage'

export interface ParsedRelativeDate {
  iso: string
  date: Date
}

// `forwardDate: true` so bare weekdays ("Friday") and month/day phrases
// ("April 28") resolve to the nearest *future* occurrence — matches the
// Roam/Logseq behavior. `chrono.casual` includes "today", "tomorrow",
// "yesterday", weekday names, and natural-language relatives.
//
// We take `result.start` and ignore `end` so a range expression
// ("April 28 to May 1") collapses to its anchor day; "next week"
// resolves to the upcoming Monday rather than failing the parse.
export const parseRelativeDate = (
  input: string,
  now: Date = new Date(),
): ParsedRelativeDate | null => {
  const trimmed = input.trim()
  if (!trimmed) return null

  const results = chrono.casual.parse(trimmed, now, {forwardDate: true})
  const result = results[0]
  if (!result) return null

  // Demand the parser consumed the whole input. Otherwise "Foobar"
  // wouldn't match anything but "Foobar 28" would silently parse as
  // "April 28th" because chrono picks the date fragment out — we
  // don't want a daily-page hijack on substring matches.
  if (result.text.length !== trimmed.length) return null

  const date = result.start.date()

  // Reject implausible years. chrono is lenient and will happily parse
  // "20201-04-01" (a Roam-import case from a typo'd page title) as
  // April 1 of year 20201; downstream `formatIsoDate` then emits a
  // 5-digit year like "20201-04-01" which fails ISO regex parsers.
  // Treat anything outside 4-digit range as a non-date so the caller
  // falls through to the non-daily path.
  const year = date.getFullYear()
  if (year < 1000 || year > 9999) return null

  return {iso: formatIsoDate(date), date}
}

/**
 * Strict variant of `parseRelativeDate` for storage-time decisions
 * (currently: Roam import deciding which `[[wiki-link]]` aliases should
 * be rewired to a daily-note id, and which Roam pages without a
 * `:log/id` should be treated as dailies).
 *
 * Returns a parse result iff `input` is a *literal* daily-page title —
 * either ISO ("2026-04-28") or the Roam long form ("April 28th, 2026").
 * Relative-time keywords like "today" / "now" / "friday" / "may" /
 * "noon" / "next week" are intentionally rejected here; those still
 * resolve via `parseRelativeDate` for autocomplete + navigation, but
 * must NOT collapse references to a calendar id at import time. (Roam
 * itself doesn't do that — `[[today]]` is a regular page named
 * "today", not an alias for the day's daily.) The earlier behavior
 * pulled every historical `[[today]]` / `[[now]]` / `[[friday]]` into
 * the *current* day's backlinks after a re-import.
 *
 * Implementation: parse via `parseRelativeDate`, then verify the input
 * roundtrips through one of the two canonical formatters. Anything
 * that chrono *could* parse (relative or fuzzy) but that isn't already
 * in canonical form is rejected — including malformed-but-coercible
 * literals like "2026-13-01" (chrono would happily reinterpret).
 */
export const parseLiteralDailyPageTitle = (
  input: string,
  now: Date = new Date(),
): ParsedRelativeDate | null => {
  const parsed = parseRelativeDate(input, now)
  if (!parsed) return null
  const trimmed = input.trim()
  if (trimmed === parsed.iso) return parsed
  if (trimmed === formatRoamDate(parsed.date)) return parsed
  return null
}
