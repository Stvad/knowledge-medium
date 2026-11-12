import type { PropertyCellBackfillProgress } from '@/data/internals/propertyCellBackfill'

export const MIGRATING_STATUS = 'Migrating properties to blocks…'

const formatWait = (seconds: number): string => {
  const whole = Math.round(seconds)
  if (whole < 60) return `${whole} s`
  const minutes = Math.round(whole / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const formatRate = (perSecond: number): string =>
  perSecond < 10 ? perSecond.toFixed(1) : Math.round(perSecond).toLocaleString()

/**
 * The status line the migration shows per committed batch: the sweep, how far
 * it has got, and — so an operator can tell a slow run from a stuck one — its
 * rate and the wait left in it. The sweep number is there because a second
 * pass over the same blocks is normal; without it the count restarts from
 * zero for no reason the operator can see.
 *
 * Both are the CURRENT sweep's, timed from where the previous sweep's last
 * batch landed (the run's start, for the first): every sweep rescans the whole
 * workspace, and a later one mostly re-checks, so a run-wide average would
 * misstate both. `total` is the confirmation dialog's count; a sweep that
 * outgrows it shows its own scan as the total and no wait.
 */
export const createSweepProgressLine = (
  total: number,
  now: () => number = () => performance.now(),
): (progress: Pick<PropertyCellBackfillProgress, 'sweeps' | 'blocksScanned'>) => string => {
  let sweep = 0
  let sweepStartedAt = now()
  let lastReportAt = sweepStartedAt
  return ({sweeps, blocksScanned}) => {
    const at = now()
    if (sweeps !== sweep) {
      sweepStartedAt = lastReportAt
      sweep = sweeps
    }
    lastReportAt = at
    const shownTotal = Math.max(total, blocksScanned)
    const line = `${MIGRATING_STATUS} sweep ${sweeps}, ` +
      `${blocksScanned.toLocaleString()}/${shownTotal.toLocaleString()}`
    const seconds = (at - sweepStartedAt) / 1000
    if (seconds <= 0 || blocksScanned === 0) return line
    const rate = blocksScanned / seconds
    const remaining = shownTotal - blocksScanned
    return `${line} · ${formatRate(rate)} blocks/s` +
      (remaining > 0 ? `, about ${formatWait(remaining / rate)} left in this sweep` : '')
  }
}
