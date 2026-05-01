import * as chrono from 'chrono-node'
import { formatIsoDate } from '@/utils/dailyPage'

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
