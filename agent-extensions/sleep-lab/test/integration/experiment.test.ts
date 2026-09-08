/** Integration tier for the experiment/schedule write path (`src/km/
 *  experiment.ts`) against a real `Repo`. Harness mirrors `nights.test.ts`
 *  in this directory (itself mirroring the Strength Tracker's
 *  `strengthWrites.test.ts`).
 *
 *  `{timeout: 30_000}` is headroom, not a measured need: this file's 6
 *  tests run in well under 1s combined (measured wall-clock for the whole
 *  file, including db setup: ~0.3s). Budgeted anyway per AGENTS.md's
 *  load-multiplier note for a `repo.tx`-per-test integration file.
 */
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'

import {ChangeScope, propertyValue} from '@/data/api'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {deleteBlock} from '@/data/mutators'
import {hasBlockType} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {createTypedChild} from '@/data/typedRecords'
import {statusProp as todoStatusProp, todoType} from '@/plugins/todo/schema'

import {buildSchedule} from '../../src/engine/schedule'
import {dayToDate} from '../../src/km/day'
import {
  createExperiment, readExperiments, runningExperiment, stampNight, stampSchedule, type ExperimentSpec,
} from '../../src/km/experiment'
import {
  DOSE_TYPE, EXPERIMENT_TYPE, FIELD, PERIOD_TYPE, type Arm, type ControlKind, type ExperimentStatus,
} from '../../src/km/fields'
import {getOrCreateLabPage} from '../../src/km/page'
import {
  SLEEPLAB_PROPS, SLEEPLAB_TYPES, armProp, controlProp, doseTextProp, experimentStatusProp, fromProp,
  indexProp, interventionProp, pairProp, pairsProp, periodNightsProp, seedProp, startDateProp, toProp,
} from '../../src/km/schema'

const WORKSPACE_ID = 'ws-1'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  const created = createTestRepo({
    db: sharedDb.db,
    user: {id: 'sleeper'},
    extensions: [
      ...SLEEPLAB_PROPS.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
      ...SLEEPLAB_TYPES.map(type => typeSeedsFacet.of(type, {source: 'test'})),
      definitionSeedsFacet.of(todoStatusProp, {source: 'test'}),
      typeSeedsFacet.of(todoType, {source: 'test'}),
    ],
  })
  repo = created.repo
  repo.setActiveWorkspaceId(WORKSPACE_ID)
})

const labPageId = async (): Promise<string> => (await getOrCreateLabPage(repo, WORKSPACE_ID)).id

const spec = (over: Partial<ExperimentSpec> = {}): ExperimentSpec => ({
  intervention: 'glycine',
  doseText: '3 g glycine, 30–60 min before bed',
  control: 'placebo',
  startDate: '2026-02-01',
  periodNights: 3,
  pairs: 2,
  seed: 7,
  ...over,
})

/** An experiment block the user typed by hand — no periods, no schedule —
 *  for `stampSchedule` tests. Mirrors `createExperiment`'s own property
 *  set, minus the schedule stamp it performs itself. */
const handMakeExperiment = (pageId: string, over: {doseText?: string; startDate?: string} = {}): Promise<string> =>
  repo.tx(async tx => {
    const typeSnapshot = repo.snapshotTypeRegistries()
    return createTypedChild(repo, tx, {
      parentId: pageId,
      content: 'Hand-typed experiment',
      types: [EXPERIMENT_TYPE],
      properties: [
        propertyValue(interventionProp, 'glycine'),
        propertyValue(doseTextProp, over.doseText ?? ''),
        propertyValue(controlProp, 'nothing'),
        propertyValue(startDateProp, dayToDate(over.startDate ?? '2026-02-01')),
        propertyValue(periodNightsProp, 3),
        propertyValue(pairsProp, 1),
        propertyValue(seedProp, 0),
        propertyValue(experimentStatusProp, 'planned'),
      ],
      typeSnapshot,
    })
  }, {scope: ChangeScope.BlockDefault, description: 'hand-make experiment'})

interface SeedPeriodSpec { index: number; pair: number; arm: Arm; from: string; to: string }

/** An experiment + its periods, built directly (same primitives
 *  `createExperiment` itself uses) rather than through `createExperiment`,
 *  so a test can pick the exact arm/date coverage it needs instead of
 *  reverse-engineering a PRNG seed. Mirrors `nights.test.ts`'s own helper. */
const seedExperiment = (
  pageId: string,
  periods: readonly SeedPeriodSpec[],
  over: {control?: ControlKind; status?: ExperimentStatus; doseText?: string} = {},
): Promise<string> =>
  repo.tx(async tx => {
    const typeSnapshot = repo.snapshotTypeRegistries()
    const experimentId = await createTypedChild(repo, tx, {
      parentId: pageId,
      content: 'Test experiment',
      types: [EXPERIMENT_TYPE],
      properties: [
        propertyValue(interventionProp, 'glycine'),
        propertyValue(doseTextProp, over.doseText ?? '3 g glycine before bed'),
        propertyValue(controlProp, over.control ?? 'nothing'),
        propertyValue(startDateProp, dayToDate(periods[0]?.from ?? '2026-01-01')),
        propertyValue(periodNightsProp, 3),
        propertyValue(pairsProp, Math.max(1, Math.ceil(periods.length / 2))),
        propertyValue(seedProp, 0),
        propertyValue(experimentStatusProp, over.status ?? 'running'),
      ],
      typeSnapshot,
    })
    for (const period of periods) {
      await createTypedChild(repo, tx, {
        parentId: experimentId,
        content: `Period ${period.index}`,
        types: [PERIOD_TYPE],
        properties: [
          propertyValue(indexProp, period.index),
          propertyValue(pairProp, period.pair),
          propertyValue(armProp, period.arm),
          propertyValue(fromProp, dayToDate(period.from)),
          propertyValue(toProp, dayToDate(period.to)),
        ],
        typeSnapshot,
      })
    }
    return experimentId
  }, {scope: ChangeScope.BlockDefault, description: 'seed experiment'})

const doseChildrenOf = async (nightId: string) =>
  ((await repo.block(nightId).children.load()) ?? []).filter(row => !row.deleted && hasBlockType(row, DOSE_TYPE))

describe('createExperiment', {timeout: 30_000}, () => {
  it('creates the experiment first under the page, and pairs*2 periods under it in schedule order', async () => {
    const pageId = await labPageId()
    const testSpec = spec()
    const experimentId = await createExperiment(repo, pageId, testSpec)

    const pageChildren = (await repo.block(pageId).children.load()) ?? []
    expect(pageChildren.map(c => c.id)).toContain(experimentId)
    // `position: {kind: 'first'}` in createExperiment's own spec.
    expect(pageChildren[0].id).toBe(experimentId)

    const experiment = await repo.load(experimentId)
    expect(experiment?.parentId).toBe(pageId)
    expect(experiment?.properties[FIELD.intervention]).toBe('glycine')
    expect(experiment?.properties[FIELD.doseText]).toBe(testSpec.doseText)
    expect(experiment?.properties[FIELD.control]).toBe('placebo')
    expect(experiment?.properties[FIELD.startDate]).toBe(dayToDate('2026-02-01').toISOString())
    expect(experiment?.properties[FIELD.periodNights]).toBe(3)
    expect(experiment?.properties[FIELD.pairs]).toBe(2)
    expect(experiment?.properties[FIELD.seed]).toBe(7)
    expect(experiment?.properties[FIELD.experimentStatus]).toBe('running')

    // The engine's own schedule for this spec — verifying storage against
    // it, not re-deriving the PRNG's answer by hand.
    const expectedPeriods = buildSchedule(testSpec)
    expect(expectedPeriods).toHaveLength(testSpec.pairs * 2)

    const periodChildren = (await repo.block(experimentId).children.load()) ?? []
    expect(periodChildren).toHaveLength(expectedPeriods.length)
    // Schedule order: children land in the same order buildSchedule emits.
    expectedPeriods.forEach((period, i) => {
      const child = periodChildren[i]
      expect(child.properties[FIELD.index]).toBe(period.index)
      expect(child.properties[FIELD.pair]).toBe(period.pair)
      expect(child.properties[FIELD.arm]).toBe(period.arm)
      // Local noon, like every other stored wake date in this extension.
      expect(child.properties[FIELD.from]).toBe(dayToDate(period.from).toISOString())
      expect(child.properties[FIELD.to]).toBe(dayToDate(period.to).toISOString())
    })

    // Each pair holds one of each arm.
    const armsByPair = new Map<number, Set<string>>()
    for (const period of expectedPeriods) {
      const arms = armsByPair.get(period.pair) ?? new Set<string>()
      arms.add(period.arm)
      armsByPair.set(period.pair, arms)
    }
    expect(armsByPair.size).toBe(testSpec.pairs)
    for (const arms of armsByPair.values()) expect(arms).toEqual(new Set(['intervention', 'control']))
  })

  it('round-trips through readExperiments: periods sorted by index, dates as YYYY-MM-DD', async () => {
    const pageId = await labPageId()
    const testSpec = spec({pairs: 3, seed: 42})
    const experimentId = await createExperiment(repo, pageId, testSpec)

    const experiments = await readExperiments(repo, WORKSPACE_ID)
    expect(experiments).toHaveLength(1)
    const [experiment] = experiments
    expect(experiment.id).toBe(experimentId)
    expect(experiment.intervention).toBe('glycine')
    expect(experiment.doseText).toBe(testSpec.doseText)
    expect(experiment.control).toBe('placebo')
    expect(experiment.startDate).toBe('2026-02-01')
    expect(experiment.periodNights).toBe(3)
    expect(experiment.pairs).toBe(3)
    expect(experiment.seed).toBe(42)
    expect(experiment.status).toBe('running')

    expect(experiment.periods.map(p => p.index)).toEqual([1, 2, 3, 4, 5, 6])
    for (const period of experiment.periods) {
      expect(period.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(period.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('runningExperiment', {timeout: 30_000}, () => {
  it('skips done and planned experiments and returns the one still running', async () => {
    const pageId = await labPageId()
    const doneId = await createExperiment(repo, pageId, spec({intervention: 'done-one', startDate: '2026-01-01'}))
    const plannedId = await createExperiment(repo, pageId, spec({intervention: 'planned-one', startDate: '2026-01-10'}))
    const runningId = await createExperiment(repo, pageId, spec({intervention: 'running-one', startDate: '2026-01-20'}))

    await repo.tx(tx => tx.setProperty(doneId, experimentStatusProp, 'done'),
      {scope: ChangeScope.BlockDefault, description: 'mark done'})
    await repo.tx(tx => tx.setProperty(plannedId, experimentStatusProp, 'planned'),
      {scope: ChangeScope.BlockDefault, description: 'mark planned'})

    const experiments = await readExperiments(repo, WORKSPACE_ID)
    expect(experiments).toHaveLength(3)
    expect(runningExperiment(experiments)?.id).toBe(runningId)
  })

  it('is undefined when nothing is running', async () => {
    const pageId = await labPageId()
    const id = await createExperiment(repo, pageId, spec())
    await repo.tx(tx => tx.setProperty(id, experimentStatusProp, 'done'),
      {scope: ChangeScope.BlockDefault, description: 'mark done'})

    expect(runningExperiment(await readExperiments(repo, WORKSPACE_ID))).toBeUndefined()
  })
})

describe('stampNight — schedule edges', {timeout: 30_000}, () => {
  it('assignment "none" for a date outside every period, though the night is still created', async () => {
    const pageId = await labPageId()
    // periodNights=3, pairs=1: schedule covers 2026-02-01..2026-02-06.
    await createExperiment(repo, pageId, spec({pairs: 1, startDate: '2026-02-01'}))

    const result = await stampNight(repo, WORKSPACE_ID, '2026-03-01')
    expect(result.assignment).toBe('none')
    expect(result.arm).toBeUndefined()
    expect(result.doseId).toBeUndefined()

    const night = await repo.load(result.nightId)
    expect(night).not.toBeNull()
    expect(night?.properties[FIELD.arm]).toBeUndefined()
    expect(night?.properties[FIELD.experiment]).toBeUndefined()
    expect(night?.properties[FIELD.period]).toBeUndefined()
  })

  it('assignment "none" and no refs written when the covering period is deleted between the schedule read and the write', async () => {
    const pageId = await labPageId()
    await createExperiment(repo, pageId, spec({pairs: 1, startDate: '2026-02-01'}))
    const date = '2026-02-01'

    const [experiment] = await readExperiments(repo, WORKSPACE_ID)
    const period = experiment.periods.find(p => p.from <= date && date <= p.to)
    expect(period).toBeDefined()

    // `stampNight` reads the schedule (via `readExperiments`, one
    // `queryBlocks` call) BEFORE opening its write transaction, then
    // re-checks inside the tx that the period is still live — see its own
    // doc comment: "The schedule was read before this transaction; the
    // period must still be there before the night is bound to it." Pin
    // THAT clause specifically: let the one `queryBlocks` call resolve
    // (schedule read succeeds, period found), then delete the period
    // before `stampNight`'s subsequent `tx.get(period.id)` re-check runs —
    // simulating deletion landing in exactly that window.
    const originalQueryBlocks = repo.queryBlocks.bind(repo)
    const raceSpy = vi.spyOn(repo, 'queryBlocks').mockImplementationOnce(async query => {
      const rows = await originalQueryBlocks(query)
      await repo.tx(tx => tx.run(deleteBlock, {id: period!.id}),
        {scope: ChangeScope.BlockDefault, description: 'simulate concurrent period delete'})
      return rows
    })

    const result = await stampNight(repo, WORKSPACE_ID, date)
    expect(raceSpy).toHaveBeenCalledTimes(1)
    raceSpy.mockRestore()

    expect(result.assignment).toBe('none')
    expect(result.arm).toBeUndefined()
    expect(result.doseId).toBeUndefined()

    const night = await repo.load(result.nightId)
    expect(night?.properties[FIELD.arm]).toBeUndefined()
    expect(night?.properties[FIELD.experiment]).toBeUndefined()
    expect(night?.properties[FIELD.period]).toBeUndefined()
  })
})

describe('stampNight — revalidates inside the write, not just the period\'s existence', {timeout: 30_000}, () => {
  it('assignment "none" when the experiment is marked done between the schedule read and the write', async () => {
    const pageId = await labPageId()
    const experimentId = await createExperiment(repo, pageId, spec({pairs: 1, startDate: '2026-02-01'}))
    const date = '2026-02-01'

    // Same race shape as the period-deleted test above: let the one
    // `queryBlocks` call behind `readExperiments` resolve, then flip the
    // experiment's status before `stampNight`'s own `tx.get(experiment.id)`
    // re-check runs.
    const originalQueryBlocks = repo.queryBlocks.bind(repo)
    const raceSpy = vi.spyOn(repo, 'queryBlocks').mockImplementationOnce(async query => {
      const rows = await originalQueryBlocks(query)
      await repo.tx(tx => tx.setProperty(experimentId, experimentStatusProp, 'done'),
        {scope: ChangeScope.BlockDefault, description: 'simulate concurrent status flip'})
      return rows
    })

    const result = await stampNight(repo, WORKSPACE_ID, date)
    expect(raceSpy).toHaveBeenCalledTimes(1)
    raceSpy.mockRestore()

    expect(result.assignment).toBe('none')
    expect(result.arm).toBeUndefined()
    expect(result.doseId).toBeUndefined()

    const night = await repo.load(result.nightId)
    expect(night?.properties[FIELD.arm]).toBeUndefined()
    expect(night?.properties[FIELD.experiment]).toBeUndefined()
    expect(night?.properties[FIELD.period]).toBeUndefined()
  })

  it('assignment "none" when the period is shrunk to no longer cover the date between the read and the write', async () => {
    const pageId = await labPageId()
    await createExperiment(repo, pageId, spec({pairs: 1, startDate: '2026-02-01'}))
    const date = '2026-02-01'

    const [experiment] = await readExperiments(repo, WORKSPACE_ID)
    const period = experiment.periods.find(p => p.from <= date && date <= p.to)
    expect(period).toBeDefined()

    const originalQueryBlocks = repo.queryBlocks.bind(repo)
    const raceSpy = vi.spyOn(repo, 'queryBlocks').mockImplementationOnce(async query => {
      const rows = await originalQueryBlocks(query)
      // Move `to` to the day before the date being stamped — the period no
      // longer covers it by the time the write re-reads it.
      await repo.tx(tx => tx.setProperty(period!.id, toProp, dayToDate('2026-01-31')),
        {scope: ChangeScope.BlockDefault, description: 'simulate concurrent period shrink'})
      return rows
    })

    const result = await stampNight(repo, WORKSPACE_ID, date)
    expect(raceSpy).toHaveBeenCalledTimes(1)
    raceSpy.mockRestore()

    expect(result.assignment).toBe('none')
    expect(result.arm).toBeUndefined()
    expect(result.doseId).toBeUndefined()

    const night = await repo.load(result.nightId)
    expect(night?.properties[FIELD.arm]).toBeUndefined()
    expect(night?.properties[FIELD.experiment]).toBeUndefined()
    expect(night?.properties[FIELD.period]).toBeUndefined()
  })

  it('assigns the FLIPPED arm (and its matching dose) when the period\'s arm changes between the read and the write', async () => {
    const pageId = await labPageId()
    const testSpec = spec({pairs: 1, startDate: '2026-02-01', control: 'placebo'})
    await createExperiment(repo, pageId, testSpec)
    const date = '2026-02-01'

    const [experiment] = await readExperiments(repo, WORKSPACE_ID)
    const period = experiment.periods.find(p => p.from <= date && date <= p.to)
    expect(period).toBeDefined()
    const flippedArm: Arm = period!.arm === 'intervention' ? 'control' : 'intervention'

    const originalQueryBlocks = repo.queryBlocks.bind(repo)
    const raceSpy = vi.spyOn(repo, 'queryBlocks').mockImplementationOnce(async query => {
      const rows = await originalQueryBlocks(query)
      await repo.tx(tx => tx.setProperty(period!.id, armProp, flippedArm),
        {scope: ChangeScope.BlockDefault, description: 'simulate concurrent arm flip'})
      return rows
    })

    const result = await stampNight(repo, WORKSPACE_ID, date)
    expect(raceSpy).toHaveBeenCalledTimes(1)
    raceSpy.mockRestore()

    // The night is bound to what the period says NOW — the flipped arm, not
    // the one `readExperiments` saw before the race.
    expect(result.assignment).toBe('assigned')
    expect(result.arm).toBe(flippedArm)

    const night = await repo.load(result.nightId)
    expect(night?.properties[FIELD.arm]).toBe(flippedArm)

    // Placebo control: both arms carry a dose, but with different content —
    // so this also pins that the dose was written for the flipped arm, not
    // the one read before the race.
    expect(result.doseId).toBeDefined()
    const dose = await repo.load(result.doseId!)
    expect(dose?.content).toBe(flippedArm === 'intervention' ? testSpec.doseText : 'Placebo dose')
  })
})

describe('stampSchedule — refuses without a dose text', {timeout: 30_000}, () => {
  it('is unreadable with "Set the dose text first." for a blank dose text, and writes no period children', async () => {
    const pageId = await labPageId()
    // Start date is set (the earlier "Set a start date first." refusal does
    // not apply); dose text is left at its default, blank.
    const experimentId = await handMakeExperiment(pageId)

    const outcome = await stampSchedule(repo, experimentId)
    expect(outcome).toEqual({status: 'unreadable', reason: 'Set the dose text first.'})

    const children = (await repo.block(experimentId).children.load()) ?? []
    expect(children.filter(child => !child.deleted)).toHaveLength(0)
    // Status was not touched either — still 'planned', never bumped to 'running'.
    expect((await repo.load(experimentId))?.properties[FIELD.experimentStatus]).toBe('planned')
  })

  it('stamps normally once the dose text is set', async () => {
    const pageId = await labPageId()
    const experimentId = await handMakeExperiment(pageId, {doseText: '3 g glycine before bed'})

    const outcome = await stampSchedule(repo, experimentId)
    expect(outcome.status).toBe('stamped')
    if (outcome.status !== 'stamped') throw new Error('unreachable')
    expect(outcome.periods).toBeGreaterThan(0)

    const children = (await repo.block(experimentId).children.load()) ?? []
    expect(children.filter(child => !child.deleted && hasBlockType(child, PERIOD_TYPE))).toHaveLength(outcome.periods)
    expect((await repo.load(experimentId))?.properties[FIELD.experimentStatus]).toBe('running')
  })
})

describe('stampNight — a night stays on its original experiment', {timeout: 30_000}, () => {
  it('keeps the night bound to experiment A, adding no dose, when a second running experiment (B) later covers the same date', async () => {
    const pageId = await labPageId()
    const date = '2026-03-01'

    // Experiment A: open-label, control arm — stamping it adds no dose.
    const experimentAId = await seedExperiment(pageId, [
      {index: 1, pair: 1, arm: 'control', from: date, to: date},
    ], {control: 'nothing'})

    const first = await stampNight(repo, WORKSPACE_ID, date)
    expect(first.assignment).toBe('assigned')
    expect(first.arm).toBe('control')
    expect(first.doseId).toBeUndefined()
    expect(await doseChildrenOf(first.nightId)).toHaveLength(0)

    // A is done; B starts, placebo-controlled, and its own schedule covers
    // the SAME date — the overlap the README's data model section warns
    // stampNight must not let a second schedule reach into.
    await repo.tx(tx => tx.setProperty(experimentAId, experimentStatusProp, 'done'),
      {scope: ChangeScope.BlockDefault, description: 'mark A done'})
    const experimentBId = await seedExperiment(pageId, [
      {index: 1, pair: 1, arm: 'control', from: date, to: date},
    ], {control: 'placebo'})
    expect((await readExperiments(repo, WORKSPACE_ID)).find(e => e.id === experimentBId)?.status).toBe('running')

    const second = await stampNight(repo, WORKSPACE_ID, date)
    expect(second.nightId).toBe(first.nightId)
    expect(second.assignment).toBe('already')
    // B is placebo-controlled and this night's (kept) arm is control — B's
    // rule would stamp a placebo dose. None was: this night is not B's.
    expect(second.doseId).toBeUndefined()

    const night = await repo.load(first.nightId)
    expect(night?.properties[FIELD.experiment]).toBe(experimentAId)
    expect(night?.properties[FIELD.experiment]).not.toBe(experimentBId)
    expect(await doseChildrenOf(first.nightId)).toHaveLength(0)
  })
})
