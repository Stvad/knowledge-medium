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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

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
export const formatRoamDate = (date: Date, zone?: 'UTC'): string => {
  const month = MONTHS[zone ? date.getUTCMonth() : date.getMonth()]
  const day = zone ? date.getUTCDate() : date.getDate()
  const year = zone ? date.getUTCFullYear() : date.getFullYear()
  return `${month} ${day}${ordinalSuffix(day)}, ${year}`
}

/** "2026-04-26" — ISO local-date form, used as a secondary page alias. */
export const formatIsoDate = (date: Date): string => {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Both daily-page aliases for the given date, long form first. */
export const dailyPageAliases = (date: Date): [string, string] =>
  [formatRoamDate(date), formatIsoDate(date)]

/** Local midnight for a canonical ISO day. Parsing a full ISO string preserves years 0000–0099. */
export const parseIsoDay = (iso: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null
  const date = new Date(`${iso}T00:00:00`)
  return formatIsoDate(date) === iso ? date : null
}

/** Convert a user-entered Roam date to ISO, accepting month and ordinal letters in either case. */
export const isoFromRoamDate = (text: string): string | undefined => {
  const match = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th), (\d{1,4})$/i.exec(text)
  if (!match) return undefined
  const month = MONTHS.findIndex(name => name.toLowerCase() === match[1].toLowerCase()) + 1
  const iso = `${match[3].padStart(4, '0')}-${String(month).padStart(2, '0')}-${match[2].padStart(2, '0')}`
  const date = new Date(`${iso}T00:00:00Z`)
  return formatRoamDate(date, 'UTC').toLowerCase() === text.toLowerCase() ? iso : undefined
}
