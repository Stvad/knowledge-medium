/** The writes that sit beside a session — layoff records, discarding, and
 *  the user's `or`-group choices — against a real `Repo`.
 *
 *  The session path itself is covered in `session.test.ts`. What is here is
 *  everything that outlived the draft: the layoff derivation (whose failure
 *  mode is permanent, since a recorded gap becomes undetectable the moment
 *  the comeback session joins history) and the two writes that destroy or
 *  change user preference.
 */

import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'

import {ChangeScope} from '@/data/api'
import type {BlockData} from '@/data/api'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo, isBlockDeleted} from '@/data/test/createTestRepo'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {deleteBlock} from '@/data/mutators'
import {hasBlockType} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {statusProp as todoStatusProp, todoType} from '@/plugins/todo/schema'
import {dailyNotesDataExtension} from '@/plugins/daily-notes/dataExtension'

import {ALT_CHOICE_TYPE, LAYOFF_TYPE, SET_TYPE, EXERCISE_ENTRY_TYPE} from '../../src/km/fields'
import {buildLayoffs} from '../../src/km/history'
import {dayToDate} from '../../src/km/day'
import {loadConfig} from '../../src/km/config'
import {finishSession, startSession} from '../../src/km/session'
import {closeSession, ensureStrengthHome} from '../../src/km/tonight'
import {trainingDay} from '../../src/engine/schedule'
import type {PlannedLift, SessionPlan} from '../../src/km/sessionPlan'
import {derivedBlockId} from '@/data/typedRecords'
import {choiceIdentity, discardSession, readAltChoices, writeAltChoice, writeLayoff, writeLayoffInTx} from '../../src/km/store'
import {
  STRENGTH_PROPS,
  STRENGTH_TYPES,
  layoffFromProp,
  rolloverHourProp,
  statusProp,
} from '../../src/km/schema'

const WORKSPACE_ID = 'ws-1'
const PAGE_ID = 'strength-log-page'
const SETTINGS_ID = 'strength-settings-block'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  const created = createTestRepo({
    db: sharedDb.db,
    user: {id: 'lifter'},
    extensions: [
      ...STRENGTH_PROPS.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
      ...STRENGTH_TYPES.map(type => typeSeedsFacet.of(type, {source: 'test'})),
      definitionSeedsFacet.of(todoStatusProp, {source: 'test'}),
      typeSeedsFacet.of(todoType, {source: 'test'}),
      // The real daily-note types, because `sessionParent` calls the real
      // `getOrCreateDailyNote` — a fake would accept any string and so could
      // never have caught the ISO-format bug this pins.
      dailyNotesDataExtension,
    ],
  })
  repo = created.repo
  repo.setActiveWorkspaceId(WORKSPACE_ID)
  await repo.tx(async tx => {
    await tx.create({
      id: PAGE_ID, workspaceId: WORKSPACE_ID, parentId: null, orderKey: 'a0', content: 'Strength Log',
    })
    await tx.create({
      id: SETTINGS_ID, workspaceId: WORKSPACE_ID, parentId: PAGE_ID, orderKey: 'a0', content: 'Settings',
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed page'})
})

const lift = (exercise: string, over: Partial<PlannedLift> = {}): PlannedLift => ({
  exercise,
  occurrence: 0,
  unit: 'lb',
  prescribedSets: 1,
  sets: [{weight: 135, reps: 8}],
  ...over,
})

const plan = (over: Partial<SessionPlan> = {}): SessionPlan =>
  ({day: '2026-07-24', session: 'A', lifts: [lift('Bench press')], ...over})

const liveChildren = async (parentId: string, typeId: string): Promise<BlockData[]> =>
  ((await repo.block(parentId).children.load()) ?? [])
    .filter(row => !row.deleted && hasBlockType(row, typeId))

/** Start a session and tick its only set, so it is finishable. */
const startAndLog = async (over: Partial<SessionPlan> = {}): Promise<string> => {
  const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan(over))
  const [entry] = await liveChildren(workoutId, EXERCISE_ENTRY_TYPE)
  const [set] = await liveChildren(entry.id, SET_TYPE)
  await repo.tx(tx => tx.setProperty(set.id, todoStatusProp, 'done'),
    {scope: ChangeScope.BlockDefault, description: 'tick'})
  return workoutId
}

describe('discardSession — the one write that destroys', () => {
  it('refuses a session that has already been finished, rather than tombstoning the record', async () => {
    // Discard is enabled from what was last rendered, and a peer's finish can
    // land between that render and the tap. Without the in-transaction
    // re-check, the stale button erases a completed session and every set in it.
    const workoutId = await startAndLog()
    expect(await finishSession(repo, workoutId)).toBe('done')

    expect(await discardSession(repo, workoutId)).toBe('gone')
    expect(await isBlockDeleted(repo, workoutId)).toBe(false)
  })

  it('still discards a session that is genuinely in progress', async () => {
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan())
    expect(await discardSession(repo, workoutId)).toBe('discarded')
    expect(await isBlockDeleted(repo, workoutId)).toBe(true)
  })
})

describe('the layoff record and the finish that justifies it', () => {
  const record = {from: '2026-07-01', to: '2026-07-24', days: 23, tierId: 'long', pct: 0.7}
  const layoffOf = () => ({pageId: PAGE_ID, record})

  it('lands in the same transaction as the finish', async () => {
    const workoutId = await startAndLog()

    expect(await finishSession(repo, workoutId, layoffOf())).toBe('done')

    const layoffs = buildLayoffs(await liveChildren(PAGE_ID, LAYOFF_TYPE))
    expect(layoffs).toHaveLength(1)
    expect(layoffs[0]).toMatchObject({from: '2026-07-01', to: '2026-07-24', days: 23})
  })

  it('is one record per gap, however many workouts finish against it', async () => {
    // Two clients coming back from the same break, each dating its return
    // differently. With a minted id that is two layoff blocks, and
    // `resolveReentry` takes the later `to` as most recent and restarts
    // `sessionsBack`, re-applying loads already climbed out of. The gap's
    // START is the identity, so the second write adopts the first's block.
    const first = await startAndLog()
    expect(await finishSession(repo, first, layoffOf())).toBe('done')

    const second = await startAndLog({day: '2026-07-25', session: 'B', lifts: [lift('Row')]})
    expect(await finishSession(repo, second, {
      pageId: PAGE_ID,
      record: {from: '2026-07-01', to: '2026-07-25', days: 24, tierId: 'long', pct: 0.7},
    })).toBe('done')

    const layoffs = buildLayoffs(await liveChildren(PAGE_ID, LAYOFF_TYPE))
    expect(layoffs).toHaveLength(1)
    // The adopt leaves the record alone, so the FIRST return recorded stands —
    // which is the one that actually happened.
    expect(layoffs[0]).toMatchObject({from: '2026-07-01', to: '2026-07-24', days: 23})
  })

  it('will not adopt a block whose `from` was edited to another gap', async () => {
    // `strength:from` is an ordinary editable date, and `layoffAlreadyRecorded`
    // reads THAT rather than the block id — so adopting purely on a matching
    // id, while the block says it records a different gap, leaves the pending
    // gap with no record at all. That loss is permanent.
    const first = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, record)
    await repo.tx(tx => tx.setProperty(first, layoffFromProp, dayToDate('2026-05-05')),
      {scope: ChangeScope.BlockDefault, description: 'hand-edit the gap start'})

    const second = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, record)

    expect(second).not.toBe(first)
    const layoffs = buildLayoffs(await liveChildren(PAGE_ID, LAYOFF_TYPE))
    expect(layoffs.map(l => l.from).sort()).toEqual(['2026-05-05', '2026-07-01'])
  })

  it('re-finds the minted fallback instead of minting another every time', async () => {
    // Once the derived seat holds a tombstone it holds one forever, so every
    // later finish took the mint branch. Minting blind there put a fresh
    // layoff block in the log each time — the duplicate the derivation exists
    // to stop, arriving by another route, and with it the later stale `to`
    // that restarts the ramp.
    const derived = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, record)
    await repo.tx(tx => tx.run(deleteBlock, {id: derived}),
      {scope: ChangeScope.BlockDefault, description: 'the gap record is deleted'})

    const minted = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, record)
    const again = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, record)

    expect(minted).not.toBe(derived)
    expect(again).toBe(minted)
    expect(buildLayoffs(await liveChildren(PAGE_ID, LAYOFF_TYPE))).toHaveLength(1)
  })

  it('is rolled back with a finish that records nothing', async () => {
    // The reason it lives inside the finish transaction: the finish can
    // REFUSE, and a layoff written beside it cannot be taken back — the break
    // would stand as ending on a session that never happened.
    const workoutId = await startSession(repo, WORKSPACE_ID, PAGE_ID, plan())

    expect(await finishSession(repo, workoutId, layoffOf())).toBe('nothing-logged')

    expect(await liveChildren(PAGE_ID, LAYOFF_TYPE)).toHaveLength(0)
    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
  })
})

describe('or-group choices', () => {
  it('upserts one block per group rather than growing a log', async () => {
    await writeAltChoice(repo, SETTINGS_ID, 'group-1', 'opt-a', 'Face pulls')
    await writeAltChoice(repo, SETTINGS_ID, 'group-1', 'opt-b', 'Band pull-aparts')
    await writeAltChoice(repo, SETTINGS_ID, 'group-2', 'opt-c', 'Pallof press')

    expect(await readAltChoices(repo, SETTINGS_ID)).toEqual({
      'group-1': 'opt-b',
      'group-2': 'opt-c',
    })
    // Counted, because `readAltChoices` collapses duplicates last-wins — so
    // the map above reads correctly even if every call appended a new block,
    // which is exactly the "grows a log" this claims not to do.
    expect(await liveChildren(SETTINGS_ID, ALT_CHOICE_TYPE)).toHaveLength(2)
  })

  it('makes a later pick stick even when the group already has duplicate blocks', async () => {
    // Two offline clients answering the same group for the first time each
    // saw no child and each minted one. `readAltChoices` folds in order and
    // keeps the LAST, while the writer used to update only the FIRST match —
    // so the duplicate kept overriding every later pick, permanently, with
    // nothing on screen to explain why the choice would not take.
    const DUPES = ['choice-a', 'choice-b'] as const
    await repo.tx(async tx => {
      for (const [index, id] of DUPES.entries()) {
        await tx.create({
          id, workspaceId: WORKSPACE_ID, parentId: SETTINGS_ID, orderKey: `a${index}`,
          content: 'Tracking: Face pulls',
        })
      }
    }, {scope: ChangeScope.BlockDefault, description: 'two blocks for one group'})
    // A second transaction: inside the creating one the cache has no row yet,
    // so the property bag to merge into cannot be read.
    await repo.tx(async tx => {
      for (const id of DUPES) {
        await tx.update(id, {properties: {
          ...repo.block(id).peek()!.properties,
          types: [ALT_CHOICE_TYPE],
          'strength:group': 'group-1',
          'strength:option': 'opt-a',
        }})
      }
    }, {scope: ChangeScope.BlockDefault, description: 'type the duplicates'})
    expect(await readAltChoices(repo, SETTINGS_ID)).toEqual({'group-1': 'opt-a'})

    await writeAltChoice(repo, SETTINGS_ID, 'group-1', 'opt-b', 'Band pull-aparts')

    expect(await readAltChoices(repo, SETTINGS_ID)).toEqual({'group-1': 'opt-b'})
    // Both were rewritten, so which one the fold lands on stops mattering.
    expect(repo.block('choice-a').peek()?.properties['strength:option']).toBe('opt-b')
    expect(repo.block('choice-b').peek()?.properties['strength:option']).toBe('opt-b')
  })

  it('mints the group\'s block AT its derived seat', async () => {
    // The seat is what makes two offline first-picks converge: both clients
    // compute the same id, so after sync there is one row rather than two.
    // Asserted on the id directly, because a random-id mint behaves
    // identically on one device and only forks once a peer is involved.
    await writeAltChoice(repo, SETTINGS_ID, 'group-1', 'opt-a', 'Face pulls')

    const [block] = await liveChildren(SETTINGS_ID, ALT_CHOICE_TYPE)
    expect(block.id).toBe(derivedBlockId(choiceIdentity(SETTINGS_ID, 'group-1')))
  })

  it('mints one seat per group, so two first picks converge instead of forking', async () => {
    // The block id is derived from the settings block and the group, so a
    // client that mints while offline lands on the same row as its peer.
    await writeAltChoice(repo, SETTINGS_ID, 'group-1', 'opt-a', 'Face pulls')
    const [first] = await liveChildren(SETTINGS_ID, ALT_CHOICE_TYPE)

    await repo.tx(async tx => { await tx.run(deleteBlock, {id: first.id}) },
      {scope: ChangeScope.BlockDefault, description: 'peer deleted it'})
    await writeAltChoice(repo, SETTINGS_ID, 'group-1', 'opt-b', 'Band pull-aparts')

    // A tombstone on the seat is the one case that cannot reuse it. It mints
    // beside rather than throwing, and the scan adopts that mint next time.
    expect(await readAltChoices(repo, SETTINGS_ID)).toEqual({'group-1': 'opt-b'})
    await writeAltChoice(repo, SETTINGS_ID, 'group-1', 'opt-c', 'Face pulls')
    expect(await liveChildren(SETTINGS_ID, ALT_CHOICE_TYPE)).toHaveLength(1)
    expect(await readAltChoices(repo, SETTINGS_ID)).toEqual({'group-1': 'opt-c'})
  })
})

describe('the day a layoff is measured to', () => {
  const dayBefore = (n: number): string => {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  it('is the day the session was performed, not the day you got round to finishing it', async () => {
    // Train, forget to tap Finish, finish the next morning. Measuring to the
    // finish clock reports one day more — enough to drop a tier — and dates
    // the comeback to a day this session is not on, so `resolveReentry` never
    // counts it as a session back and the ramp runs one session long. Both
    // are permanent: the record is keyed on `from`, so a later finish adopts
    // the wrong one rather than correcting it.
    const lastTrained = dayBefore(60)
    const performedOn = dayBefore(25)

    // History: one finished session long ago, so there is a gap to classify.
    const oldId = await startAndLog({day: lastTrained})
    expect(await finishSession(repo, oldId)).toBe('done')

    const workoutId = await startAndLog({day: performedOn, session: 'B', lifts: [lift('Row')]})
    expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('done')

    // Queried by type, not under the test's page: `closeSession` resolves the
    // real Strength Log page itself, which is where the record lands.
    const layoffs = buildLayoffs(
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [LAYOFF_TYPE]}).load())
    expect(layoffs).toHaveLength(1)
    expect(layoffs[0].to).toBe(performedOn)
    expect(layoffs[0].days).toBe(35)
  })
})

describe('the finish transaction re-checks what the caller validated', () => {
  it('refuses when the date changed between the read and the transaction', async () => {
    // `strength:date` is hand-editable and the caller's read is several awaits
    // old. Cleared in that window the workout closes and `buildHistory` drops
    // it whole; changed to another valid day it closes with a layoff measured
    // to the old one.
    const workoutId = await startAndLog()

    expect(await finishSession(repo, workoutId, undefined, 'a different stored value')).toBe('undated')

    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
  })

  it('closes when the stored value still matches', async () => {
    const workoutId = await startAndLog()
    // Raw, not a decoded day: decoding on both sides let two decoders
    // disagree, and any rollover past 12 then made every workout permanently
    // unfinishable.
    const stored = repo.block(workoutId).peek()?.properties['strength:date']
    expect(await finishSession(repo, workoutId, undefined, stored)).toBe('done')
  })
})

describe('a layoff mint filed away from the log page', () => {
  it('is re-found rather than duplicated', async () => {
    // The adopt is deliberately parent-agnostic — a layoff is about a gap in
    // time, not where it sits — so the re-find must be too. A page-children
    // scan lost a mint the user had filed elsewhere, and the next finish
    // minted a SECOND record for the same gap; history reads layoffs
    // workspace-wide, so both then feed re-entry.
    const record = {from: '2026-07-01', to: '2026-07-24', days: 23, tierId: 'long', pct: 0.7}
    const derived = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, record)
    await repo.tx(tx => tx.run(deleteBlock, {id: derived}),
      {scope: ChangeScope.BlockDefault, description: 'the gap record is deleted'})
    const minted = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, record)

    // Filed under a year heading, out of the page's children.
    await repo.tx(async tx => {
      await tx.create({
        id: 'a-year', workspaceId: WORKSPACE_ID, parentId: null, orderKey: 'a1', content: '2026',
      })
      await tx.move(minted, {parentId: 'a-year', orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault, description: 'file it away'})

    const known = buildLayoffs(
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [LAYOFF_TYPE]}).load(),
    ).map(l => l.id)
    const again = await repo.tx(
      tx => writeLayoffInTx(repo, tx, WORKSPACE_ID, PAGE_ID, record, repo.snapshotTypeRegistries(), known),
      {scope: ChangeScope.BlockDefault, description: 'finish again'},
    )

    expect(again).toBe(minted)
    expect(buildLayoffs(
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [LAYOFF_TYPE]}).load(),
    )).toHaveLength(1)
  })
})

describe('the day-rollover setting', () => {
  it('is clamped to noon, so one stored date cannot decode two ways', async () => {
    // Workout dates are stored AT local noon. A rollover above 12 shifts a
    // stored date onto the previous day for any reader that re-applies it,
    // while readers that do not stay on the stored day — two decoders of one
    // value, which is how a hand-set 13 made every workout unfinishable.
    const {settingsBlockId} = await ensureStrengthHome(repo, WORKSPACE_ID)
    await repo.tx(tx => tx.setProperty(settingsBlockId, rolloverHourProp, 20),
      {scope: ChangeScope.UserPrefs, description: 'a nonsensical rollover'})

    const {config} = await loadConfig(repo, WORKSPACE_ID, settingsBlockId)

    expect(config.dayRolloverHour).toBe(12)
    // A stored noon date decodes to the same day either way at the clamp.
    expect(trainingDay(dayToDate('2026-07-24'), config.dayRolloverHour)).toBe('2026-07-24')
  })

  it('still allows midnight', async () => {
    const {settingsBlockId} = await ensureStrengthHome(repo, WORKSPACE_ID)
    await repo.tx(tx => tx.setProperty(settingsBlockId, rolloverHourProp, 0),
      {scope: ChangeScope.UserPrefs, description: 'midnight rollover'})

    expect((await loadConfig(repo, WORKSPACE_ID, settingsBlockId)).config.dayRolloverHour).toBe(0)
  })
})
