/**
 * Daily-notes contribution to `wikilinkDisplayDecoratorFacet`: prefixes
 * date-shaped wikilink aliases with the weekday at render time
 * ("Fri, April 26th, 2026") so date references in block content are
 * scannable without changing how they're stored. The underlying alias
 * — what the link resolver and Roam-style canonical alias depend on —
 * is untouched.
 *
 * Accepts both canonical forms via `parseLiteralDailyPageTitle`:
 *   - long: "April 26th, 2026"  → "Fri, April 26th, 2026"
 *   - ISO:  "2026-04-26"        → "Fri, 2026-04-26"
 *
 * Weekday is locale-pinned to en-US to match the rest of the daily-page
 * alias (also en-US). Display-time use only — never written to storage.
 */
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate.ts'
import type {
  WikilinkDisplayContext,
  WikilinkDisplayDecorator,
} from '@/plugins/references/markdown/wikilinks/wikilinkDecorator.ts'

const formatWeekday = (date: Date): string =>
  date.toLocaleDateString('en-US', {weekday: 'short'})

export const dailyDateWikilinkDecorator: WikilinkDisplayDecorator = {
  id: 'daily-notes.date-weekday-prefix',
  decorate: ({alias}: WikilinkDisplayContext): string | null => {
    const parsed = parseLiteralDailyPageTitle(alias)
    if (!parsed) return null
    return `${formatWeekday(parsed.date)}, ${alias}`
  },
}
