/** A watch session's stages and vitals → the per-night numbers stored on
 *  the session block.
 *
 *  All minute-valued measures are clipped to the session's own [start, end]
 *  window before summing, so a stage or sample that overruns the session
 *  bound (a common export artifact) can't inflate a total.
 */

import {dateToDay} from '../km/day'
import type {ImportedSession, Sample, SessionMeasure, Stage, StageKind} from './types'

const MINUTE_MS = 60_000

const round1 = (n: number): number => Math.round(n * 10) / 10
const round3 = (n: number): number => Math.round(n * 1000) / 1000

const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length

const SLEEP_STAGE_KINDS: readonly StageKind[] = ['light', 'deep', 'rem', 'sleeping']
const isSleepStage = (kind: StageKind): boolean => (SLEEP_STAGE_KINDS as readonly string[]).includes(kind)

const stageMinutes = (stage: Stage): number => (stage.end.getTime() - stage.start.getTime()) / MINUTE_MS

/** Clip a stage to the session window; `undefined` when nothing of it
 *  survives (fully outside the window, or degenerate after clipping). */
const clipStage = (stage: Stage, start: Date, end: Date): Stage | undefined => {
  const clippedStart = stage.start < start ? start : stage.start
  const clippedEnd = stage.end > end ? end : stage.end
  return clippedEnd > clippedStart ? {kind: stage.kind, start: clippedStart, end: clippedEnd} : undefined
}

/** First index whose sample is at or after `at`, on a time-sorted array. */
const lowerBound = (samples: readonly Sample[], at: number): number => {
  let lo = 0
  let hi = samples.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (samples[mid].at.getTime() < at) lo = mid + 1
    else hi = mid
  }
  return lo
}

const isSorted = (samples: readonly Sample[]): boolean => {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1].at.getTime() > samples[i].at.getTime()) return false
  }
  return true
}

/** The samples inside [start, end]. The importers hand over the whole
 *  export's samples time-sorted (a night is a few hundred out of ~100k), so
 *  the window is found by binary search; an unsorted array still works,
 *  by scanning. */
const inWindow = (samples: readonly Sample[], start: Date, end: Date): number[] => {
  if (!isSorted(samples)) {
    return samples.filter(s => s.at >= start && s.at <= end).map(s => s.value)
  }
  const values: number[] = []
  for (let i = lowerBound(samples, start.getTime()); i < samples.length && samples[i].at <= end; i++) {
    values.push(samples[i].value)
  }
  return values
}

/** Mean of the samples falling in [start, end], rounded to 1 decimal;
 *  `undefined` when none do — omitted rather than NaN. */
const meanInWindow = (samples: readonly Sample[], start: Date, end: Date): number | undefined => {
  const values = inWindow(samples, start, end)
  return values.length === 0 ? undefined : round1(mean(values))
}

export const deriveMeasures = (session: ImportedSession): Partial<Record<SessionMeasure, number>> => {
  const {start, end, stated} = session
  const result: Partial<Record<SessionMeasure, number>> = {}

  const inBedMinutes = (end.getTime() - start.getTime()) / MINUTE_MS
  result.inBedMinutes = round1(inBedMinutes)

  const stages = session.stages
    .slice()
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .map(s => clipStage(s, start, end))
    .filter((s): s is Stage => s !== undefined)

  if (stages.length > 0) {
    // Onset: the leading run of non-sleep stages, up to (not including) the
    // first sleep-kind stage. 0 when stage 0 is already sleep; the whole
    // session's stage time when no stage is ever a sleep kind.
    let onsetMinutes = 0
    let onsetEnd = 0
    for (; onsetEnd < stages.length; onsetEnd++) {
      if (isSleepStage(stages[onsetEnd].kind)) break
      onsetMinutes += stageMinutes(stages[onsetEnd])
    }
    result.onsetMinutes = round1(onsetMinutes)
    // Samsung's session begins where its algorithm placed sleep onset, so
    // its stage list never opens with an awake segment and the latency it
    // measured is only in the stated number. A stated latency therefore
    // wins over the stages' zero — the one measure where "stated" is the
    // better source rather than the fallback.
    if (onsetMinutes === 0 && stated?.onsetMinutes !== undefined) result.onsetMinutes = stated.onsetMinutes

    const sumKind = (kind: StageKind): number =>
      stages.filter(s => s.kind === kind).reduce((acc, s) => acc + stageMinutes(s), 0)

    const deep = sumKind('deep')
    const rem = sumKind('rem')
    const light = sumKind('light')
    const sleeping = sumKind('sleeping')
    const sleepMinutes = deep + rem + light + sleeping

    result.deepMinutes = round1(deep)
    result.remMinutes = round1(rem)
    result.lightMinutes = round1(light)
    result.sleepMinutes = round1(sleepMinutes)

    // After onset, out of bed IS awake: a bathroom trip counts as
    // wakefulness in both the minutes and the bouts.
    const isWake = (kind: StageKind): boolean => kind === 'awake' || kind === 'out-of-bed'
    const afterOnset = stages.slice(onsetEnd)
    result.awakeMinutes = round1(
      afterOnset.filter(s => isWake(s.kind)).reduce((acc, s) => acc + stageMinutes(s), 0),
    )

    // Awakenings: consecutive wake stages after onset count as one bout.
    let awakenings = 0
    let inBout = false
    for (const stage of afterOnset) {
      if (isWake(stage.kind)) {
        if (!inBout) awakenings++
        inBout = true
      } else {
        inBout = false
      }
    }
    result.awakenings = awakenings

    if (inBedMinutes > 0) result.efficiency = round3(sleepMinutes / inBedMinutes)
  }

  const hrValues = inWindow(session.heartRate, start, end)
  if (hrValues.length > 0) {
    result.hrMean = round1(mean(hrValues))
    result.hrMin = round1(Math.min(...hrValues))
  }

  const hrv = meanInWindow(session.hrv, start, end)
  if (hrv !== undefined) result.hrv = hrv
  const spo2 = meanInWindow(session.spo2, start, end)
  if (spo2 !== undefined) result.spo2 = spo2
  const skinTemp = meanInWindow(session.skinTemp, start, end)
  if (skinTemp !== undefined) result.skinTemp = skinTemp
  const respRate = meanInWindow(session.respRate, start, end)
  if (respRate !== undefined) result.respRate = respRate

  // `stated` fills in only what the derivation above could not produce —
  // `score` always lands here, since it is never derived from stages/vitals.
  if (stated) {
    for (const key of Object.keys(stated) as SessionMeasure[]) {
      if (result[key] !== undefined) continue
      const value = stated[key]
      if (value === undefined) continue
      // Samsung's own efficiency is sometimes a 0-1 ratio, sometimes a
      // 0-100 percent; normalize so the stored value is always 0-1.
      result[key] = key === 'efficiency' ? round3(value > 1 ? value / 100 : value) : value
    }
  }

  return result
}

/** Local calendar date of a session's end — the wake date it belongs to. */
export const wakeDateOf = (end: Date): string => dateToDay(end)

const MAIN_MIN_DURATION_MINUTES = 180
const MAIN_WINDOW_START_MINUTES = 3 * 60
const MAIN_WINDOW_END_MINUTES = 15 * 60

/** A "main" sleep session — the night's sleep, as opposed to a nap — ends
 *  between 03:00 and 15:00 local and lasts at least 3 hours. Both clauses
 *  matter: a long afternoon nap ending at 16:00 is out on the window, and a
 *  short pre-dawn doze ending at 04:00 is out on duration. */
export const isMainSession = (session: {start: Date; end: Date}): boolean => {
  const durationMinutes = (session.end.getTime() - session.start.getTime()) / MINUTE_MS
  const endMinuteOfDay = session.end.getHours() * 60 + session.end.getMinutes() + session.end.getSeconds() / 60
  const inWakeWindow = endMinuteOfDay >= MAIN_WINDOW_START_MINUTES && endMinuteOfDay <= MAIN_WINDOW_END_MINUTES
  return inWakeWindow && durationMinutes >= MAIN_MIN_DURATION_MINUTES
}

/** Index of the longest session that qualifies as "main"; `undefined` when
 *  none does (every session that day was a nap, or the watch wasn't worn). */
export const pickMain = (sessions: readonly {start: Date; end: Date}[]): number | undefined => {
  let bestIndex: number | undefined
  let bestDuration = -Infinity
  sessions.forEach((session, index) => {
    if (!isMainSession(session)) return
    const duration = session.end.getTime() - session.start.getTime()
    if (duration > bestDuration) {
      bestDuration = duration
      bestIndex = index
    }
  })
  return bestIndex
}
