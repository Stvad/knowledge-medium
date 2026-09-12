/** Unit tier for `src/km/records.ts`: hand-built rows for every reader, no
 *  database. `@/data/properties.js` resolves to `test/kernel/properties.ts`
 *  (see that file's doc), which reads `properties.types` as a plain decoded
 *  array — so every row below carries its type membership that way, not as
 *  the app's real encoded form (proven against the real encoding in the
 *  integration tier instead).
 */
import {describe, expect, it} from 'vitest'

import {
  DOSE_TYPE, EXPERIMENT_TYPE, FIELD, NIGHT_TYPE, PERIOD_TYPE, SESSION_TYPE,
} from '../src/km/fields'
import {dayToDate} from '../src/km/day'
import {
  asDose, asExperiment, asNight, asPeriod, asSession, buildExperiments, buildNights, doseIsRequired, trainedDays,
  type Row,
} from '../src/km/records'

let idCounter = 0
const row = (types: readonly string[], properties: Record<string, unknown> = {}, over: Partial<Row> = {}): Row => ({
  id: over.id ?? `row-${++idCounter}`,
  parentId: over.parentId ?? null,
  orderKey: over.orderKey ?? 'a0',
  deleted: over.deleted,
  properties: {types: [...types], ...properties},
})

/** A wake-date string encoded the way the app's own `date` property codec
 *  would: `Date#toISOString()` of whatever `Date` was assigned. */
const iso = (date: Date): string => date.toISOString()
const day = (d: string): string => iso(dayToDate(d))

describe('asNight', () => {
  it('is null for a row of a different type', () => {
    expect(asNight(row([EXPERIMENT_TYPE], {[FIELD.date]: day('2026-02-10')}))).toBeNull()
  })

  it('is null when the row is soft-deleted', () => {
    expect(asNight(row([NIGHT_TYPE], {[FIELD.date]: day('2026-02-10')}, {deleted: true}))).toBeNull()
  })

  it('is null with no date property', () => {
    expect(asNight(row([NIGHT_TYPE]))).toBeNull()
  })

  it('reads its own local-noon write back to the same day', () => {
    const result = asNight(row([NIGHT_TYPE], {[FIELD.date]: day('2026-02-10')}))
    expect(result?.date).toBe('2026-02-10')
  })

  it('reads an editor-typed UTC-midnight value as the day typed, not local calendar day', () => {
    // TZ is America/Los_Angeles (see vitest.config.ts): a bare UTC-midnight
    // ISO string is what the app's own date-property editor writes for
    // '2026-02-10', and `storedDate` must read it as that day rather than
    // shifting it west by re-parsing local parts.
    const result = asNight(row([NIGHT_TYPE], {[FIELD.date]: '2026-02-10T00:00:00.000Z'}))
    expect(result?.date).toBe('2026-02-10')
  })

  it('collects arm, refs, ratings and covariates', () => {
    const result = asNight(row([NIGHT_TYPE], {
      [FIELD.date]: day('2026-02-10'),
      [FIELD.arm]: 'intervention',
      [FIELD.experiment]: 'exp-1',
      [FIELD.period]: 'period-1',
      [FIELD.quality]: 4,
      [FIELD.sleepiness]: 3,
      [FIELD.alcohol]: 2,
      [FIELD.caffeineLate]: true,
      [FIELD.lateMeal]: false,
      [FIELD.unusual]: true,
      [FIELD.unusualReason]: 'travel',
    }))
    expect(result).toMatchObject({
      arm: 'intervention',
      experimentId: 'exp-1',
      periodId: 'period-1',
      ratings: {quality: 4, sleepiness: 3},
      alcohol: 2,
      caffeineLate: true,
      lateMeal: false,
      unusual: true,
      unusualReason: 'travel',
    })
    // Ratings never written are simply absent, not zero.
    expect(result?.ratings.rested).toBeUndefined()
    expect(result?.ratings.ease).toBeUndefined()
  })

  it('leaves arm undefined for anything other than the two known values', () => {
    const result = asNight(row([NIGHT_TYPE], {[FIELD.date]: day('2026-02-10'), [FIELD.arm]: 'bogus'}))
    expect(result?.arm).toBeUndefined()
  })
})

describe('asSession', () => {
  // Session start/end are stored as epoch-ms NUMBERS (`optionalNumber`),
  // unlike the date-only properties above — see `startProp`/`endProp` in
  // schema.ts: the `date` preset's editor is date-only, so a real instant
  // would lose its time-of-day round-tripping through it.
  it('is null without a start', () => {
    const result = asSession(row([SESSION_TYPE], {[FIELD.end]: new Date('2026-02-10T07:00:00Z').getTime()}))
    expect(result).toBeNull()
  })

  it('is null without an end', () => {
    const result = asSession(row([SESSION_TYPE], {[FIELD.start]: new Date('2026-02-09T23:00:00Z').getTime()}))
    expect(result).toBeNull()
  })

  it('picks up only the measures actually present, source, externalId, main and parentage', () => {
    const start = new Date('2026-02-09T23:00:00Z')
    const end = new Date('2026-02-10T07:00:00Z')
    const result = asSession(row([SESSION_TYPE], {
      [FIELD.start]: start.getTime(),
      [FIELD.end]: end.getTime(),
      [FIELD.main]: true,
      [FIELD.source]: 'health-connect',
      [FIELD.externalId]: 'hc-123',
      [FIELD.sleepMinutes]: 420,
      [FIELD.hrv]: 55.5,
    }, {id: 'session-1', parentId: 'night-1'}))

    expect(result).toMatchObject({
      id: 'session-1',
      nightId: 'night-1',
      source: 'health-connect',
      externalId: 'hc-123',
      main: true,
      start,
      end,
    })
    expect(result?.measures).toEqual({sleepMinutes: 420, hrv: 55.5})
  })

  it('falls back to source "manual" for an unrecognized or absent source', () => {
    const start = new Date('2026-02-09T23:00:00Z')
    const end = new Date('2026-02-10T07:00:00Z')
    const result = asSession(row([SESSION_TYPE], {[FIELD.start]: start.getTime(), [FIELD.end]: end.getTime(), [FIELD.source]: 'bogus'}))
    expect(result?.source).toBe('manual')
  })
})

describe('asDose', () => {
  it('is null for a row of a different type', () => {
    expect(asDose(row(['todo'], {[FIELD.todoStatus]: 'done'}))).toBeNull()
  })

  it('reads taken from the composed todo status, not its own property', () => {
    const done = asDose(row([DOSE_TYPE, 'todo'], {[FIELD.todoStatus]: 'done', [FIELD.takenAt]: 12345}, {id: 'dose-1', parentId: 'night-1'}))
    expect(done).toEqual({id: 'dose-1', nightId: 'night-1', taken: true, takenAt: 12345})

    const open = asDose(row([DOSE_TYPE, 'todo'], {[FIELD.todoStatus]: 'open'}, {id: 'dose-2', parentId: 'night-1'}))
    expect(open).toEqual({id: 'dose-2', nightId: 'night-1', taken: false, takenAt: undefined})
  })
})

describe('asPeriod', () => {
  it('is null with no parent', () => {
    const result = asPeriod(row([PERIOD_TYPE], {
      [FIELD.arm]: 'intervention', [FIELD.index]: 1, [FIELD.pair]: 1,
      [FIELD.from]: day('2026-02-09'), [FIELD.to]: day('2026-02-11'),
    }, {parentId: null}))
    expect(result).toBeNull()
  })

  it('is null when the arm is missing or unrecognized', () => {
    const missing = asPeriod(row([PERIOD_TYPE], {
      [FIELD.index]: 1, [FIELD.pair]: 1, [FIELD.from]: day('2026-02-09'), [FIELD.to]: day('2026-02-11'),
    }, {parentId: 'exp-1'}))
    expect(missing).toBeNull()

    const bogus = asPeriod(row([PERIOD_TYPE], {
      [FIELD.arm]: 'bogus', [FIELD.index]: 1, [FIELD.pair]: 1, [FIELD.from]: day('2026-02-09'), [FIELD.to]: day('2026-02-11'),
    }, {parentId: 'exp-1'}))
    expect(bogus).toBeNull()
  })

  it('reads index, pair, arm and the inclusive date range, keyed to its parent experiment', () => {
    const result = asPeriod(row([PERIOD_TYPE], {
      [FIELD.arm]: 'control', [FIELD.index]: 3, [FIELD.pair]: 2,
      [FIELD.from]: day('2026-02-15'), [FIELD.to]: day('2026-02-17'),
    }, {id: 'period-3', parentId: 'exp-1'}))
    expect(result).toEqual({
      id: 'period-3', experimentId: 'exp-1', index: 3, pair: 2, arm: 'control', from: '2026-02-15', to: '2026-02-17',
    })
  })
})

describe('asExperiment', () => {
  it('is null for a row of a different type', () => {
    expect(asExperiment(row([NIGHT_TYPE]))).toBeNull()
  })

  it('defaults every field a bare experiment row omits', () => {
    const result = asExperiment(row([EXPERIMENT_TYPE], {}, {id: 'exp-1'}))
    expect(result).toEqual({
      id: 'exp-1',
      intervention: '',
      doseText: '',
      control: 'nothing',
      startDate: '',
      periodNights: 3,
      pairs: 8,
      seed: 0,
      status: 'running',
      primary: [],
    })
  })

  it('reads every field a fully-populated experiment row carries', () => {
    const result = asExperiment(row([EXPERIMENT_TYPE], {
      [FIELD.intervention]: 'glycine',
      [FIELD.doseText]: '3 g glycine, before bed',
      [FIELD.control]: 'placebo',
      [FIELD.startDate]: day('2026-02-01'),
      [FIELD.periodNights]: 3,
      [FIELD.pairs]: 8,
      [FIELD.seed]: 42,
      [FIELD.experimentStatus]: 'planned',
    }, {id: 'exp-2'}))
    expect(result).toEqual({
      id: 'exp-2',
      intervention: 'glycine',
      doseText: '3 g glycine, before bed',
      control: 'placebo',
      startDate: '2026-02-01',
      periodNights: 3,
      pairs: 8,
      seed: 42,
      primary: [],
      status: 'planned',
    })
  })

  it('falls back to "running" for an unrecognized status', () => {
    const result = asExperiment(row([EXPERIMENT_TYPE], {[FIELD.experimentStatus]: 'bogus'}))
    expect(result?.status).toBe('running')
  })

  // Pins: `sleeplab:primary` is read as a string-list, and any name that
  // is not one of `SESSION_MEASURES`/`NIGHT_RATINGS` is dropped rather than
  // carried through as an unrecognized outcome the dashboard can't render.
  it('reads sleeplab:primary, dropping any name that is not a recognized outcome', () => {
    const result = asExperiment(row([EXPERIMENT_TYPE], {
      [FIELD.primary]: ['onsetMinutes', 'bogus-outcome', 'quality'],
    }, {id: 'exp-3'}))
    expect(result?.primary).toEqual(['onsetMinutes', 'quality'])
  })

  it('reads an empty or missing sleeplab:primary as an empty list', () => {
    expect(asExperiment(row([EXPERIMENT_TYPE], {[FIELD.primary]: []}))?.primary).toEqual([])
    expect(asExperiment(row([EXPERIMENT_TYPE], {}))?.primary).toEqual([])
  })
})

describe('buildExperiments', () => {
  it('sorts experiments newest-started-first, and each one\'s periods by index', () => {
    const older = row([EXPERIMENT_TYPE], {[FIELD.startDate]: day('2026-01-01')}, {id: 'exp-older'})
    const newer = row([EXPERIMENT_TYPE], {[FIELD.startDate]: day('2026-02-01')}, {id: 'exp-newer'})
    // Deliberately out of index order in the input array.
    const p2 = row([PERIOD_TYPE], {
      [FIELD.arm]: 'control', [FIELD.index]: 2, [FIELD.pair]: 1, [FIELD.from]: day('2026-01-04'), [FIELD.to]: day('2026-01-06'),
    }, {id: 'p2', parentId: 'exp-older'})
    const p1 = row([PERIOD_TYPE], {
      [FIELD.arm]: 'intervention', [FIELD.index]: 1, [FIELD.pair]: 1, [FIELD.from]: day('2026-01-01'), [FIELD.to]: day('2026-01-03'),
    }, {id: 'p1', parentId: 'exp-older'})

    const result = buildExperiments([p2, older, newer, p1])

    expect(result.map(e => e.id)).toEqual(['exp-newer', 'exp-older'])
    expect(result[0].periods).toEqual([])
    expect(result[1].periods.map(p => p.id)).toEqual(['p1', 'p2'])
  })

  it('drops rows that are neither a usable experiment nor a usable period', () => {
    const result = buildExperiments([row([NIGHT_TYPE])])
    expect(result).toEqual([])
  })
})

describe('trainedDays', () => {
  const STRENGTH_WORKOUT_TYPE = 'strength-workout'
  const STRENGTH_DATE = 'strength:date'
  const STRENGTH_STATUS = 'strength:status'

  it('collects only the dates of FINISHED strength sessions', () => {
    const done = row([STRENGTH_WORKOUT_TYPE], {[STRENGTH_DATE]: day('2026-02-09'), [STRENGTH_STATUS]: 'done'})
    const inProgress = row([STRENGTH_WORKOUT_TYPE], {[STRENGTH_DATE]: day('2026-02-10'), [STRENGTH_STATUS]: 'in-progress'})
    expect(trainedDays([done, inProgress])).toEqual(new Set(['2026-02-09']))
  })
})

describe('buildNights', () => {
  it('joins sessions, dose and period, and sorts oldest-first', () => {
    const night1 = row([NIGHT_TYPE], {[FIELD.date]: day('2026-02-09')}, {id: 'night-1', parentId: 'lab-page'})
    const night2 = row([NIGHT_TYPE], {
      [FIELD.date]: day('2026-02-10'), [FIELD.period]: 'period-1', [FIELD.arm]: 'intervention',
    }, {id: 'night-2', parentId: 'lab-page'})
    // Out-of-tree-order on purpose: buildNights must not depend on rows
    // arriving night-then-children.
    const period1 = row([PERIOD_TYPE], {
      [FIELD.arm]: 'intervention', [FIELD.index]: 2, [FIELD.pair]: 1,
      [FIELD.from]: day('2026-02-10'), [FIELD.to]: day('2026-02-12'),
    }, {id: 'period-1', parentId: 'exp-1'})
    const mainSession = row([SESSION_TYPE], {
      [FIELD.start]: new Date('2026-02-09T23:00:00Z').getTime(), [FIELD.end]: new Date('2026-02-10T07:00:00Z').getTime(),
      [FIELD.main]: true, [FIELD.sleepMinutes]: 420,
    }, {id: 'session-main', parentId: 'night-2'})
    const napSession = row([SESSION_TYPE], {
      [FIELD.start]: new Date('2026-02-10T21:00:00Z').getTime(), [FIELD.end]: new Date('2026-02-10T21:40:00Z').getTime(),
      [FIELD.main]: false,
    }, {id: 'session-nap', parentId: 'night-2'})
    const openDose = row([DOSE_TYPE, 'todo'], {[FIELD.todoStatus]: 'open'}, {id: 'dose-1', parentId: 'night-1'})

    const trained = new Set(['2026-02-09'])
    const result = buildNights([period1, mainSession, night2, napSession, night1, openDose], trained)

    expect(result.map(n => n.date)).toEqual(['2026-02-09', '2026-02-10'])

    const [n1, n2] = result
    expect(n1.doseTaken).toBe(false)
    expect(n1.trained).toBe(true)
    expect(n1.main).toBeUndefined()
    expect(n1.naps).toEqual([])
    // No dose block at all reads as undefined, not false.
    expect(n2.doseTaken).toBeUndefined()
    expect(n2.trained).toBe(false)
    expect(n2.periodIndex).toBe(2)
    expect(n2.pair).toBe(1)
    // The period's `from` IS this night's date, so it is the transition night.
    expect(n2.transition).toBe(true)
    expect(n2.main?.id).toBe('session-main')
    expect(n2.naps.map(s => s.id)).toEqual(['session-nap'])
  })

  // Pins: when several sessions under one night are flagged `main` by hand
  // (the property editor toggles each block on its own, so more than one
  // can end up true at once), `buildNights` picks the LONGEST of them as
  // `main` and reads every other one — flagged or not — as a nap.
  it('when two sessions are both flagged main, the longer one wins and the shorter reads as a nap', () => {
    const night = row([NIGHT_TYPE], {[FIELD.date]: day('2026-02-09')}, {id: 'night-1'})
    const shortMain = row([SESSION_TYPE], {
      [FIELD.start]: new Date('2026-02-09T00:00:00Z').getTime(),
      [FIELD.end]: new Date('2026-02-09T04:00:00Z').getTime(), // 4h
      [FIELD.main]: true,
    }, {id: 'session-short', parentId: 'night-1'})
    const longMain = row([SESSION_TYPE], {
      [FIELD.start]: new Date('2026-02-09T00:30:00Z').getTime(),
      [FIELD.end]: new Date('2026-02-09T07:30:00Z').getTime(), // 7h
      [FIELD.main]: true,
    }, {id: 'session-long', parentId: 'night-1'})

    const [result] = buildNights([night, shortMain, longMain])
    expect(result.main?.id).toBe('session-long')
    expect(result.naps.map(s => s.id)).toEqual(['session-short'])
  })

  it('keeps a ref\'d arm when the period it points at is gone, with no pair/periodIndex/transition', () => {
    const night = row([NIGHT_TYPE], {
      [FIELD.date]: day('2026-02-09'), [FIELD.period]: 'missing-period', [FIELD.arm]: 'control',
    }, {id: 'night-1'})
    const [result] = buildNights([night])
    expect(result.arm).toBe('control')
    expect(result.periodIndex).toBeUndefined()
    expect(result.pair).toBeUndefined()
    expect(result.transition).toBeUndefined()
  })

  it('any dose ticked counts, even with a duplicate dose block', () => {
    const night = row([NIGHT_TYPE], {[FIELD.date]: day('2026-02-09')}, {id: 'night-1'})
    const open = row([DOSE_TYPE, 'todo'], {[FIELD.todoStatus]: 'open'}, {id: 'dose-1', parentId: 'night-1'})
    const done = row([DOSE_TYPE, 'todo'], {[FIELD.todoStatus]: 'done'}, {id: 'dose-2', parentId: 'night-1'})
    const [result] = buildNights([night, open, done])
    expect(result.doseTaken).toBe(true)
  })

  describe('doseRequired — with the experiment row among the queried rows', () => {
    it('derives control nights from the experiment\'s own control kind, and intervention nights are always required', () => {
      const placeboExperiment = row([EXPERIMENT_TYPE], {[FIELD.control]: 'placebo'}, {id: 'exp-placebo'})
      const controlUnderPlacebo = row([NIGHT_TYPE], {
        [FIELD.date]: day('2026-02-09'), [FIELD.arm]: 'control', [FIELD.experiment]: 'exp-placebo',
      }, {id: 'night-control-placebo'})
      const interventionUnderPlacebo = row([NIGHT_TYPE], {
        [FIELD.date]: day('2026-02-10'), [FIELD.arm]: 'intervention', [FIELD.experiment]: 'exp-placebo',
      }, {id: 'night-intervention-placebo'})

      const nothingExperiment = row([EXPERIMENT_TYPE], {[FIELD.control]: 'nothing'}, {id: 'exp-nothing'})
      const controlUnderNothing = row([NIGHT_TYPE], {
        [FIELD.date]: day('2026-02-11'), [FIELD.arm]: 'control', [FIELD.experiment]: 'exp-nothing',
      }, {id: 'night-control-nothing'})
      const interventionUnderNothing = row([NIGHT_TYPE], {
        [FIELD.date]: day('2026-02-12'), [FIELD.arm]: 'intervention', [FIELD.experiment]: 'exp-nothing',
      }, {id: 'night-intervention-nothing'})

      const result = buildNights([
        placeboExperiment, controlUnderPlacebo, interventionUnderPlacebo,
        nothingExperiment, controlUnderNothing, interventionUnderNothing,
      ])
      const byId = new Map(result.map(n => [n.id, n]))

      expect(byId.get('night-control-placebo')?.doseRequired).toBe(true) // control, placebo control
      expect(byId.get('night-intervention-placebo')?.doseRequired).toBe(true) // intervention, either control kind
      expect(byId.get('night-control-nothing')?.doseRequired).toBe(false) // control, 'nothing' control
      expect(byId.get('night-intervention-nothing')?.doseRequired).toBe(true) // intervention, either control kind
    })
  })

  describe('doseRequired — without the experiment row among the queried rows', () => {
    it('intervention is required; control falls back to whether a dose child exists', () => {
      const interventionNoExperiment = row([NIGHT_TYPE], {
        [FIELD.date]: day('2026-02-09'), [FIELD.arm]: 'intervention', [FIELD.experiment]: 'exp-missing',
      }, {id: 'night-intervention'})
      const controlWithDose = row([NIGHT_TYPE], {
        [FIELD.date]: day('2026-02-10'), [FIELD.arm]: 'control', [FIELD.experiment]: 'exp-missing',
      }, {id: 'night-control-with-dose'})
      const doseChild = row([DOSE_TYPE, 'todo'], {[FIELD.todoStatus]: 'open'}, {id: 'dose-1', parentId: 'night-control-with-dose'})
      const controlNoDose = row([NIGHT_TYPE], {
        [FIELD.date]: day('2026-02-11'), [FIELD.arm]: 'control', [FIELD.experiment]: 'exp-missing',
      }, {id: 'night-control-no-dose'})

      // No `exp-missing` experiment row is included: the caller didn't query
      // it, or the night's experiment is gone.
      const result = buildNights([interventionNoExperiment, controlWithDose, doseChild, controlNoDose])
      const byId = new Map(result.map(n => [n.id, n]))

      expect(byId.get('night-intervention')?.doseRequired).toBe(true)
      expect(byId.get('night-control-with-dose')?.doseRequired).toBe(true)
      expect(byId.get('night-control-no-dose')?.doseRequired).toBe(false)
    })
  })
})

describe('doseIsRequired', () => {
  it('intervention always requires a dose, whatever the control kind', () => {
    expect(doseIsRequired('intervention', 'nothing')).toBe(true)
    expect(doseIsRequired('intervention', 'placebo')).toBe(true)
    expect(doseIsRequired('intervention', undefined)).toBe(true)
  })

  it('control requires a dose only when the experiment is placebo-controlled', () => {
    expect(doseIsRequired('control', 'placebo')).toBe(true)
    expect(doseIsRequired('control', 'nothing')).toBe(false)
    expect(doseIsRequired('control', undefined)).toBe(false)
  })

  it('an undefined arm never requires a dose', () => {
    expect(doseIsRequired(undefined, 'placebo')).toBe(false)
    expect(doseIsRequired(undefined, 'nothing')).toBe(false)
    expect(doseIsRequired(undefined, undefined)).toBe(false)
  })
})
