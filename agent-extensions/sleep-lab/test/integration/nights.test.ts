/** Integration tier for the night/session/dose write path (`src/km/nights.ts`)
 *  against a real `Repo` — see `../../../strength-tracker/test/integration/
 *  strengthWrites.test.ts` for the harness this mirrors.
 *
 *  The lab page is bootstrapped the way production does — `getOrCreateLabPage`,
 *  a kernel page — rather than a hand-planted plain block, so these tests
 *  also cover that `LAB_TYPE` + the kernel's own `PAGE_TYPE`/aliases wiring
 *  is enough for the page to come into being with only `SLEEPLAB_TYPES` /
 *  `SLEEPLAB_PROPS` registered alongside the built-in todo.
 *
 *  `{timeout: 30_000}` on every describe here is headroom, not a measured
 *  need: this file's 13 tests run in well under 1s combined against a
 *  shared in-memory db (measured wall-clock for the whole file, including
 *  db setup: ~0.4s). Budgeted per AGENTS.md's load-multiplier note anyway,
 *  since a `repo.tx`-per-test integration file is exactly the shape that
 *  stretches under a fully-loaded gate.
 */
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'

import {ChangeScope, propertyValue} from '@/data/api'
import type {BlockData} from '@/data/api'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {deleteBlock} from '@/data/mutators'
import {hasBlockType} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {createTypedChild, derivedBlockId} from '@/data/typedRecords'
import {statusProp as todoStatusProp, todoType} from '@/plugins/todo/schema'

import {stampNight} from '../../src/km/experiment'
import {dayToDate} from '../../src/km/day'
import {
  DOSE_TYPE, EXPERIMENT_TYPE, FIELD, NIGHT_TYPE, PERIOD_TYPE, SESSION_TYPE,
  type Arm, type ControlKind, type ExperimentStatus,
} from '../../src/km/fields'
import {
  getOrCreateNightInTx, importSessions, mainFlagsMatchHeuristic, markDoseTaken, nightIdentity,
  writeCovariates, writeRating,
} from '../../src/km/nights'
import {getOrCreateLabPage} from '../../src/km/page'
import {asSession, buildNights, trainedDays} from '../../src/km/records'
import {
  SLEEPLAB_PROPS, SLEEPLAB_TYPES,
  armProp, controlProp, dateProp, doseTextProp, experimentStatusProp, fromProp, indexProp, interventionProp,
  mainProp, pairProp, pairsProp, periodNightsProp, seedProp, startDateProp, toProp,
} from '../../src/km/schema'
import type {ImportedSession, Stage} from '../../src/engine/types'

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

const liveChildren = async (parentId: string, typeId: string): Promise<BlockData[]> =>
  ((await repo.block(parentId).children.load()) ?? [])
    .filter(row => !row.deleted && hasBlockType(row, typeId))

/** Local wall-clock instant — the watch reports in local time, and the
 *  suite runs under TZ=America/Los_Angeles (see vitest.integration.config.ts). */
const local = (y: number, m: number, d: number, h: number, mi = 0, s = 0): Date => new Date(y, m - 1, d, h, mi, s)

const sleepSession = (start: Date, end: Date, over: Partial<ImportedSession> = {}): ImportedSession => ({
  source: 'health-connect',
  start,
  end,
  // A single stage spanning the whole window is enough to exercise
  // `deriveMeasures`'s stage-derived numbers without re-testing its own
  // arithmetic (covered by `test/derive.test.ts`).
  stages: [{kind: 'light', start, end} satisfies Stage],
  heartRate: [], hrv: [], spo2: [], skinTemp: [], respRate: [],
  ...over,
})

interface SeedPeriodSpec { index: number; pair: number; arm: Arm; from: string; to: string }

/** An experiment + its periods, built directly rather than through
 *  `createExperiment` (covered in `experiment.test.ts`) so a test can pick
 *  the exact arm/date coverage it needs instead of reverse-engineering a
 *  PRNG seed. Same primitives `createExperiment` itself uses. */
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

describe('stampNight — with no running experiment', {timeout: 30_000}, () => {
  it('creates one night block, converges on the same id, and adds nothing on a repeat call', async () => {
    const pageId = await labPageId()
    const before = (await repo.block(pageId).children.load()) ?? []

    const first = await stampNight(repo, WORKSPACE_ID, '2026-02-10')
    expect(first.assignment).toBe('none')
    expect(first.arm).toBeUndefined()
    expect(first.nightId).toBe(derivedBlockId(nightIdentity(WORKSPACE_ID, '2026-02-10')))

    const block = await repo.load(first.nightId)
    expect(block?.content).toBe('Night of 2026-02-09 → 2026-02-10')
    expect(block?.properties[FIELD.date]).toBe(dayToDate('2026-02-10').toISOString())
    expect(block?.properties[FIELD.arm]).toBeUndefined()

    const afterFirst = (await repo.block(pageId).children.load()) ?? []
    expect(afterFirst).toHaveLength(before.length + 1)

    const second = await stampNight(repo, WORKSPACE_ID, '2026-02-10')
    expect(second.nightId).toBe(first.nightId)

    const afterSecond = (await repo.block(pageId).children.load()) ?? []
    expect(afterSecond).toHaveLength(afterFirst.length)
  })
})

describe('importSessions', {timeout: 30_000}, () => {
  it('creates one night and two session blocks: the long one main, the nap not, both with numeric measures', async () => {
    const sleep = sleepSession(local(2026, 2, 9, 0, 0), local(2026, 2, 9, 7, 0)) // 7h, ends 07:00 — qualifies as main
    const nap = sleepSession(local(2026, 2, 9, 13, 0), local(2026, 2, 9, 13, 40)) // 40min — too short to qualify

    const report = await importSessions(repo, WORKSPACE_ID, [sleep, nap])
    expect(report).toEqual({nights: 1, created: 2, updated: 0, failed: []})

    const nightId = derivedBlockId(nightIdentity(WORKSPACE_ID, '2026-02-09'))
    const sessions = await liveChildren(nightId, SESSION_TYPE)
    expect(sessions).toHaveLength(2)

    const main = sessions.find(s => s.properties[FIELD.main] === true)
    const napBlock = sessions.find(s => s.properties[FIELD.main] === false)
    expect(main?.content.startsWith('Sleep')).toBe(true)
    expect(napBlock?.content.startsWith('Nap')).toBe(true)
    expect(main?.properties[FIELD.sleepMinutes]).toBe(420)
    expect(typeof main?.properties[FIELD.sleepMinutes]).toBe('number')
    expect(napBlock?.properties[FIELD.sleepMinutes]).toBe(40)
    expect(typeof napBlock?.properties[FIELD.sleepMinutes]).toBe('number')
  })

  it('re-importing the same session reports `updated`, not `created`, with the block count unchanged', async () => {
    const end = local(2026, 2, 9, 7, 0)
    const first = await importSessions(repo, WORKSPACE_ID, [sleepSession(local(2026, 2, 9, 0, 41, 0), end)])
    expect(first).toEqual({nights: 1, created: 1, updated: 0, failed: []})

    const nightId = derivedBlockId(nightIdentity(WORKSPACE_ID, '2026-02-09'))
    expect(await liveChildren(nightId, SESSION_TYPE)).toHaveLength(1)

    // Session identity is keyed to the start MINUTE: 20s later is the same
    // minute, so this converges onto the same block and reports `updated`.
    const sameMinute = await importSessions(repo, WORKSPACE_ID, [sleepSession(local(2026, 2, 9, 0, 41, 20), end)])
    expect(sameMinute).toEqual({nights: 1, created: 0, updated: 1, failed: []})
    expect(await liveChildren(nightId, SESSION_TYPE)).toHaveLength(1)

    // 2 minutes later is a DIFFERENT minute, so a second, distinct block.
    const nextMinute = await importSessions(repo, WORKSPACE_ID, [sleepSession(local(2026, 2, 9, 0, 43, 0), end)])
    expect(nextMinute).toEqual({nights: 1, created: 1, updated: 0, failed: []})
    expect(await liveChildren(nightId, SESSION_TYPE)).toHaveLength(2)
  })

  it('attaches to a night block that stampNight already created, never a second night', async () => {
    const stamped = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    await importSessions(repo, WORKSPACE_ID, [sleepSession(local(2026, 2, 9, 0, 0), local(2026, 2, 9, 7, 0))])

    const pageId = await labPageId()
    const nights = await liveChildren(pageId, NIGHT_TYPE)
    expect(nights).toHaveLength(1)
    expect(nights[0].id).toBe(stamped.nightId)
  })
})

describe('stampNight — with a running experiment', {timeout: 30_000}, () => {
  it('assigns arm and refs from the covering period, with a dose only when the arm calls for one', async () => {
    const pageId = await labPageId()
    await seedExperiment(pageId, [
      {index: 1, pair: 1, arm: 'intervention', from: '2026-02-09', to: '2026-02-11'},
      {index: 2, pair: 1, arm: 'control', from: '2026-02-12', to: '2026-02-14'},
    ], {control: 'nothing'})

    const interventionNight = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    expect(interventionNight.assignment).toBe('assigned')
    expect(interventionNight.arm).toBe('intervention')

    const block = await repo.load(interventionNight.nightId)
    expect(block?.properties[FIELD.arm]).toBe('intervention')
    expect(typeof block?.properties[FIELD.experiment]).toBe('string')
    expect(typeof block?.properties[FIELD.period]).toBe('string')

    expect(interventionNight.doseId).toBeDefined()
    const dose = await repo.load(interventionNight.doseId!)
    expect(dose && hasBlockType(dose, DOSE_TYPE)).toBe(true)
    expect(dose && hasBlockType(dose, 'todo')).toBe(true)
    expect(dose?.properties[FIELD.todoStatus]).toBe('open')
    expect(dose?.content).toBe('3 g glycine before bed')

    // Control + 'nothing' control kind: no dose child at all.
    const controlNight = await stampNight(repo, WORKSPACE_ID, '2026-02-12')
    expect(controlNight.arm).toBe('control')
    expect(controlNight.doseId).toBeUndefined()
    expect(await liveChildren(controlNight.nightId, DOSE_TYPE)).toHaveLength(0)

    // Second call on the intervention night: idempotent.
    const again = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    expect(again.assignment).toBe('already')
    expect(await liveChildren(interventionNight.nightId, DOSE_TYPE)).toHaveLength(1)
  })

  it('stamps a placebo dose on a control night when the experiment is placebo-controlled', async () => {
    const pageId = await labPageId()
    await seedExperiment(pageId, [
      {index: 1, pair: 1, arm: 'control', from: '2026-02-09', to: '2026-02-11'},
    ], {control: 'placebo'})

    const night = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    expect(night.arm).toBe('control')
    expect(night.doseId).toBeDefined()
    const dose = await repo.load(night.doseId!)
    expect(dose?.content).toBe('Placebo dose')
  })
})

describe('stampNight — never relabels', {timeout: 30_000}, () => {
  it('keeps a hand-set arm even when the schedule disagrees, and doses to match the KEPT arm', async () => {
    const pageId = await labPageId()
    await seedExperiment(pageId, [
      {index: 1, pair: 1, arm: 'intervention', from: '2026-02-09', to: '2026-02-11'},
    ], {control: 'placebo'})

    const nightId = await repo.tx(async tx => {
      const typeSnapshot = repo.snapshotTypeRegistries()
      const id = await getOrCreateNightInTx(repo, tx, {workspaceId: WORKSPACE_ID, pageId, date: '2026-02-09', typeSnapshot})
      // The schedule says intervention; this night was slept under control.
      await tx.setProperty(id, armProp, 'control')
      return id
    }, {scope: ChangeScope.BlockDefault, description: 'hand-set arm'})

    const result = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    expect(result.nightId).toBe(nightId)
    expect(result.assignment).toBe('already')
    expect(result.arm).toBe('control')
    expect((await repo.load(nightId))?.properties[FIELD.arm]).toBe('control')

    // Dose matches the KEPT arm (control, placebo-controlled → a placebo
    // dose), never the period's arm (intervention).
    expect(result.doseId).toBeDefined()
    const dose = await repo.load(result.doseId!)
    expect(dose?.content).toBe('Placebo dose')
  })
})

describe('markDoseTaken', {timeout: 30_000}, () => {
  const seatIntervention = async (): Promise<string> => {
    const pageId = await labPageId()
    await seedExperiment(pageId, [{index: 1, pair: 1, arm: 'intervention', from: '2026-02-09', to: '2026-02-11'}])
    const {doseId} = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    return doseId!
  }

  it('flips the todo to done and stamps takenAt', async () => {
    const doseId = await seatIntervention()
    const now = 1_800_000_000_000

    expect(await markDoseTaken(repo, doseId, now)).toBe('written')
    const dose = await repo.load(doseId)
    expect(dose?.properties[FIELD.todoStatus]).toBe('done')
    expect(dose?.properties[FIELD.takenAt]).toBe(now)
  })

  it('returns "gone" and writes nothing for a deleted dose', async () => {
    const doseId = await seatIntervention()
    await repo.tx(tx => tx.run(deleteBlock, {id: doseId}), {scope: ChangeScope.BlockDefault, description: 'delete dose'})

    expect(await markDoseTaken(repo, doseId, 123)).toBe('gone')
  })
})

describe('writeRating and writeCovariates', {timeout: 30_000}, () => {
  it('writeRating writes a value and clears it back out on null', async () => {
    const {nightId} = await stampNight(repo, WORKSPACE_ID, '2026-02-09')

    expect(await writeRating(repo, nightId, 'quality', 4)).toBe('written')
    expect((await repo.load(nightId))?.properties[FIELD.quality]).toBe(4)

    expect(await writeRating(repo, nightId, 'quality', null)).toBe('written')
    expect((await repo.load(nightId))?.properties[FIELD.quality]).toBeUndefined()
  })

  it('writeCovariates touches only the keys named in the patch', async () => {
    const {nightId} = await stampNight(repo, WORKSPACE_ID, '2026-02-09')

    expect(await writeCovariates(repo, nightId, {caffeineLate: true})).toBe('written')
    const first = await repo.load(nightId)
    expect(first?.properties[FIELD.caffeineLate]).toBe(true)
    expect(first?.properties[FIELD.lateMeal]).toBeUndefined()
    expect(first?.properties[FIELD.alcohol]).toBeUndefined()

    expect(await writeCovariates(repo, nightId, {alcohol: 2, unusual: true, unusualReason: 'travel'})).toBe('written')
    const second = await repo.load(nightId)
    expect(second?.properties[FIELD.alcohol]).toBe(2)
    expect(second?.properties[FIELD.caffeineLate]).toBe(true) // untouched by this call
    expect(second?.properties[FIELD.unusual]).toBe(true)
    expect(second?.properties[FIELD.unusualReason]).toBe('travel')

    expect(await writeCovariates(repo, nightId, {alcohol: null, unusualReason: null})).toBe('written')
    const third = await repo.load(nightId)
    expect(third?.properties[FIELD.alcohol]).toBeUndefined()
    expect(third?.properties[FIELD.unusualReason]).toBeUndefined()
  })

  it('both return "gone" for a deleted night', async () => {
    const {nightId} = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    await repo.tx(tx => tx.run(deleteBlock, {id: nightId}), {scope: ChangeScope.BlockDefault, description: 'delete night'})

    expect(await writeRating(repo, nightId, 'quality', 3)).toBe('gone')
    expect(await writeCovariates(repo, nightId, {alcohol: 1})).toBe('gone')
  })
})

describe('buildNights — end to end against a real query', {timeout: 30_000}, () => {
  it('joins sessions, dose, period and trained across a real queryBlocks result', async () => {
    const pageId = await labPageId()
    await seedExperiment(pageId, [
      {index: 1, pair: 1, arm: 'intervention', from: '2026-02-09', to: '2026-02-10'},
      {index: 2, pair: 1, arm: 'control', from: '2026-02-11', to: '2026-02-11'},
    ], {control: 'nothing'})

    await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    const night10 = await stampNight(repo, WORKSPACE_ID, '2026-02-10')
    await stampNight(repo, WORKSPACE_ID, '2026-02-11')

    await importSessions(repo, WORKSPACE_ID, [
      sleepSession(local(2026, 2, 9, 0, 0), local(2026, 2, 9, 7, 0)),
      sleepSession(local(2026, 2, 9, 13, 0), local(2026, 2, 9, 13, 40)),
    ])

    expect(night10.doseId).toBeDefined()
    await markDoseTaken(repo, night10.doseId!)

    // A strength session logged on 02-09, written the way a synced row
    // arrives: raw properties via `tx.create`, no typed-record machinery and
    // no type registration — `block_types` is trigger-derived off the
    // `properties.types` JSON array (see AGENTS.md's data-model-grain note
    // on writing a row "exactly the shape a synced row has").
    await repo.tx(tx => tx.create({
      id: 'workout-1',
      workspaceId: WORKSPACE_ID,
      parentId: pageId,
      orderKey: 'z9',
      content: 'Workout',
      properties: {
        types: ['strength-workout'],
        'strength:date': dayToDate('2026-02-09'),
        'strength:status': 'done',
      },
    }), {scope: ChangeScope.BlockDefault, description: 'seed strength workout'})

    const rows = await repo.queryBlocks({
      workspaceId: WORKSPACE_ID,
      types: [NIGHT_TYPE, SESSION_TYPE, DOSE_TYPE, PERIOD_TYPE, 'strength-workout'],
    })
    const trained = trainedDays(rows)
    const nights = buildNights(rows, trained)

    expect(nights.map(n => n.date)).toEqual(['2026-02-09', '2026-02-10', '2026-02-11'])
    const [n9, n10, n11] = nights

    expect(n9.periodIndex).toBe(1)
    expect(n9.pair).toBe(1)
    expect(n9.transition).toBe(true) // first night of period 1
    expect(n9.trained).toBe(true)
    expect(n9.doseTaken).toBe(false) // dose exists (intervention night), not ticked
    expect(n9.main?.measures.sleepMinutes).toBe(420)
    expect(n9.naps).toHaveLength(1)

    expect(n10.periodIndex).toBe(1)
    expect(n10.transition).toBe(false) // second night of period 1
    expect(n10.trained).toBe(false)
    expect(n10.doseTaken).toBe(true) // ticked above
    expect(n10.main).toBeUndefined()
    expect(n10.naps).toHaveLength(0)

    expect(n11.periodIndex).toBe(2)
    expect(n11.pair).toBe(1)
    expect(n11.transition).toBe(true) // first (and only) night of period 2
    expect(n11.doseTaken).toBeUndefined() // control + 'nothing': no dose block at all
    expect(n11.trained).toBe(false)
  })
})

// ──── Fixes pinned below: assignNightInTx's refs-even-when-preset behaviour,
// settleMainInTx's hand-flip stability, the taken-seat re-mint-then-converge
// path in upsertSessionInTx, importSessions' per-night failure isolation, and
// the hasBlockType re-check inside writeRating/writeCovariates/markDoseTaken. ────

describe('assignNightInTx — a pre-set arm still gets its refs', {timeout: 30_000}, () => {
  it('keeps a hand-set arm (never relabels) but still writes the experiment/period refs, reporting "already"', async () => {
    const pageId = await labPageId()
    await seedExperiment(pageId, [
      {index: 1, pair: 1, arm: 'intervention', from: '2026-02-09', to: '2026-02-11'},
    ], {control: 'nothing'})

    // Hand-set the arm BEFORE stampNight ever sees this night — as if the
    // night were logged by hand, ahead of the schedule reaching it.
    const nightId = await repo.tx(async tx => {
      const typeSnapshot = repo.snapshotTypeRegistries()
      const id = await getOrCreateNightInTx(repo, tx, {workspaceId: WORKSPACE_ID, pageId, date: '2026-02-09', typeSnapshot})
      await tx.setProperty(id, armProp, 'control')
      return id
    }, {scope: ChangeScope.BlockDefault, description: 'hand-set arm before stamping'})

    const result = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    expect(result.assignment).toBe('already')
    expect(result.arm).toBe('control') // the hand-set arm, never relabelled to the schedule's 'intervention'

    const night = await repo.load(nightId)
    expect(night?.properties[FIELD.arm]).toBe('control')
    // The refs land regardless: without them the analysis, which reads
    // nights by experiment, would never see this one.
    expect(typeof night?.properties[FIELD.experiment]).toBe('string')
    expect(typeof night?.properties[FIELD.period]).toBe('string')
  })

  it('leaves every property untouched when the night already has both the arm and the refs', async () => {
    const pageId = await labPageId()
    await seedExperiment(pageId, [
      {index: 1, pair: 1, arm: 'intervention', from: '2026-02-09', to: '2026-02-11'},
    ], {control: 'nothing'})

    // First stamp assigns the arm and the refs normally.
    const first = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    expect(first.assignment).toBe('assigned')
    const before = (await repo.load(first.nightId))?.properties

    // Second stamp: both `armProp` and the refs are already strings, so
    // `assignNightInTx`'s two `if`s and its `preset` branch all skip their
    // writes — nothing should change.
    const second = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    expect(second.assignment).toBe('already')

    const after = (await repo.load(first.nightId))?.properties
    expect(after).toEqual(before)
  })
})

describe('settleMainInTx — a hand-flipped main flag is a record, not a suggestion', {timeout: 30_000}, () => {
  it('survives a re-import of the same two sessions', async () => {
    const sleep = sleepSession(local(2026, 2, 9, 0, 0), local(2026, 2, 9, 7, 0))
    const nap = sleepSession(local(2026, 2, 9, 13, 0), local(2026, 2, 9, 13, 40))

    await importSessions(repo, WORKSPACE_ID, [sleep, nap])
    const nightId = derivedBlockId(nightIdentity(WORKSPACE_ID, '2026-02-09'))
    const before = await liveChildren(nightId, SESSION_TYPE)
    const sleepBlock = before.find(s => s.content.startsWith('Sleep'))!
    const napBlock = before.find(s => s.content.startsWith('Nap'))!
    expect(sleepBlock.properties[FIELD.main]).toBe(true)
    expect(napBlock.properties[FIELD.main]).toBe(false)

    // Flip by hand — the README's answer to a night slept in another zone.
    await repo.tx(async tx => {
      await tx.setProperty(sleepBlock.id, mainProp, false)
      await tx.setProperty(napBlock.id, mainProp, true)
    }, {scope: ChangeScope.BlockDefault, description: 'hand-flip main'})

    const again = await importSessions(repo, WORKSPACE_ID, [sleep, nap])
    expect(again).toEqual({nights: 1, created: 0, updated: 2, failed: []})

    const after = await liveChildren(nightId, SESSION_TYPE)
    expect(after.find(s => s.id === napBlock.id)?.properties[FIELD.main]).toBe(true)
    expect(after.find(s => s.id === sleepBlock.id)?.properties[FIELD.main]).toBe(false)
  })

  it('still settles once the long sleep arrives, even though the nap alone (imported first) qualified for nothing', async () => {
    const nap = sleepSession(local(2026, 2, 9, 13, 0), local(2026, 2, 9, 13, 40))
    const sleep = sleepSession(local(2026, 2, 9, 0, 0), local(2026, 2, 9, 7, 0))

    const first = await importSessions(repo, WORKSPACE_ID, [nap])
    expect(first).toEqual({nights: 1, created: 1, updated: 0, failed: []})
    const nightId = derivedBlockId(nightIdentity(WORKSPACE_ID, '2026-02-09'))
    const afterNap = await liveChildren(nightId, SESSION_TYPE)
    expect(afterNap).toHaveLength(1)
    // `pickMain` found no qualifying session (a 40-minute nap fails
    // `isMainSession`'s duration clause), so nothing was flagged — this is
    // NOT yet a hand-set flag, and the next import must still be free to settle it.
    expect(afterNap[0].properties[FIELD.main]).toBe(false)

    await importSessions(repo, WORKSPACE_ID, [sleep])

    const afterSleep = await liveChildren(nightId, SESSION_TYPE)
    expect(afterSleep).toHaveLength(2)
    expect(afterSleep.find(s => s.content.startsWith('Sleep'))?.properties[FIELD.main]).toBe(true)
    expect(afterSleep.find(s => s.content.startsWith('Nap'))?.properties[FIELD.main]).toBe(false)
  })
})

describe('upsertSessionInTx — a taken seat re-mints, then a later import converges on the mint', {timeout: 30_000}, () => {
  it('mints a replacement session once the derived-id block is deleted, then updates that mint on the next re-import', async () => {
    const session = sleepSession(local(2026, 2, 9, 0, 0), local(2026, 2, 9, 7, 0))

    const first = await importSessions(repo, WORKSPACE_ID, [session])
    expect(first).toEqual({nights: 1, created: 1, updated: 0, failed: []})

    const nightId = derivedBlockId(nightIdentity(WORKSPACE_ID, '2026-02-09'))
    const originalId = (await liveChildren(nightId, SESSION_TYPE))[0].id

    await repo.tx(tx => tx.run(deleteBlock, {id: originalId}), {scope: ChangeScope.BlockDefault, description: 'delete session'})
    // `repo.load` filters soft-deleted rows out (`SELECT ... WHERE deleted = 0`),
    // so a tombstone reads back as null, not as a row with `deleted: true`.
    expect(await repo.load(originalId)).toBeNull()

    // The derived-id seat is now a tombstone (`taken`, not adoptable), and no
    // OTHER live session shares its start minute — so this mints a fresh,
    // randomly-id'd replacement rather than reviving the deleted one.
    const second = await importSessions(repo, WORKSPACE_ID, [session])
    expect(second).toEqual({nights: 1, created: 1, updated: 0, failed: []})

    const liveAfterSecond = await liveChildren(nightId, SESSION_TYPE)
    expect(liveAfterSecond).toHaveLength(1)
    const mintedId = liveAfterSecond[0].id
    expect(mintedId).not.toBe(originalId)
    expect(await repo.load(originalId)).toBeNull() // the tombstone stays deleted

    // The seat is STILL taken (the tombstone never goes away), but this time
    // the by-minute lookup finds the live mint from the second import and
    // updates it in place — never a third block.
    const third = await importSessions(repo, WORKSPACE_ID, [session])
    expect(third).toEqual({nights: 1, created: 0, updated: 1, failed: []})

    const liveAfterThird = await liveChildren(nightId, SESSION_TYPE)
    expect(liveAfterThird).toHaveLength(1)
    expect(liveAfterThird[0].id).toBe(mintedId)
  })
})

describe('importSessions — main-flag ownership', {timeout: 30_000}, () => {
  it('recomputes an importer-owned main flag once a longer session arrives on a later import', async () => {
    const short = sleepSession(local(2026, 2, 9, 3, 0), local(2026, 2, 9, 7, 0)) // 4h, ends 07:00 — qualifies
    const long = sleepSession(local(2026, 2, 9, 1, 30), local(2026, 2, 9, 8, 30)) // 7h, ends 08:30 — same wake date

    await importSessions(repo, WORKSPACE_ID, [short])
    const nightId = derivedBlockId(nightIdentity(WORKSPACE_ID, '2026-02-09'))
    const afterFirst = await liveChildren(nightId, SESSION_TYPE)
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0].properties[FIELD.main]).toBe(true)

    // A separate import call: `importerOwned` is judged on the live sessions
    // BEFORE this call's own session lands, and the lone existing session's
    // flag still matches what `pickMain` would set — so this settles again
    // over the full (now two-session) set, and the longer one wins.
    await importSessions(repo, WORKSPACE_ID, [long])
    const afterSecond = await liveChildren(nightId, SESSION_TYPE)
    expect(afterSecond).toHaveLength(2)
    const shortBlock = afterSecond.find(s => s.properties[FIELD.start] === short.start.getTime())
    const longBlock = afterSecond.find(s => s.properties[FIELD.start] === long.start.getTime())
    expect(longBlock?.properties[FIELD.main]).toBe(true)
    expect(shortBlock?.properties[FIELD.main]).toBe(false)
  })

  it('leaves a hand-flipped main flag alone and does not settle on the next import', async () => {
    const short = sleepSession(local(2026, 2, 9, 3, 0), local(2026, 2, 9, 7, 0)) // 4h, ends 07:00 — qualifies
    const long = sleepSession(local(2026, 2, 9, 1, 30), local(2026, 2, 9, 8, 30)) // 7h, ends 08:30 — same wake date

    await importSessions(repo, WORKSPACE_ID, [short])
    const nightId = derivedBlockId(nightIdentity(WORKSPACE_ID, '2026-02-09'))
    const shortId = (await liveChildren(nightId, SESSION_TYPE))[0].id

    // Hand-flip to the OPPOSITE of what the heuristic set — the only qualifying
    // session, flipped to false. Nothing else records that this was a manual
    // edit: the mismatch with `pickMain`'s answer IS the override record.
    await repo.tx(tx => tx.setProperty(shortId, mainProp, false),
      {scope: ChangeScope.BlockDefault, description: 'hand-flip main'})

    await importSessions(repo, WORKSPACE_ID, [long])
    const after = await liveChildren(nightId, SESSION_TYPE)
    expect(after).toHaveLength(2)
    // No settle ran: the hand-flipped short session stays false, and the
    // freshly-imported long session keeps the `false` every new session
    // starts as (`upsertSessionInTx`'s own spec) — neither is promoted.
    expect(after.find(s => s.id === shortId)?.properties[FIELD.main]).toBe(false)
    expect(after.find(s => s.id !== shortId)?.properties[FIELD.main]).toBe(false)
  })

  it('mainFlagsMatchHeuristic is true for an empty list, and for a nap-only night where nothing qualifies', async () => {
    expect(mainFlagsMatchHeuristic([])).toBe(true)

    const nap = sleepSession(local(2026, 2, 9, 13, 0), local(2026, 2, 9, 13, 40)) // 40 min — too short to qualify
    const report = await importSessions(repo, WORKSPACE_ID, [nap])
    expect(report).toEqual({nights: 1, created: 1, updated: 0, failed: []})

    const nightId = derivedBlockId(nightIdentity(WORKSPACE_ID, '2026-02-09'))
    const rows = await liveChildren(nightId, SESSION_TYPE)
    const sessions = rows.map(asSession).filter((s): s is NonNullable<typeof s> => s !== null)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].main).toBe(false)
    // `pickMain` also finds nothing here (the nap is too short), so the
    // all-false flag set still matches the heuristic: this night is
    // importer-owned, not a hand override.
    expect(mainFlagsMatchHeuristic(sessions)).toBe(true)
  })
})

describe('importSessions — a per-night failure is reported, not thrown', {timeout: 30_000}, () => {
  it('continues past a failing night, reporting it in `failed` without losing the night that succeeded', async () => {
    const goodDate = '2026-02-09'
    const badDate = '2026-02-10'
    const goodSession = sleepSession(local(2026, 2, 9, 0, 0), local(2026, 2, 9, 7, 0))
    const badSession = sleepSession(local(2026, 2, 10, 0, 0), local(2026, 2, 10, 7, 0))

    const realTx = repo.tx.bind(repo)
    const failure = new Error('simulated write failure')
    const txSpy = vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
      if (opts?.description?.includes(`Import sleep for ${badDate}`)) throw failure
      return realTx(fn, opts)
    })

    const report = await importSessions(repo, WORKSPACE_ID, [goodSession, badSession])
    txSpy.mockRestore()

    expect(report.nights).toBe(1)
    expect(report.created).toBe(1)
    expect(report.updated).toBe(0)
    expect(report.failed).toEqual([{date: badDate, error: failure.message}])

    const goodNightId = derivedBlockId(nightIdentity(WORKSPACE_ID, goodDate))
    expect(await liveChildren(goodNightId, SESSION_TYPE)).toHaveLength(1)

    // The bad night's transaction never committed — not even the night
    // block itself, since `getOrCreateNightInTx` runs inside the same tx.
    const badNightId = derivedBlockId(nightIdentity(WORKSPACE_ID, badDate))
    const badNight = await repo.load(badNightId)
    expect(badNight === null || badNight?.deleted).toBeTruthy()
  })
})

describe('writeRating / writeCovariates / markDoseTaken — the type re-check inside the write', {timeout: 30_000}, () => {
  it('writeRating and writeCovariates return "gone" and write nothing once the night loses its type, though the block still exists', async () => {
    const {nightId} = await stampNight(repo, WORKSPACE_ID, '2026-02-09')

    // Pins the `hasBlockType(night, NIGHT_TYPE)` re-check specifically: the
    // block is untouched otherwise (not deleted, not moved), so if that one
    // clause were removed, both calls below would go back to returning
    // 'written' against a block that is no longer a night.
    await repo.tx(tx => repo.removeTypeInTx(tx, nightId, NIGHT_TYPE),
      {scope: ChangeScope.BlockDefault, description: 'strip the night type'})
    const stripped = await repo.load(nightId)
    expect(stripped?.deleted).toBeFalsy()
    expect(hasBlockType(stripped!, NIGHT_TYPE)).toBe(false)

    expect(await writeRating(repo, nightId, 'quality', 4)).toBe('gone')
    expect(await writeCovariates(repo, nightId, {alcohol: 1})).toBe('gone')

    const after = await repo.load(nightId)
    expect(after?.deleted).toBeFalsy() // the block itself is untouched
    expect(after?.properties[FIELD.quality]).toBeUndefined()
    expect(after?.properties[FIELD.alcohol]).toBeUndefined()
  })

  it('markDoseTaken returns "gone" and writes nothing once the dose loses its type, though the block still exists', async () => {
    const pageId = await labPageId()
    await seedExperiment(pageId, [{index: 1, pair: 1, arm: 'intervention', from: '2026-02-09', to: '2026-02-11'}])
    const {doseId} = await stampNight(repo, WORKSPACE_ID, '2026-02-09')
    expect(doseId).toBeDefined()

    // Same clause, on the dose's own guard (`hasBlockType(dose, DOSE_TYPE)`).
    await repo.tx(tx => repo.removeTypeInTx(tx, doseId!, DOSE_TYPE),
      {scope: ChangeScope.BlockDefault, description: 'strip the dose type'})
    const stripped = await repo.load(doseId!)
    expect(stripped?.deleted).toBeFalsy()
    expect(hasBlockType(stripped!, DOSE_TYPE)).toBe(false)

    expect(await markDoseTaken(repo, doseId!, 123)).toBe('gone')

    const after = await repo.load(doseId!)
    expect(after?.deleted).toBeFalsy()
    expect(after?.properties[FIELD.todoStatus]).not.toBe('done')
    expect(after?.properties[FIELD.takenAt]).toBeUndefined()
  })
})

describe('getOrCreateNightInTx — the fallback lookup decodes an editor-typed date', {timeout: 30_000}, () => {
  it('finds a hand-created replacement night after the derived seat is tombstoned, reading a UTC-midnight date property the way the editor writes it', async () => {
    const pageId = await labPageId()
    const date = '2026-02-09'

    // Seat the derived id, then tombstone it — as if the user deleted the
    // night on purpose. The fallback lookup must not resurrect it (a
    // deleted night was deleted on purpose — see nights.ts's own doc).
    const seated = await stampNight(repo, WORKSPACE_ID, date)
    await repo.tx(tx => tx.run(deleteBlock, {id: seated.nightId}),
      {scope: ChangeScope.BlockDefault, description: 'delete night'})
    expect(await repo.load(seated.nightId)).toBeNull()

    // A replacement, hand-created under the lab page — with the date
    // written the way the kernel's OWN date-property editor writes it:
    // `new Date('YYYY-MM-DD')`, UTC MIDNIGHT — not this extension's own
    // local noon (`dayToDate`). The suite runs under America/Los_Angeles
    // (vitest.integration.config.ts), so reading this value's LOCAL
    // calendar parts would land on 2026-02-08, the day before.
    const replacementId = await repo.tx(async tx => {
      const typeSnapshot = repo.snapshotTypeRegistries()
      return createTypedChild(repo, tx, {
        parentId: pageId,
        content: 'Night of Feb 8 → Feb 9 (hand-repaired)',
        types: [NIGHT_TYPE],
        properties: [propertyValue(dateProp, new Date(date))],
        typeSnapshot,
      })
    }, {scope: ChangeScope.BlockDefault, description: 'hand-create replacement night'})

    const restamped = await stampNight(repo, WORKSPACE_ID, date)
    expect(restamped.nightId).toBe(replacementId)
    expect(restamped.nightId).not.toBe(seated.nightId)

    // No third block: only the hand-created replacement is live under the
    // page (the tombstoned original is invisible to `liveChildren`).
    const nights = await liveChildren(pageId, NIGHT_TYPE)
    expect(nights.map(n => n.id)).toEqual([replacementId])
  })
})

describe('getOrCreateNightInTx — repairs a date the block lost', {timeout: 30_000}, () => {
  it('restores sleeplab:date on the SAME block (adopted, not re-minted) once stampNight sees the date again', async () => {
    const date = '2026-02-09'
    const stamped = await stampNight(repo, WORKSPACE_ID, date)

    await repo.tx(tx => tx.unsetProperty(stamped.nightId, dateProp),
      {scope: ChangeScope.BlockDefault, description: 'strip the night\'s date'})
    const stripped = await repo.load(stamped.nightId)
    expect(stripped?.deleted).toBeFalsy()
    expect(stripped?.properties[FIELD.date]).toBeUndefined()

    // With no readable date, buildNights currently drops this block.
    const rowsBefore = await repo.queryBlocks({workspaceId: WORKSPACE_ID, types: [NIGHT_TYPE]})
    expect(buildNights(rowsBefore).map(n => n.id)).not.toContain(stamped.nightId)

    const repaired = await stampNight(repo, WORKSPACE_ID, date)
    expect(repaired.nightId).toBe(stamped.nightId) // adopted the same block, not a second one

    const block = await repo.load(repaired.nightId)
    expect(block?.properties[FIELD.date]).toBe(dayToDate(date).toISOString())

    const pageId = await labPageId()
    const nights = await liveChildren(pageId, NIGHT_TYPE)
    expect(nights.map(n => n.id)).toEqual([stamped.nightId]) // still exactly one night block

    const rowsAfter = await repo.queryBlocks({workspaceId: WORKSPACE_ID, types: [NIGHT_TYPE]})
    const built = buildNights(rowsAfter)
    expect(built.map(n => n.id)).toContain(stamped.nightId)
    expect(built.find(n => n.id === stamped.nightId)?.date).toBe(date)
  })
})
