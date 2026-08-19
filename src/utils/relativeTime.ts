/** Human-friendly timestamp formatting for metadata surfaces
 *  (bullet hover-card, recents, …). `now` is passed in rather than read
 *  from the clock so callers stay testable and renders stay pure. */

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Compact "time ago" label: "just now" under a minute, then "5m" / "3h"
 *  / "2d" ago, then an absolute short date past a week. Returns '' for a
 *  missing/zero timestamp, or a zero `now` (the SSR / pre-hydration clock
 *  snapshot), so callers can omit the line. Clock skew (a timestamp slightly
 *  ahead of `now`) collapses to "just now". */
export function formatRelativeTime(ts: number, now: number): string {
  if (!ts || !now) return ''
  const sec = Math.floor((now - ts) / 1000)
  if (sec < MINUTE) return 'just now'
  if (sec < HOUR) return `${Math.floor(sec / MINUTE)}m ago`
  if (sec < DAY) return `${Math.floor(sec / HOUR)}h ago`
  const days = Math.floor(sec / DAY)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** Full local date + time — the exact stamp, shown alongside the
 *  relative label. Returns '' for a missing/zero timestamp. */
export function formatAbsoluteDateTime(ts: number): string {
  if (!ts) return ''
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
