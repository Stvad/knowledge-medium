/** The strength writes that are not a session.
 *
 *  Logging lives in `session.ts` — this holds what sits beside it: the user's
 *  `or`-group choices, the layoff record, and discarding a session outright.
 *
 *  It used to hold the whole logging path as well: materialize-on-first-edit,
 *  per-set patch writes, prune-at-Finish, and the derived-id machinery that
 *  kept a draft in agreement with the blocks it shadowed. All of that is gone
 *  with the draft — the outline is the state now, and a set is edited by
 *  editing its block.
 *
 *  The read side lives in the pure `history.ts` module (re-exported below).
 */

import {ChangeScope, propertyValue, type BlockData, type Tx} from '@/data/api/index.js'
import {deleteBlock} from '@/data/mutators.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'
import {
  adoptTypedBlock, createTypedChild, getOrCreateTypedChild, type DerivedIdentity,
} from '@/data/typedRecords.js'

import type {LayoffRecord} from '../engine/types'
import {ALT_CHOICE_TYPE, FIELD, LAYOFF_TYPE, WORKOUT_TYPE} from './fields'
import {
  choiceGroupProp,
  choiceOptionProp,
  layoffDaysProp,
  layoffFromProp,
  layoffPctProp,
  layoffTierProp,
  layoffToProp,
} from './schema'
import {dateToDay, dayToDate, storedDate} from './day'
import {discardTally, nestedWorkouts, type DiscardTally} from './subtree'

import {buildAltChoices} from './history'

type TypeSnapshot = ReturnType<Repo['snapshotTypeRegistries']>

/** Which training day a raw `date` property lands on, read the way the
 *  readers read it — via `storedDate`, so a hand-edited date names the day it
 *  says. */
const liveDay = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : dateToDay(storedDate(date))
}

// ──── layoff ────

const LAYOFF_NS = 'cfa6899f-981a-4dac-8eae-978150c019a9'

/** A layoff is keyed on where the gap STARTS, not the whole range: `to`
 *  ("when you came back") is the field two clients can disagree about, and
 *  keying on the range would give the two finishes separate records —
 *  `resolveReentry` would then read the later `to` as most recent and restart
 *  `sessionsBack`, undoing loads already climbed back to. Keyed on `from`,
 *  the second finish ADOPTS the first record instead.
 *
 *  Adopting is not quite leaving it alone, though — see `refreshLayoff`. The
 *  same seat is reached whenever the same break is re-measured, so the adopt
 *  DEEPENS the record when the new measurement is more severe, and otherwise
 *  returns it untouched. The two clients above still both write the same tier,
 *  so the second stops before writing at all; what changes is that a comeback
 *  since taken back no longer holds the ramp at the lighter tier it named. */
const layoffIdentity = (workspaceId: string, from: string): DerivedIdentity =>
  ({namespace: LAYOFF_NS, key: `${workspaceId}|${from}`})

const isGapRecord = (block: BlockData, from: string): boolean =>
  liveDay(block.properties[FIELD.layoffFrom]) === from

const layoffContent = (days: unknown, pct: unknown, tierId: unknown): string =>
  `Layoff · ${String(days)}-day gap → ${Math.round(Number(pct) * 100)}% (${String(tierId)})`

/** Deepen a record already at this gap's seat, when the break has been
 *  re-measured as worse than it says.
 *
 *  `getOrCreateTypedChild` deliberately does not apply `content`/`properties`
 *  on adopt — the block on disk holds real state and a caller's defaults must
 *  not flatten it — and tells callers wanting upsert semantics to write the
 *  fields they changed themselves. This is that write, and a layoff record is
 *  the shape it is meant for: every field on it is DERIVED from history, so
 *  there is no user state to protect. Only `content` can have been touched by
 *  hand, and that is checked before it is replaced.
 *
 *  Needed because the record is keyed on `from` alone, so the same seat is
 *  reached whenever the same break is re-measured. See `layoffAlreadyRecorded`
 *  for how a break gets re-measured (untick a comeback session and it stops
 *  being a training day) and for why the comparison is severity rather than
 *  the return date: a record only ever gets HARSHER, so clients converge on
 *  the deepest measurement in any order, and this can never loosen a cut.
 *
 *  Re-checked here rather than trusted from the caller: this runs inside the
 *  finish transaction, where the block on disk is the only current answer —
 *  `layoffAlreadyRecorded` read a snapshot taken before it opened. */
const refreshLayoff = async (
  tx: Tx,
  id: string,
  record: Omit<LayoffRecord, 'id'>,
  spec: {content: string; properties: ReturnType<typeof propertyValue>[]},
): Promise<string> => {
  const block = await tx.get(id)
  const recorded = block?.properties[FIELD.layoffPct]
  // Already at least this severe — including the equal case, which is two
  // clients recording one comeback and is what keying on `from` is for.
  if (!block || (typeof recorded === 'number' && recorded <= record.pct)) return id
  // The generated label only. Renamed by hand, the text is the user's, and a
  // stale number in it is a smaller loss than overwriting what they wrote.
  if (block.content === layoffContent(
    block.properties[FIELD.layoffDays],
    recorded,
    block.properties[FIELD.layoffTier],
  )) await tx.update(id, {content: spec.content})
  await tx.setProperties(id, {set: spec.properties})
  return id
}

/** Exported for `finishSession`, which must write the layoff inside its OWN
 *  transaction — the gap stops being detectable the moment the finish lands,
 *  so a separate write that fails loses the record permanently. */
export const writeLayoffInTx = async (
  repo: Repo,
  tx: Tx,
  workspaceId: string,
  pageId: string,
  record: Omit<LayoffRecord, 'id'>,
  typeSnapshot: TypeSnapshot,
  /** Every layoff block the caller could see before opening the transaction.
   *  The adopt below is deliberately parent-agnostic — a layoff is about a gap
   *  in time, not where it sits — so the re-find must be too: a mint the user
   *  has since filed elsewhere was invisible to a page-children scan, and the
   *  next finish minted a SECOND record for the same gap. History reads
   *  layoffs workspace-wide, so both then feed re-entry and the later one can
   *  restart a ramp already climbed out of. Re-checked in-tx, so a stale list
   *  can only cause a mint, never a bad adoption. */
  knownLayoffIds: readonly string[] = [],
): Promise<string> => {
  const spec = {
    parentId: pageId,
    content: layoffContent(record.days, record.pct, record.tierId),
    position: {kind: 'first'} as const,
    types: [LAYOFF_TYPE],
    properties: [
      propertyValue(layoffFromProp, dayToDate(record.from)),
      propertyValue(layoffToProp, dayToDate(record.to)),
      propertyValue(layoffDaysProp, record.days),
      propertyValue(layoffTierProp, record.tierId),
      propertyValue(layoffPctProp, record.pct),
    ],
    typeSnapshot,
  }
  const outcome = await getOrCreateTypedChild(repo, tx, {
    identity: layoffIdentity(workspaceId, record.from),
    // No parentage check, unlike workout/entry/set records: a layoff is about
    // a gap in time, not where it sits, so a block filed elsewhere is still
    // THIS gap's record. It does have to still SAY it is this gap, though:
    // `layoffAlreadyRecorded` reads `strength:from` rather than the id, and
    // the loss is permanent once the comeback session joins history.
    adoptable: block => isGapRecord(block, record.from),
    ...spec,
  })
  if (outcome.status === 'created') return outcome.id
  if (outcome.status === 'adopted') return refreshLayoff(tx, outcome.id, record, spec)

  // The derived seat is held by a tombstone, another workspace's row, or a
  // block whose `from` now names a different gap. There's no second identity
  // to derive, so mint — and look the mint up on the NEXT call rather than
  // add to it. The page's children, because that's where a mint lands.
  const candidates = new Map<string, BlockData>()
  for (const block of await tx.childrenOf(pageId, undefined, {hidePropertyChildren: true})) {
    candidates.set(block.id, block)
  }
  for (const id of knownLayoffIds) {
    if (candidates.has(id)) continue
    const block = await tx.get(id)
    if (block) candidates.set(id, block)
  }
  const minted = [...candidates.values()]
    .find(block => !block.deleted && block.id !== outcome.id
      && hasBlockType(block, LAYOFF_TYPE) && isGapRecord(block, record.from))
  return minted !== undefined
    ? refreshLayoff(
      tx, (await adoptTypedBlock(repo, tx, minted, spec.types, typeSnapshot)).id, record, spec,
    )
    : createTypedChild(repo, tx, spec)
}

export const writeLayoff = async (
  repo: Repo,
  workspaceId: string,
  pageId: string,
  record: Omit<LayoffRecord, 'id'>,
): Promise<string> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  return repo.tx(
    tx => writeLayoffInTx(repo, tx, workspaceId, pageId, record, typeSnapshot),
    {scope: ChangeScope.BlockDefault, description: 'Record layoff'},
  )
}

// ──── discarding ────

/** Throw tonight's session away. Verified in-transaction rather than trusted
 *  from the caller: a stale button must not tombstone a completed record. */
export const discardSession = async (
  repo: Repo,
  workoutId: string,
  /** What the caller counted before deciding whether to warn — BOTH kinds, so
   *  the recheck covers everything the warning described.
   *
   *  Re-counted here and refused when it no longer matches: the count and the
   *  delete are separated by a dialog the user can sit in indefinitely — and
   *  by several awaits even when there is nothing to confirm. A peer ticking a
   *  set or typing a note in that gap turned a warned-about deletion into an
   *  unwarned one, on exactly the reading ("nothing here but the prescribed
   *  skeleton") that skips the dialog. Omit it to delete whatever is there,
   *  which is what a caller with no count to honour means. */
  expected?: DiscardTally,
): Promise<'discarded' | 'gone' | 'changed' | 'holds-a-session'> =>
  repo.tx(async tx => {
    const workout = await tx.get(workoutId)
    if (!workout || workout.deleted) return 'gone' as const
    // The TYPE as well as the status, and this is the destructive path: the
    // raw `strength:status` survives an untag, so a block that left the
    // strength world between the confirmation and here would still be
    // cascade-deleted with its whole subtree. Same rule as `isStandingToday`
    // and `checkFinishable` — one answer to "is this still a workout".
    if (!hasBlockType(workout, WORKOUT_TYPE)) return 'gone' as const
    if (workout.properties[FIELD.status] !== 'in-progress') return 'gone' as const

    // Another session filed under this one is not this one's to throw away.
    // The placement contract puts tonight's workout under whatever block the
    // cursor was on, including last week's unfinished session — and
    // `deleteBlock` cascades, so discarding the outer one tombstoned an
    // independent session whole. Worse where it hurts most: a nested session
    // with nothing ticked counts zero, so the confirmation never appeared and
    // the whole thing went silently. Refused rather than reparented, because
    // where those blocks should go instead is the user's call, not ours.
    const nested = await nestedWorkouts(
      id => tx.childrenOf(id, undefined, {hidePropertyChildren: true}),
      workoutId,
    )
    if (nested.length > 0) return 'holds-a-session' as const

    if (expected !== undefined) {
      const now = await discardTally(
        id => tx.childrenOf(id, undefined, {hidePropertyChildren: true}),
        workoutId,
      )
      if (now.logged !== expected.logged || now.yours !== expected.yours) return 'changed' as const
    }
    await tx.run(deleteBlock, {id: workoutId})
    return 'discarded' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Discard workout'})

// ──── or-group choices ────

const choiceContent = (label: string): string => `Tracking: ${label}`

const ALT_CHOICE_NS = '4e68c312-2b12-4dec-b6c3-b6ca96df272b'

/** One seat per group, so two clients answering the same group for the first
 *  time converge on one block instead of each minting their own. Keyed on the
 *  settings block as well as the group: the settings block is the scope the
 *  choice is read in, and two workspaces answering the same group are two
 *  different answers. */
export const choiceIdentity = (settingsBlockId: string, groupKey: string): DerivedIdentity =>
  ({namespace: ALT_CHOICE_NS, key: `${settingsBlockId}|${groupKey}`})

const isChoiceFor = (block: BlockData, groupKey: string): boolean =>
  block.properties[FIELD.choiceGroup] === groupKey

/** Record which option of an `or`-group the user is now tracking. One block
 *  per answered group, under the settings block, upserted so switching back
 *  and forth edits the same block instead of growing a log. Both ends are
 *  refs, so "what am I tracking in this slot?" is answerable from the plan
 *  outline's backlinks, and a deleted option leaves a visible dangling link
 *  rather than a silently stale map entry. */
export const writeAltChoice = async (
  repo: Repo,
  settingsBlockId: string,
  groupKey: string,
  optionKey: string,
  label: string,
): Promise<void> => {
  const typeSnapshot = repo.snapshotTypeRegistries()
  await repo.tx(async tx => {
    const children = await tx.childrenOf(settingsBlockId)
    const existing = children.filter(child => !child.deleted && isChoiceFor(child, groupKey))

    if (existing.length > 0) {
      // EVERY match, not the first. Blocks minted before this group had a
      // derived seat — and any pair that raced in before one existed — can
      // leave two blocks answering for one group. `buildAltChoices` folds in
      // order and keeps the LAST, while updating only the first leaves the
      // other still winning: the preference then stops sticking, permanently
      // and with nothing on screen to explain it. Writing all of them makes
      // them agree, so which one the fold lands on stops mattering.
      for (const child of existing) {
        await tx.update(child.id, {content: choiceContent(label)})
        await tx.setProperty(child.id, choiceOptionProp, optionKey)
      }
      return
    }

    const spec = {
      parentId: settingsBlockId,
      content: choiceContent(label),
      types: [ALT_CHOICE_TYPE],
      properties: [
        propertyValue(choiceGroupProp, groupKey),
        propertyValue(choiceOptionProp, optionKey),
      ],
      typeSnapshot,
    }
    // Derived, like the layoff above: two offline clients answering the same
    // group for the first time both see no child and both mint, and a random
    // id makes those two rows forever. One seat per group means they converge
    // on sync instead. The scan above still comes first, so a block minted
    // before this seat existed is adopted rather than duplicated.
    const outcome = await getOrCreateTypedChild(repo, tx, {
      identity: choiceIdentity(settingsBlockId, groupKey),
      adoptable: block => isChoiceFor(block, groupKey),
      ...spec,
    })
    // The seat is held by something that is not this group's choice — a
    // tombstone, or another workspace's row. There is no second identity to
    // derive, so mint; the scan above adopts it on the next call.
    if (outcome.status === 'taken') await createTypedChild(repo, tx, spec)
    // `BlockDefault`, not `UserPrefs`, even though this IS a preference: the
    // choice is stored as a real block, and `core.createChild` refuses to run
    // in a user-prefs transaction. Under `UserPrefs` the update path worked
    // and the FIRST pick for any group threw — which is every pick, until one
    // exists. Nothing had covered the create path.
  }, {scope: ChangeScope.BlockDefault, description: 'Choose exercise variant'})
}

/** `{groupId: optionId}` for every answered group — the shape the plan parser
 *  resolves `or`-groups against. An unanswered group is simply absent and
 *  falls back to the plan's own default. */
export const readAltChoices = async (
  repo: Repo,
  settingsBlockId: string,
): Promise<Record<string, string>> => {
  const children = await repo.block(settingsBlockId).children.load()
  return buildAltChoices((children ?? []).filter(child => !child.deleted))
}
