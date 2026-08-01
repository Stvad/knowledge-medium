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

import {ChangeScope, propertyValue} from '@/data/api'
import type {BlockData} from '@/data/api'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo, isBlockDeleted} from '@/data/test/createTestRepo'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import {deleteBlock} from '@/data/mutators'
import {hasBlockType} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {statusProp as todoStatusProp, todoType} from '@/plugins/todo/schema'

import {ALT_CHOICE_TYPE, FIELD, LAYOFF_TYPE, SET_TYPE, EXERCISE_ENTRY_TYPE, WORKOUT_TYPE} from '../../src/km/fields'
import {SETTINGS_TYPE} from '../../src/km/schema'
import {buildHistory, buildLayoffs} from '../../src/km/history'
import {dayToDate, storedDate} from '../../src/km/day'
import {loadConfig} from '../../src/km/config'
import {findSettingsBlock, findStrengthLogPage, getOrCreateSettingsBlock, settingsIdentity} from '../../src/km/page'
import {adjustSet, finishSession, mostRecentlyStarted, startSession as startSessionReporting} from '../../src/km/session'
import {closeSession, ensureStrengthHome, readProgram, standingSession} from '../../src/km/tonight'
import {trainingDay} from '../../src/engine/schedule'
import type {PlannedLift, SessionPlan} from '../../src/km/sessionPlan'
import {derivedBlockId} from '@/data/typedRecords'
import {choiceIdentity, discardSession, readAltChoices, writeAltChoice, writeLayoff, writeLayoffInTx} from '../../src/km/store'
import {
  STRENGTH_PROPS,
  STRENGTH_TYPES,
  dateProp,
  layoffFromProp,
  layoffTierProp,
  rolloverHourProp,
  sessionProp,
  statusProp,
} from '../../src/km/schema'

/** These tests read the session ID; `stamped` is asserted where it is the
 *  point, in the premise-check block. Shimmed rather than threaded through
 *  ~80 call sites, which would bury the change it is here to support. */
const startSession = async (
  ...args: Parameters<typeof startSessionReporting>
): Promise<string> => (await startSessionReporting(...args)).id

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

describe('ensureStrengthHome', () => {
  it('creates the settings block alongside the page, not just the page', async () => {
    // What "open the log" now goes through. Creating only the page left a
    // fresh workspace with nowhere to set the plan root, the rollover hour,
    // the cadence or the rounding: the settings type is hidden from
    // completion, and the only other callers are recording a layoff and
    // recording an `or`-group choice — so someone who did neither had no
    // settings block and no way to make one.
    const fresh = 'ws-with-nothing-in-it'

    const {pageId, settingsBlockId} = await ensureStrengthHome(repo, fresh)

    expect(await findStrengthLogPage(repo, fresh)).toBe(pageId)
    expect(await findSettingsBlock(repo, fresh, pageId)).toBe(settingsBlockId)
  })

  it('mints the settings block AT its derived seat, so two devices converge', async () => {
    // The sibling scan inside the transaction only makes two bootstraps on ONE
    // device converge. Two OFFLINE devices each see no sibling, each mint a
    // random id, and after sync the page has two — with `findSettingsBlock`
    // taking whichever the query returns first, so the two read and write
    // different plan roots, rollover hours and `or`-group choices. Asserted on
    // the id directly, because a random-id mint behaves identically on one
    // device and only forks once a peer is involved.
    const fresh = 'ws-with-nothing-in-it'

    const {pageId, settingsBlockId} = await ensureStrengthHome(repo, fresh)

    expect(settingsBlockId).toBe(derivedBlockId(settingsIdentity(pageId)))
  })

  it('repairs a settings block whose type was removed, instead of replacing it', async () => {
    // Removing the type is a slip; the CONFIG is not, and the two must not be
    // the same event. The typed pre-query misses an untagged block, so the
    // derived seat is the only thing that can still find it — and it can,
    // because the id resolves whatever tags the block carries. Demanding the
    // tag in `adoptable` rejected it, and a rejected seat is permanent, so
    // every later open minted a BLANK settings block and read the empty one:
    // plan root, rollover hour, cadence and every `or`-group choice child
    // silently abandoned while still sitting in the outline.
    const fresh = 'ws-with-nothing-in-it'
    const {pageId, settingsBlockId} = await ensureStrengthHome(repo, fresh)
    // A setting worth losing, so this cannot pass on the id alone.
    await repo.tx(async tx => {
      await tx.setProperties(settingsBlockId, {set: [propertyValue(rolloverHourProp, 5)]})
      // UserPrefs, not BlockDefault: the settings BLOCK is structural, but each
      // setting value carries its own scope. See `getOrCreateSettingsBlock`.
    }, {scope: ChangeScope.UserPrefs, description: 'a configured rollover hour'})
    await repo.removeType(settingsBlockId, SETTINGS_TYPE)
    expect(hasBlockType(repo.block(settingsBlockId).peek()!, SETTINGS_TYPE)).toBe(false)

    const again = await getOrCreateSettingsBlock(repo, fresh, pageId)

    expect(again).toBe(settingsBlockId)
    // …and the adopt repaired the tag rather than leaving it half-typed.
    expect(hasBlockType(repo.block(settingsBlockId).peek()!, SETTINGS_TYPE)).toBe(true)
    expect(repo.block(settingsBlockId).peekProperty(rolloverHourProp)).toBe(5)
    expect(await liveChildren(pageId, SETTINGS_TYPE)).toHaveLength(1)
  })

  it('rescues a pre-seat settings block that also lost its type', async () => {
    // Blocks minted before the derived seat existed carry RANDOM ids — the live
    // workspace has one — so neither the typed query nor the seat can reach one
    // that has also lost its tag, and the next open minted a blank block at the
    // seat while the real plan root, rollover hour and choice children sat in
    // the outline. `typedRecords.ts` requires exactly this when a derived id is
    // retrofitted onto a kind with rows already out there.
    //
    // Identified by the VALUES it carries rather than by content or position,
    // so what is matched is the thing worth rescuing.
    const fresh = 'ws-with-nothing-in-it'
    const {pageId} = await ensureStrengthHome(repo, fresh)
    await repo.tx(async tx => {
      await tx.create({
        id: 'legacy-settings', workspaceId: fresh, parentId: pageId,
        orderKey: 'a1', content: 'Strength settings',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'a settings block from before the seat'})
    await repo.tx(async tx => {
      await tx.setProperties('legacy-settings', {set: [propertyValue(rolloverHourProp, 5)]})
    }, {scope: ChangeScope.UserPrefs, description: 'configured, which is what is at stake'})
    // Nothing at the seat and nothing tagged, which is the state after the
    // legacy block loses its type.
    await repo.tx(tx => tx.run(deleteBlock, {id: derivedBlockId(settingsIdentity(pageId))}),
      {scope: ChangeScope.BlockDefault, description: 'no seat block'})

    expect(await findSettingsBlock(repo, fresh, pageId)).toBe('legacy-settings')
    expect((await readProgram(repo, fresh)).config.dayRolloverHour).toBe(5)
    // …and the writer agrees rather than minting beside it, then repairs the tag.
    expect(await getOrCreateSettingsBlock(repo, fresh, pageId)).toBe('legacy-settings')
    expect(hasBlockType(repo.block('legacy-settings').peek()!, SETTINGS_TYPE)).toBe(true)
  })

  it('READS a settings block whose type was removed, without repairing it first', async () => {
    // The repair above is a WRITE, and the path that matters most never
    // reaches it: `readProgram` runs on the Start flow and must not bootstrap,
    // so a typed-only lookup meant an untagged settings block was invisible
    // exactly where it counts. Start read no settings, fell back to the
    // built-in program, and stamped a session from it — ignoring the plan
    // root, rollover hour and every recorded `or`-group choice — until the
    // user happened to open the log page.
    const fresh = 'ws-with-nothing-in-it'
    const {pageId, settingsBlockId} = await ensureStrengthHome(repo, fresh)
    await repo.tx(async tx => {
      await tx.setProperties(settingsBlockId, {set: [propertyValue(rolloverHourProp, 5)]})
    }, {scope: ChangeScope.UserPrefs, description: 'a configured rollover hour'})
    await repo.removeType(settingsBlockId, SETTINGS_TYPE)

    expect(await findSettingsBlock(repo, fresh, pageId)).toBe(settingsBlockId)
    // And the config it holds actually reaches the reader, which is the point
    // — the id alone would pass with the settings still unread.
    expect((await readProgram(repo, fresh)).config.dayRolloverHour).toBe(5)
    // Still no write: a read that bootstraps is what this path exists to avoid.
    expect(hasBlockType(repo.block(settingsBlockId).peek()!, SETTINGS_TYPE)).toBe(false)
  })

  it('does not adopt a settings block dragged off the page', async () => {
    // Parentage is still checked, even though the type no longer is, because
    // `findSettingsBlock` is parent-scoped: adopting a block filed elsewhere
    // would hand this caller knobs that `readProgram` cannot find, so half the
    // app would read the real config and half the defaults, invisibly.
    //
    // The dragged block's config IS abandoned either way — a fresh blank one
    // appears under the page — which is a known gap, not a happy outcome. It
    // is the lesser of the two: two visible "Strength settings" blocks you can
    // merge by hand, rather than a silent split brain. Making the seat AND the
    // reader id-based would fix it properly; this test pins today's rule so
    // that change has to be deliberate.
    const fresh = 'ws-with-nothing-in-it'
    const {pageId, settingsBlockId} = await ensureStrengthHome(repo, fresh)
    await repo.tx(async tx => {
      await tx.create({
        id: 'elsewhere', workspaceId: fresh, parentId: null, orderKey: 'z0', content: 'Elsewhere',
      })
      await tx.move(settingsBlockId, {parentId: 'elsewhere', orderKey: 'a0'})
    }, {scope: ChangeScope.BlockDefault, description: 'drag the settings away'})

    const again = await getOrCreateSettingsBlock(repo, fresh, pageId)

    expect(again).not.toBe(settingsBlockId)
    expect(await liveChildren(pageId, SETTINGS_TYPE)).toHaveLength(1)
  })

  it('adds no second settings block once the derived seat holds a tombstone', async () => {
    // The seat never becomes untaken, so every open after a delete has to fall
    // back to the mint — and must find the previous one rather than making
    // another. What actually re-finds it here is the pre-transaction query at
    // the top of `getOrCreateSettingsBlock`; the in-transaction re-find behind
    // it is defence in depth (see its comment), and is NOT what this pins.
    const fresh = 'ws-with-nothing-in-it'
    const {pageId, settingsBlockId: derived} = await ensureStrengthHome(repo, fresh)
    await repo.tx(async tx => { await tx.run(deleteBlock, {id: derived}) },
      {scope: ChangeScope.BlockDefault, description: 'the settings block is deleted'})

    const minted = await getOrCreateSettingsBlock(repo, fresh, pageId)
    const again = await getOrCreateSettingsBlock(repo, fresh, pageId)

    expect(minted).not.toBe(derived)
    expect(again).toBe(minted)
    expect(await liveChildren(pageId, SETTINGS_TYPE)).toHaveLength(1)
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

  /** Two finished sessions six days apart, then tonight's, open and ticked.
   *  Six days is on-schedule and so is the four to tonight — so nothing here
   *  records a layoff. Retract the RECENT one and the basis falls back to the
   *  older, making tonight a ten-day gap: a `1-2w` layoff that has to be
   *  recorded. That flip from "no record needed" to "record needed" is the
   *  whole scenario. */
  const twoPriorSessions = async (): Promise<{recent: string; tonight: string}> => {
    const older = await startAndLog({day: '2026-07-14'})
    expect(await finishSession(repo, older)).toBe('done')
    const recent = await startAndLog({day: '2026-07-20', session: 'B', lifts: [lift('Row')]})
    expect(await finishSession(repo, recent)).toBe('done')
    // Workspace-wide, NOT under PAGE_ID: `closeSession` files layoffs on the
    // real kernel log page via `ensureStrengthHome`, so a page-scoped check
    // here would read empty whether or not one was written.
    expect(await repo.queryBlocks({workspaceId: WORKSPACE_ID, types: [LAYOFF_TYPE]}))
      .toHaveLength(0)
    return {recent, tonight: await startAndLog()}
  }

  /** The basis entry `closeSession` would build for a workout — id plus the
   *  normalised instant `buildHistory` derives from its raw date. */
  const basisOf = async (workoutId: string): Promise<{id: string; date: string}> => {
    const raw = repo.block(workoutId).peek()?.properties[FIELD.date]
    return {id: workoutId, date: storedDate(new Date(raw as string)).toISOString()}
  }

  const untick = async (workoutId: string): Promise<void> => {
    const [entry] = await liveChildren(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await liveChildren(entry.id, SET_TYPE)
    await repo.tx(tx => tx.setProperty(set.id, todoStatusProp, 'open'),
      {scope: ChangeScope.BlockDefault, description: 'take back a session'})
  }

  it('refuses to close when the history the gap was measured across moved', async () => {
    // The gap is measured FROM the last full session day, which is a history
    // read rather than a property of the workout being closed — so
    // `finishSession` re-checking the target saw nothing wrong. Retract that
    // session and the real gap is longer than the snapshot said; close anyway
    // and the layoff goes unrecorded, after which it is undetectable on every
    // later day. The cut is not wrong, it is gone.
    const {recent, tonight} = await twoPriorSessions()
    const basis = await basisOf(recent)
    await untick(recent)

    expect(await finishSession(repo, tonight, undefined, {basis: [basis]})).toBe('changed')

    expect(repo.block(tonight).peekProperty(statusProp)).toBe('in-progress')
  })

  it('refuses when the basis workout was re-dated rather than emptied', async () => {
    // The half an existence check misses. `strength:date` is hand-editable, so
    // moving the basis session back to an older day leaves every done set in
    // place — it is still a training day, just not THAT one — while the gap it
    // anchors silently grows. Compared as the normalised instant
    // `buildHistory` derives, so there is no rollover arithmetic here and no
    // second decoder to disagree with the one that captured it.
    const {recent, tonight} = await twoPriorSessions()
    const basis = await basisOf(recent)
    await repo.tx(tx => tx.setProperty(recent, dateProp, dayToDate('2026-07-10')),
      {scope: ChangeScope.BlockDefault, description: 'correct a date by hand'})

    expect(await finishSession(repo, tonight, undefined, {basis: [basis]})).toBe('changed')

    expect(repo.block(tonight).peekProperty(statusProp)).toBe('in-progress')
  })

  it('still closes while the basis session is intact', async () => {
    // The other half of the mutation: a fence that refuses everything passes
    // both tests above for the wrong reason.
    const {recent, tonight} = await twoPriorSessions()
    const basis = await basisOf(recent)

    expect(await finishSession(repo, tonight, undefined, {basis: [basis]})).toBe('done')
  })

  it('carries the basis from closeSession into the finish, not just accepts one', async () => {
    // Same lesson as the session-kind fence: testing `finishSession` directly
    // pins the CHECK but not the CALLER, and dropping the argument at the call
    // site broke no test. Landed from inside the finishing transaction's own
    // opening, which is the window that actually exists.
    const {recent, tonight} = await twoPriorSessions()
    const realTx = repo.tx.bind(repo)
    let armed = true
    repo.tx = (async (fn: never, opts: {description?: string}) => {
      if (armed && opts?.description === 'Finish session') {
        armed = false
        const [entry] = await liveChildren(recent, EXERCISE_ENTRY_TYPE)
        const [set] = await liveChildren(entry.id, SET_TYPE)
        await realTx(tx => tx.setProperty(set.id, todoStatusProp, 'open'),
          {scope: ChangeScope.BlockDefault, description: 'another panel takes a session back'})
      }
      return realTx(fn, opts as never)
    }) as typeof repo.tx

    try {
      expect(await closeSession(repo, WORKSPACE_ID, tonight)).toBe('changed')
    } finally {
      repo.tx = realTx
    }
    expect(repo.block(tonight).peekProperty(statusProp)).toBe('in-progress')
    // …and pressing Finish again decides afresh, which is what `changed` is
    // for: the basis has moved back to the older session, so the ten-day gap
    // this time gets the record it needs.
    expect(await closeSession(repo, WORKSPACE_ID, tonight)).toBe('done')
    expect(buildLayoffs(
      await repo.queryBlocks({workspaceId: WORKSPACE_ID, types: [LAYOFF_TYPE]}),
    )[0]).toMatchObject({from: '2026-07-14', to: '2026-07-24', days: 10})
  })

  it('refuses to close when the record it was relying on has gone', async () => {
    // The branch where writing nothing is the POINT is the one that never
    // re-checked its reason. `layoffAlreadyRecorded` says "a record already
    // covers this gap", so Finish writes none — and if that record is deleted
    // in the window, the gap ends up recorded nowhere and is undetectable on
    // every later day once this session joins history.
    const {tonight} = await twoPriorSessions()
    const covering = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID,
      {from: '2026-07-14', to: '2026-07-24', days: 10, tierId: '1-2w', pct: 0.9})
    await repo.tx(tx => tx.run(deleteBlock, {id: covering}),
      {scope: ChangeScope.BlockDefault, description: 'a peer deletes the layoff'})

    expect(await finishSession(repo, tonight, undefined, {
      layoffOnRecord: {id: covering, from: '2026-07-14', tierId: '1-2w', days: 10},
    })).toBe('changed')

    expect(repo.block(tonight).peekProperty(statusProp)).toBe('in-progress')
  })

  it('refuses when the record survives but its TIER was edited', async () => {
    // The field that decides is `strength:tier`, not the stored percentage —
    // `resolveReentry` resolves the tier and never reads `strength:reentryPct`.
    // Edit one and leave the other and the record applies a different cut, or
    // none, while a percentage check waves it through.
    const {tonight} = await twoPriorSessions()
    const covering = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID,
      {from: '2026-07-14', to: '2026-07-24', days: 10, tierId: '1-2w', pct: 1})
    await repo.tx(tx => tx.setProperty(covering, layoffTierProp, 'on-schedule'),
      {scope: ChangeScope.BlockDefault, description: 'hand-edit the tier'})

    expect(await finishSession(repo, tonight, undefined, {
      layoffOnRecord: {id: covering, from: '2026-07-14', tierId: '1-2w', days: 10},
    })).toBe('changed')
  })

  it('refuses when the record survives but no longer names this gap', async () => {
    // Surviving is not covering. `strength:from` is hand-editable, so a record
    // re-pointed at another break leaves this one with nothing — the same test
    // `layoffAlreadyRecorded` applies, re-asked against the row on disk.
    const {tonight} = await twoPriorSessions()
    const covering = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID,
      {from: '2026-07-14', to: '2026-07-24', days: 10, tierId: '1-2w', pct: 0.9})
    await repo.tx(tx => tx.setProperty(covering, layoffFromProp, dayToDate('2026-05-05')),
      {scope: ChangeScope.BlockDefault, description: 'hand-edit the gap start'})

    expect(await finishSession(repo, tonight, undefined, {
      layoffOnRecord: {id: covering, from: '2026-07-14', tierId: '1-2w', days: 10},
    })).toBe('changed')
  })

  it('still closes while the record it relied on is intact', async () => {
    // The other half of the mutation: a fence that refuses everything passes
    // both tests above for the wrong reason.
    const {tonight} = await twoPriorSessions()
    const covering = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID,
      {from: '2026-07-14', to: '2026-07-24', days: 10, tierId: '1-2w', pct: 0.9})

    expect(await finishSession(repo, tonight, undefined, {
      layoffOnRecord: {id: covering, from: '2026-07-14', tierId: '1-2w', days: 10},
    })).toBe('done')
  })

  it('carries the relied-on record from closeSession into the finish', async () => {
    // Pins the CALL SITE, not just the check — the lesson from the two fences
    // before this, where testing `finishSession` directly left `closeSession`
    // free to pass nothing. Tonight is a ten-day gap, so the decision is
    // "already covered, write none"; the record is deleted from inside the
    // finishing transaction's own opening.
    // ONE prior session, so tonight really is a ten-day gap and the decision
    // reached is "already covered, write none" — `twoPriorSessions` leaves a
    // four-day gap, where there is no pending layoff to rely on a record for.
    const older = await startAndLog({day: '2026-07-14'})
    expect(await finishSession(repo, older)).toBe('done')
    const tonight = await startAndLog()
    const covering = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID,
      {from: '2026-07-14', to: '2026-07-24', days: 10, tierId: '1-2w', pct: 1})
    const realTx = repo.tx.bind(repo)
    let armed = true
    repo.tx = (async (fn: never, opts: {description?: string}) => {
      if (armed && opts?.description === 'Finish session') {
        armed = false
        await realTx(tx => tx.run(deleteBlock, {id: covering}),
          {scope: ChangeScope.BlockDefault, description: 'a peer deletes the layoff'})
      }
      return realTx(fn, opts as never)
    }) as typeof repo.tx

    try {
      expect(await closeSession(repo, WORKSPACE_ID, tonight)).toBe('changed')
    } finally {
      repo.tx = realTx
    }
    // And pressing Finish again decides afresh: with no record left, the gap
    // gets written rather than silently lost.
    expect(await closeSession(repo, WORKSPACE_ID, tonight)).toBe('done')
    expect(buildLayoffs(
      await repo.queryBlocks({workspaceId: WORKSPACE_ID, types: [LAYOFF_TYPE]}),
    ).some(l => l.from === '2026-07-14')).toBe(true)
  })

  it('refuses to close when the session kind flipped under the layoff decision', async () => {
    // `isMini` is read before the transaction, and it decides whether a layoff
    // is recorded AT ALL. Flip `strength:session` from `mini` to `A` in another
    // panel after that read and the session closed as a full one with no
    // record — after which the gap is undetectable on every later day, so the
    // re-entry cut is lost for good rather than merely misfiled. Refused here
    // so the next press decides afresh.
    const workoutId = await startAndLog()

    expect(await finishSession(repo, workoutId, undefined, {mini: true})).toBe('changed')

    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
  })

  it('still closes when the session kind is what the caller decided against', async () => {
    // The other half of the mutation: a fence that refuses everything passes
    // the test above for the wrong reason.
    const workoutId = await startAndLog()

    expect(await finishSession(repo, workoutId, undefined, {mini: false})).toBe('done')
  })

  it('carries the session kind from closeSession into the finish, not just accepts one', async () => {
    // Driving `closeSession`, because the fence above is only worth having if
    // the caller that makes the layoff decision actually passes it — and with
    // `finishSession` tested directly, dropping `mini` at the call site broke
    // no test at all. The flip is landed from inside the finishing
    // transaction's own opening, which is the real window: `closeSession`
    // reads the workout, and several awaits later the transaction commits.
    const workoutId = await startAndLog({session: 'mini'})
    const realTx = repo.tx.bind(repo)
    let armed = true
    repo.tx = (async (fn: never, opts: {description?: string}) => {
      if (armed && opts?.description === 'Finish session') {
        armed = false
        await realTx(tx => tx.setProperty(workoutId, sessionProp, 'A'),
          {scope: ChangeScope.BlockDefault, description: 'another panel changes the session kind'})
      }
      return realTx(fn, opts as never)
    }) as typeof repo.tx

    try {
      expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('changed')
    } finally {
      repo.tx = realTx
    }
    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
  })

  it('deepens the record when the same break is re-measured as worse', async () => {
    // The other side of "one record per gap". A comeback recorded, then taken
    // back by unticking every set of it — after which `buildHistory` stops
    // counting that day as training, so the next real return measures the SAME
    // `from` across a longer gap and lands on the SAME derived seat.
    // `adoptTypedBlock` does not apply properties, so without a deliberate
    // write the record kept naming the retracted comeback: a lighter tier, and
    // an earlier `to` that inflates `sessionsBack`. Both feed `resolveReentry`,
    // so the ramp returned to full loads faster than the real break warrants.
    const light = {from: '2026-07-01', to: '2026-07-15', days: 14, tierId: '1-2w', pct: 0.9}
    const seat = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, light)

    const deeper = {from: '2026-07-01', to: '2026-09-01', days: 62, tierId: '2mo+', pct: 0.5}
    const again = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, deeper)

    // Same block — one break, one record — carrying the deeper measurement.
    expect(again).toBe(seat)
    const layoffs = buildLayoffs(await liveChildren(PAGE_ID, LAYOFF_TYPE))
    expect(layoffs).toHaveLength(1)
    expect(layoffs[0]).toMatchObject({from: '2026-07-01', to: '2026-09-01', days: 62, pct: 0.5})
    // The generated label moved with it, or the block reads as a gap it no
    // longer records.
    expect(repo.block(seat).peek()?.content).toContain('62-day gap')
  })

  it('will not loosen a record that already names a deeper break', async () => {
    // Severity is the merge rule, so it is order-independent: whichever client
    // writes second, the harsher measurement survives. This is the half that
    // keeps two clients dating one return differently from moving it.
    const deeper = {from: '2026-07-01', to: '2026-09-01', days: 62, tierId: '2mo+', pct: 0.5}
    const seat = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, deeper)

    const light = {from: '2026-07-01', to: '2026-07-15', days: 14, tierId: '1-2w', pct: 0.9}
    expect(await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, light)).toBe(seat)

    const layoffs = buildLayoffs(await liveChildren(PAGE_ID, LAYOFF_TYPE))
    expect(layoffs[0]).toMatchObject({to: '2026-09-01', days: 62, pct: 0.5})
  })

  it('keeps a label you renamed, even while correcting the numbers', async () => {
    // The properties are derived and ours to rewrite; the text is not. A stale
    // number in a line you wrote yourself is a smaller loss than replacing
    // what you wrote.
    const light = {from: '2026-07-01', to: '2026-07-15', days: 14, tierId: '1-2w', pct: 0.9}
    const seat = await writeLayoff(repo, WORKSPACE_ID, PAGE_ID, light)
    await repo.tx(tx => tx.update(seat, {content: 'the shoulder thing'}),
      {scope: ChangeScope.BlockDefault, description: 'rename the record'})

    await writeLayoff(repo, WORKSPACE_ID, PAGE_ID,
      {from: '2026-07-01', to: '2026-09-01', days: 62, tierId: '2mo+', pct: 0.5})

    expect(repo.block(seat).peek()?.content).toBe('the shoulder thing')
    expect(buildLayoffs(await liveChildren(PAGE_ID, LAYOFF_TYPE))[0]).toMatchObject({days: 62})
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
    // The home IS bootstrapped when the finish lands — the record needs
    // somewhere to live. The test below is that it is not bootstrapped when
    // the finish refuses, which only means anything if this holds.
    expect(await findStrengthLogPage(repo, WORKSPACE_ID)).not.toBeNull()

    // Queried by type, not under the test's page: `closeSession` resolves the
    // real Strength Log page itself, which is where the record lands.
    const layoffs = buildLayoffs(
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [LAYOFF_TYPE]}).load())
    expect(layoffs).toHaveLength(1)
    expect(layoffs[0].to).toBe(performedOn)
    expect(layoffs[0].days).toBe(35)
  })

  it('does not let a MINI session record the comeback', async () => {
    // `fullSessionDays` — what `detectPendingLayoff` measures gaps between —
    // excludes mini days on purpose: they are habit continuity, not stimulus.
    // Recording one anyway dated the comeback to the mini day, and because the
    // record is keyed on `from`, the real full session back could not replace
    // it: every later prescription then resolved against a SHORTER gap and
    // whatever tier that fell in, so a deep re-entry could jump to a much
    // heavier tier after one easy session.
    const long = dayBefore(60)
    const miniDay = dayBefore(25)
    const fullDay = dayBefore(24)
    const oldId = await startAndLog({day: long})
    expect(await finishSession(repo, oldId)).toBe('done')

    const mini = await startAndLog({day: miniDay, session: 'mini', lifts: [lift('Row')]})
    expect(await closeSession(repo, WORKSPACE_ID, mini)).toBe('done')

    expect(await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [LAYOFF_TYPE]}).load())
      .toHaveLength(0)

    // …and the first FULL session back records the real return.
    const full = await startAndLog({day: fullDay, session: 'B', lifts: [lift('Row')]})
    expect(await closeSession(repo, WORKSPACE_ID, full)).toBe('done')

    const layoffs = buildLayoffs(
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [LAYOFF_TYPE]}).load())
    expect(layoffs).toHaveLength(1)
    expect(layoffs[0].to).toBe(fullDay)
  })

  it('bootstraps no page at all when the finish it was for refuses', async () => {
    // A gap record needs a home, and creating that home is a WRITE — while
    // every Finish refusal is documented as writing nothing. Built eagerly, a
    // refusal left a real synced Strength Log page and settings block behind
    // for a session that was never recorded, on the one path that is reached
    // once per comeback and so is exactly where you notice it least.
    const oldId = await startAndLog({day: dayBefore(60)})
    expect(await finishSession(repo, oldId)).toBe('done')
    expect(await findStrengthLogPage(repo, WORKSPACE_ID)).toBeNull()

    // Started, nothing ticked: a pending gap, and a finish that will refuse.
    const workoutId = await startSession(
      repo, WORKSPACE_ID, PAGE_ID, plan({day: dayBefore(25), session: 'B', lifts: [lift('Row')]}))

    expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('nothing-logged')

    expect(await findStrengthLogPage(repo, WORKSPACE_ID)).toBeNull()
  })
})

describe('a set control still pointing at a block that left the strength world', () => {
  it('refuses the adjustment instead of rewriting an untyped block', async () => {
    // The fourth reader to need this, and the same rule as `isStandingToday`,
    // `checkFinishable` and `discardSession`: `strength:weight`/`strength:reps`
    // survive an untag, so a ± control rendered before another pane removed
    // `strength-set` went on rewriting the numbers AND restamping a
    // `135lb × 8` content line over whatever the block says now.
    const workoutId = await startAndLog()
    const [entry] = await liveChildren(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await liveChildren(entry.id, SET_TYPE)
    await repo.tx(tx => tx.update(set.id, {content: 'a note now, not a set'}),
      {scope: ChangeScope.BlockDefault, description: 'repurpose the block'})
    await repo.removeType(set.id, SET_TYPE)

    expect(await adjustSet(repo, set.id, {weightSteps: 1})).toBe('gone')

    expect(repo.block(set.id).peek()?.content).toBe('a note now, not a set')
    expect(repo.block(set.id).peek()?.properties[FIELD.weight]).toBe(135)
  })

  it('still adjusts a set that is genuinely still a set', async () => {
    // The other half of the mutation: a guard that refuses everything passes
    // the test above for the wrong reason.
    const workoutId = await startAndLog()
    const [entry] = await liveChildren(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await liveChildren(entry.id, SET_TYPE)

    expect(await adjustSet(repo, set.id, {weightSteps: 1})).toBe('written')
    expect(repo.block(set.id).peek()?.properties[FIELD.weight]).toBe(140)
  })
})

describe('an edit still in flight when Finish is tapped', () => {
  /** A repo whose writes reject, standing in for the ordinary ways a write
   *  fails (offline, read-only, a rejected transaction). `adjustSet` reaches
   *  the repo through `repo.tx` alone, so this is the whole surface. */
  const writesFail = {tx: async () => { await Promise.resolve(); throw new Error('the write failed') }}

  /** A real set under the workout — the failure is scoped to the session that
   *  OWNS the set now, so a made-up id would be dropped as belonging to no
   *  session at all (which is itself asserted below). */
  const aSetOf = async (workoutId: string): Promise<string> => {
    const [entry] = await liveChildren(workoutId, EXERCISE_ENTRY_TYPE)
    const [set] = await liveChildren(entry.id, SET_TYPE)
    return set.id
  }

  it('refuses rather than closing around the number that never landed', async () => {
    // The blur commits the weight field, the click commits the session, and
    // the two are independent transactions with nothing sequencing them. Lose
    // that race and the record keeps the OLD number while the edit refuses as
    // `closed` — pointing you at a reopen the extension does not offer.
    const workoutId = await startAndLog()

    const write = adjustSet(writesFail as unknown as Repo, await aSetOf(workoutId), {set: {weight: 145}})
    write.catch(() => {})
    // Called with the write still in flight — no await between them, which is
    // exactly the gap between mousedown and mouseup on the Finish button.
    expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('edit-failed')

    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
  })

  it('refuses once for a write that failed BEFORE the tap, then lets you close', async () => {
    // Waiting on the in-flight set alone only catches a write still RUNNING.
    // Lose by a hair the other way — the blur's write rejects between mousedown
    // and mouseup — and the set is empty again by the time Finish looks, so it
    // closed around the old number while the row was saying "could not save
    // that", and the closed-session guard refused every retry after.
    const workoutId = await startAndLog()
    await adjustSet(writesFail as unknown as Repo, await aSetOf(workoutId), {set: {weight: 145}})
      .catch(() => {})

    expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('edit-failed')
    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')

    // …and it clears on the way out, so the refusal happens once. It has to:
    // the alternative is a session nothing can close until some write
    // succeeds, and "I know, 135 is right, finish it" is a fair answer to
    // being told. Tapping Finish again means you were told.
    expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('done')
  })

  it('gives every OVERLAPPING finish attempt the same verdict', async () => {
    // Clearing the flag on read is what makes the refusal happen once — but
    // two taps that overlap (the same workout in two panels) both awaited,
    // both resumed, and only the first saw the failure: the second read the
    // flag the first had just cleared and closed the session around the
    // unsaved number. Started without awaiting between them, which is the
    // whole scenario.
    const workoutId = await startAndLog()
    await adjustSet(writesFail as unknown as Repo, await aSetOf(workoutId), {set: {weight: 145}})
      .catch(() => {})

    const [first, second] = await Promise.all([
      closeSession(repo, WORKSPACE_ID, workoutId),
      closeSession(repo, WORKSPACE_ID, workoutId),
    ])

    expect([first, second]).toEqual(['edit-failed', 'edit-failed'])
    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
  })

  it('does not let one workout consume another workout\'s failure', async () => {
    // Two live sessions is a supported state — nesting makes one, a peer makes
    // the other. A module-wide flag let finishing B consume A's failure: B got
    // a refusal about a set it does not own, and A then closed around the
    // stale value with nothing left to warn it. Both halves asserted.
    const mine = await startAndLog()
    const theirs = await startAndLog({day: '2026-07-25', session: 'B', lifts: [lift('Row')]})
    await adjustSet(writesFail as unknown as Repo, await aSetOf(mine), {set: {weight: 145}})
      .catch(() => {})

    // Not theirs to answer for…
    expect(await closeSession(repo, WORKSPACE_ID, theirs)).toBe('done')
    // …and still mine to be told about.
    expect(await closeSession(repo, WORKSPACE_ID, mine)).toBe('edit-failed')
    expect(await closeSession(repo, WORKSPACE_ID, mine)).toBe('done')
  })

  it('lets an unrelated session close when a failed set belongs to no workout', async () => {
    // A deleted set — or, here, one that never existed. The verdict requires
    // the failure to be THIS workout's, so an unresolvable one cannot refuse
    // anything. (The matching delete inside the drain is housekeeping and is
    // deliberately not what this pins; see its comment.)
    const workoutId = await startAndLog()
    await adjustSet(writesFail as unknown as Repo, 'never-existed', {weight: 5}).catch(() => {})

    expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('done')
  })

  it('takes the warning back when a retry of the same set lands', async () => {
    // The marker was write-once: correct the set, watch it save, and Finish
    // still refused with "a change did not save" — pointing you at a value
    // that is already stored. Nothing was wrong except the record of it.
    const workoutId = await startAndLog()
    const setId = await aSetOf(workoutId)
    await adjustSet(writesFail as unknown as Repo, setId, {set: {weight: 145}}).catch(() => {})

    // The retry, against the real repo this time.
    expect(await adjustSet(repo, setId, {set: {weight: 145}})).toBe('written')

    expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('done')
  })

  it('does not wait on an edit belonging to another workout', async () => {
    // Two live sessions is supported, and the drain snapshotted every edit in
    // the module — so a slow write in A held Finish on B, which has no pending
    // edit of its own. A's write is held open for the duration and released at
    // the end, rather than left never-settling: an unsettled promise outlives
    // the test in module state, and the next test to drain would wait on it.
    const mine = await startAndLog()
    const theirs = await startAndLog({day: '2026-07-25', session: 'B', lifts: [lift('Row')]})
    let release = (): void => {}
    const held = new Promise<never>((_, reject) => { release = () => reject(new Error('let go')) })
    const slow = {tx: () => held}
    const pending = adjustSet(slow as unknown as Repo, await aSetOf(theirs), {set: {weight: 145}})
    pending.catch(() => {})

    // Returns while A's write is still running. Before the split it could not.
    expect(await closeSession(repo, WORKSPACE_ID, mine)).toBe('done')

    release()
    await pending.catch(() => {})
  })

  it('does not carry a reported failure into an unrelated later Finish', async () => {
    // The same clearing from the other side: a failure already reported must
    // not still be sitting there when you close the NEXT session.
    const first = await startAndLog()
    await adjustSet(writesFail as unknown as Repo, await aSetOf(first), {weight: 5}).catch(() => {})
    expect(await closeSession(repo, WORKSPACE_ID, first)).toBe('edit-failed')
    expect(await closeSession(repo, WORKSPACE_ID, first)).toBe('done')

    const second = await startAndLog({day: '2026-07-25', session: 'B', lifts: [lift('Row')]})
    expect(await closeSession(repo, WORKSPACE_ID, second)).toBe('done')
  })
})

describe('ordering two sessions of one training day', () => {
  it('survives unticking everything Finish stamped and ticking a skipped set', async () => {
    // `recordedAt` is derived from the done sets' `completedAt`, and the
    // native checkbox writes only `status` — so correcting a closed session by
    // unticking what Finish stamped and ticking a set you had skipped leaves
    // every done set without one. The workout then had no ordering stamp at
    // all, `compareRecords` called it incomparable with the day's other
    // session, and query order picked the progression baseline.
    const workoutId = await startSession(
      repo, WORKSPACE_ID, PAGE_ID, plan({lifts: [lift('Bench press', {prescribedSets: 2,
        sets: [{weight: 135, reps: 8}, {weight: 145, reps: 8}]})]}))
    const [entry] = await liveChildren(workoutId, EXERCISE_ENTRY_TYPE)
    const [first, second] = await liveChildren(entry.id, SET_TYPE)
    await repo.tx(tx => tx.setProperty(first.id, todoStatusProp, 'done'),
      {scope: ChangeScope.BlockDefault, description: 'tick the first'})
    expect(await finishSession(repo, workoutId)).toBe('done')

    // The correction: what Finish stamped goes off, what it skipped goes on.
    await repo.tx(async tx => {
      await tx.setProperty(first.id, todoStatusProp, 'open')
      await tx.setProperty(second.id, todoStatusProp, 'done')
    }, {scope: ChangeScope.BlockDefault, description: 'correct the record'})

    const [record] = buildHistory(
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [WORKOUT_TYPE]}).load(),
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [EXERCISE_ENTRY_TYPE]}).load(),
      await repo.query.typedBlocks({workspaceId: WORKSPACE_ID, types: [SET_TYPE]}).load(),
    )
    // Still orderable — and still reading the corrected set, not the old one.
    expect(record.recordedAt).toBeGreaterThan(0)
    expect(record.exercises[0].sets.map(s => s.weight)).toEqual([145])
  })
})

describe('closeSession, before the finish transaction', () => {
  it('says the workout is gone rather than undated when a peer discarded it', async () => {
    // Reading a date off a row that is not there produced `undefined`, which
    // this path reads as an unreadable date — so the footer told you to set a
    // date on a workout that no longer exists. `finishSession` would have said
    // `gone`; this says it too, and one await earlier.
    const workoutId = await startAndLog()
    expect(await discardSession(repo, workoutId)).toBe('discarded')

    expect(await closeSession(repo, WORKSPACE_ID, workoutId)).toBe('gone')
  })
})

describe('the finish transaction re-checks what the caller validated', () => {
  it('refuses when the date changed between the read and the transaction', async () => {
    // `strength:date` is hand-editable and the caller's read is several awaits
    // old. Cleared in that window the workout closes and `buildHistory` drops
    // it whole; changed to another valid day it closes with a layoff measured
    // to the old one.
    const workoutId = await startAndLog()

    expect(await finishSession(repo, workoutId, undefined, {date: 'a different stored value'})).toBe('undated')

    expect(repo.block(workoutId).peekProperty(statusProp)).toBe('in-progress')
  })

  it('closes when the stored value still matches', async () => {
    const workoutId = await startAndLog()
    // Raw, not a decoded day: decoding on both sides let two decoders
    // disagree, and any rollover past 12 then made every workout permanently
    // unfinishable.
    const stored = repo.block(workoutId).peek()?.properties['strength:date']
    expect(await finishSession(repo, workoutId, undefined, {date: stored})).toBe('done')
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

describe('which live session a tap continues', () => {
  const DAY = '2026-07-24'
  const NOW = new Date(`${DAY}T20:00:00`)

  /** A workout row with an explicit birth time, so the ordering under test is
   *  the one asserted rather than whatever two same-millisecond inserts
   *  happened to produce. */
  const liveWorkout = async (id: string, createdAt: number, status = 'in-progress'): Promise<void> => {
    await repo.tx(async tx => {
      await tx.create({
        id, workspaceId: WORKSPACE_ID, parentId: PAGE_ID, orderKey: 'a1', content: 'session',
      }, {sourceTimestamps: {createdAt, userUpdatedAt: createdAt}})
      await tx.setProperties(id, {set: [
        propertyValue(statusProp, status as 'in-progress' | 'done'),
        propertyValue(sessionProp, 'A'),
        propertyValue(dateProp, dayToDate(DAY)),
      ]})
      await repo.addTypeInTx(tx, id, WORKOUT_TYPE, {}, repo.snapshotTypeRegistries())
    }, {scope: ChangeScope.BlockDefault, description: 'a session'})
  }

  const standing = async (): Promise<string | null> =>
    standingSession(repo, WORKSPACE_ID, await readProgram(repo, WORKSPACE_ID), NOW)

  it('finds nothing when nothing is under way', async () => {
    expect(await standing()).toBeNull()
  })

  it('ignores a session that is already done', async () => {
    await liveWorkout('aaaaaaaa-1111-4111-8111-111111111111', 1_000, 'done')
    expect(await standing()).toBeNull()
  })

  it('takes the most recently started when two look live', async () => {
    // A device holding the second session's create row but not yet the first's
    // `done` update sees both as in-progress. The ids are chosen so that the
    // OLDER one sorts first: picking the lowest would send you to the session
    // you already finished, whose set checkboxes are still live, and log
    // tonight's work into last night's record.
    await liveWorkout('aaaaaaaa-1111-4111-8111-111111111111', 1_000)
    await liveWorkout('ffffffff-2222-4222-8222-222222222222', 2_000)

    expect(await standing()).toBe('ffffffff-2222-4222-8222-222222222222')
  })

  // Directly, not through `standingSession`: the query happens to return rows
  // in an order that yields the same answer, so a test through it passes with
  // the tie-break clause deleted. Both orderings, since the whole point of the
  // clause is that the answer does not depend on the order rows arrive in.
  it('breaks a tie on id, so every device names the same one', () => {
    const older = {id: 'aaaa', createdAt: 5_000}
    const newer = {id: 'ffff', createdAt: 5_000}
    expect(mostRecentlyStarted([older, newer])).toBe('aaaa')
    expect(mostRecentlyStarted([newer, older])).toBe('aaaa')
  })

  it('prefers the later start whichever order the rows arrive in', () => {
    const first = {id: 'ffff', createdAt: 1_000}
    const second = {id: 'aaaa', createdAt: 2_000}
    expect(mostRecentlyStarted([first, second])).toBe('aaaa')
    expect(mostRecentlyStarted([second, first])).toBe('aaaa')
  })

  it('has no answer for an empty list', () => {
    expect(mostRecentlyStarted([])).toBeNull()
  })
})
