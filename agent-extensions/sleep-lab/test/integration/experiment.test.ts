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

import {ChangeScope} from '@/data/api'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {deleteBlock} from '@/data/mutators'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {statusProp as todoStatusProp, todoType} from '@/plugins/todo/schema'

import {buildSchedule} from '../../src/engine/schedule'
import {dayToDate} from '../../src/km/day'
import {createExperiment, readExperiments, runningExperiment, stampNight, type ExperimentSpec} from '../../src/km/experiment'
import {FIELD} from '../../src/km/fields'
import {getOrCreateLabPage} from '../../src/km/page'
import {SLEEPLAB_PROPS, SLEEPLAB_TYPES, experimentStatusProp} from '../../src/km/schema'

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
