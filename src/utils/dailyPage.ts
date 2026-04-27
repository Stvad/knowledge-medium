// Roam/Logseq-style daily-page date formatting.
//
// The "long" format ("April 26th, 2026") is intentionally locale-pinned to
// en-US: it doubles as the page's [[wiki-link]] alias, and aliases must
// match byte-for-byte across all members of a shared workspace for links
// to resolve. A French member's browser auto-formatting "26 avril 2026"
// would silently break linking.
//
// The ISO format ("2026-04-26") is a stable secondary alias for sorting,
// scripting, and timezone-agnostic references.

const ordinalSuffix = (day: number): string => {
  if (day >= 11 && day <= 13) return 'th'
  switch (day % 10) {
    case 1: return 'st'
    case 2: return 'nd'
    case 3: return 'rd'
    default: return 'th'
  }
}

/** "April 26th, 2026" — Roam-style long form, en-US, used as a page alias. */
export const formatRoamDate = (date: Date): string => {
  const month = date.toLocaleString('en-US', {month: 'long'})
  const day = date.getDate()
  return `${month} ${day}${ordinalSuffix(day)}, ${date.getFullYear()}`
}

/** "2026-04-26" — ISO local-date form, used as a secondary page alias. */
export const formatIsoDate = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Both daily-page aliases for the given date, long form first. */
export const dailyPageAliases = (date: Date): [string, string] =>
  [formatRoamDate(date), formatIsoDate(date)]
