/** The strength writes that are not a session.
 *
 *  Logging lives in `session.ts` — this holds what sits beside it: the user's
 *  `or`-group choices, the layoff record, the shoulder-consult todo, and
 *  discarding a session outright.
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
import {ALT_CHOICE_TYPE, FIELD, LAYOFF_TYPE} from './fields'
import {
  choiceGroupProp,
  choiceOptionProp,
  layoffDaysProp,
  layoffFromProp,
  layoffPctProp,
  layoffTierProp,
  layoffToProp,
} from './schema'
import {dateToDay, dayToDate} from './day'

import {buildAltChoices} from './history'

type TypeSnapshot = ReturnType<Repo['snapshotTypeRegistries']>

/** Which training day a raw `date` property lands on, read the way the
 *  readers read it. */
const liveDay = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? undefined : dateToDay(date)
}

// ──── layoff ────

const LAYOFF_NS = 'cfa6899f-981a-4dac-8eae-978150c019a9'

/** A layoff is keyed on where the gap STARTS, not the whole range: `to`
 *  ("when you came back") is the field two clients can disagree about, and
 *  keying on the range would give the two finishes separate records —
 *  `resolveReentry` would then read the later `to` as most recent and restart
 *  `sessionsBack`, undoing loads already climbed back to. Keyed on `from`,
 *  the second finish ADOPTS the first record instead. */
const layoffIdentity = (workspaceId: string, from: string): DerivedIdentity =>
  ({namespace: LAYOFF_NS, key: `${workspaceId}|${from}`})

const isGapRecord = (block: BlockData, from: string): boolean =>
  liveDay(block.properties[FIELD.layoffFrom]) === from

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
): Promise<string> => {
  const spec = {
    parentId: pageId,
    content: `Layoff · ${record.days}-day gap → ${Math.round(record.pct * 100)}% (${record.tierId})`,
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
  if (outcome.status !== 'taken') return outcome.id

  // The derived seat is held by a tombstone, another workspace's row, or a
  // block whose `from` now names a different gap. There's no second identity
  // to derive, so mint — and look the mint up on the NEXT call rather than
  // add to it. The page's children, because that's where a mint lands.
  const minted = (await tx.childrenOf(pageId, undefined, {hidePropertyChildren: true}))
    .find(block => !block.deleted && block.id !== outcome.id
      && hasBlockType(block, LAYOFF_TYPE) && isGapRecord(block, record.from))
  return minted !== undefined
    ? (await adoptTypedBlock(repo, tx, minted, spec.types, typeSnapshot)).id
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
): Promise<'discarded' | 'gone'> =>
  repo.tx(async tx => {
    const workout = await tx.get(workoutId)
    if (!workout || workout.deleted) return 'gone' as const
    if (workout.properties[FIELD.status] !== 'in-progress') return 'gone' as const
    await tx.run(deleteBlock, {id: workoutId})
    return 'discarded' as const
  }, {scope: ChangeScope.BlockDefault, description: 'Discard workout'})

// ──── or-group choices ────

const choiceContent = (label: string): string => `Tracking: ${label}`

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
    const existing = children.find(child =>
      !child.deleted && child.properties[FIELD.choiceGroup] === groupKey)

    if (existing) {
      await tx.update(existing.id, {content: choiceContent(label)})
      await tx.setProperty(existing.id, choiceOptionProp, optionKey)
      return
    }

    await createTypedChild(repo, tx, {
      parentId: settingsBlockId,
      content: choiceContent(label),
      types: [ALT_CHOICE_TYPE],
      properties: [
        propertyValue(choiceGroupProp, groupKey),
        propertyValue(choiceOptionProp, optionKey),
      ],
      typeSnapshot,
    })
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
