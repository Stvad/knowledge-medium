import type { ReviewProgress } from './schema.ts'

/** Local calendar day (YYYY-MM-DD), used to invalidate a saved session
 *  after a midnight rollover. */
export const localDayKey = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`

/** The saved session to resume, or null when there's nothing valid to
 *  restore (no save, a different deck tag, or a day rollover). Used as the
 *  lazy initial state so a restored queue is non-null from the first
 *  render — which keeps the live-snapshot path (gated on `queue === null`)
 *  from clobbering it, no extra flag needed. The index is clamped to the
 *  queue length so a saved "complete" session (index === length) resumes
 *  on the completion screen rather than out of bounds. */
export const restoreSavedSession = (
  progress: ReviewProgress | null,
  tagName: string,
  todayKey: string,
): {queue: readonly string[]; index: number; revealed: boolean} | null => {
  if (
    progress &&
    progress.queue.length > 0 &&
    progress.tag === tagName &&
    progress.day === todayKey
  ) {
    return {
      queue: progress.queue,
      index: Math.min(progress.index, progress.queue.length),
      revealed: progress.revealed,
    }
  }
  return null
}
