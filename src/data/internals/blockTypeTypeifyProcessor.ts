/**
 * Same-tx processor keeping a user-defined type's ONE name in agreement
 * across `content`, `block-type:label` and its claimed alias — a type IS
 * the page its name addresses, so the three are spellings of one string.
 *
 * Two jobs, on two transitions:
 *
 * **Completion**, when a block gains the `block-type` meta-type via a
 * local `repo.tx` — the `#type` gesture, programmatic tagging, or an
 * import that creates the row through `repo.tx`:
 *
 *   - **adopt content as the label** if it has none — an empty
 *     `block-type:label` makes `UserTypesService.tryBuildType` drop the
 *     type, so `book` tagged `block-type` would otherwise register
 *     nothing, and **refuse the tag** when content and an explicit label
 *     are two different names (`blockType.nameConflict`);
 *   - **tag it PAGE_TYPE** so it doubles as a navigable `[[Label]]` page
 *     (matches the `createTypeBlock` "type flow" pattern);
 *   - **ensure its label is in `alias`** so `[[Label]]` resolves to THIS
 *     block instead of minting a duplicate alias-seat page. Ensure-present
 *     (not only-if-empty): a block that already carries some OTHER alias
 *     still gets its type name claimed, appended to the existing set.
 *
 * Every completion step is init-if-missing / ensure-present, so it's
 * idempotent and never clobbers a label / PAGE_TYPE / alias set
 * explicitly upstream — `createTypeBlock` writes all three itself and
 * finds this a no-op. A blank block (no content) is left unnamed; it's
 * named later via the type editor, which seeds the alias then
 * (`writeBlockTypeLabel`).
 *
 * **Rename**, when a block that is ALREADY a type has its `content`
 * rewritten (the agent bridge, an import): the label and the claim on the
 * name follow it. Completion is a one-shot, so without this the type stayed
 * registered under a name nothing resolved to (#926).
 *
 * (Sync-applied writes do NOT run this — they bypass `repo.tx` and the
 * same-tx pass entirely. Where the originating device ran this code the
 * finished row replicates as data and the invariant holds; a peer that
 * PREDATES it can replicate a renamed content with the old label and claim
 * still attached, and nothing on this side reconciles that — #996, which a
 * repair pass would otherwise omit. The property-panel picker also never
 * reaches completion: it filters `block-type` out of its options.)
 *
 * A name another block holds is refused — by `assertAliasClaimable` before the
 * write on the rename path, and by the `block_aliases_workspace_alias_unique`
 * storage trigger everywhere else. Both roll the whole tx back.
 *
 * Both jobs write BlockDefault properties, so a tx declaring a scope that is
 * not policy-equivalent cannot carry them (#989 — it already cannot rename
 * anything that carries a name).
 *
 * Registered as a kernel processor so the invariant holds for every
 * block-type tag, and — being kernel — ahead of the alias plugin's
 * content<->alias sync in the same-tx pass.
 */

import {
  ProcessorRejection,
  defineSameTxProcessor,
  type AnySameTxProcessor,
  type BlockData,
  type ChangedRow,
  type SameTxCtx,
  type TxWriteOpts,
} from '@/data/api'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import {
  addBlockTypeToProperties,
  aliasesProp,
  blockTypeLabelProp,
  getAliases,
  getBlockTypes,
  typesProp,
} from '@/data/properties'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { assertAliasClaimable, claimedAliases } from '@/data/aliasClaim'
import { assertWritableLabel, isWritableLabel } from '@/data/referenceBlock'
import { seededDefinitionKey } from '@/data/definitionSeeds'
import { isTypeSeedKey } from '@/data/typeSeeds'

export const BLOCK_TYPE_TYPEIFY_PROCESSOR_NAME = 'core.blockTypeTypeify'

/** Needs no `rejectionToastFacet` contribution — the generic route falls
 *  back to the raw message, which says what to fix. */
export const BLOCK_TYPE_NAME_CONFLICT = 'blockType.nameConflict'

const readLabel = (row: BlockData): string =>
  safeDecodeRowProperty(row, blockTypeLabelProp).trim()

/** THROWS rather than skipping the name: a type whose name can't be written as
 *  `[[name]]` is unlinkable. Same-tx, so it rolls the tx back atomically; the
 *  refusal derives from `UnwritableLabelError`, which the type-label UI catches
 *  to revert. Needed on every path that names a type — the agent bridge's raw
 *  properties bag arrives here unvalidated. */
const assertWritableTypeName = (name: string): void =>
  assertWritableLabel(name, 'Block type label')

/** Move this type's claim: retire `retiring` and take `name`, in ONE write.
 *
 *  `name` is null where the new name CANNOT be claimed. Retiring and claiming
 *  answer different questions — the type stopped having the old name either
 *  way — so the release still happens. Leaving it holds that spelling against
 *  any other block taking it, and permanently: the next rename computes what to
 *  retire from the content it finds then, which no longer spells this one.
 *
 *  One write rather than append-then-retire: the intermediate bag goes through
 *  the maintenance trigger too, so it would re-insert the name being given up,
 *  and renaming AWAY from a name some sync-applied row co-claims would abort on
 *  the name being retired.
 *
 *  Accepted: a claim moved on a RERUN lands after `references.renameBacklinks`,
 *  so the old name's inbound spans are left alone — #991, not this write. */
const moveTypeClaim = async (
  after: BlockData,
  name: string | null,
  ctx: SameTxCtx,
  {retiring = [], ...writeOptions}: {retiring?: readonly string[]} & TxWriteOpts = {},
): Promise<void> => {
  const claimed = await claimedAliases(ctx.tx, after)
  const held = claimed.some(alias => retiring.includes(alias))
  // A release with nothing to release is not a write. `setProperty` elides a
  // write that changes the stored value nothing, but `undefined` -> `[]` IS a
  // change: without this it materializes an empty alias bag on a row that never
  // had one.
  if (name === null && !held) return
  // EVERY spelling of the old name goes, not the first one found: a bag holding
  // both `" Book "` and `Book` spells the old name twice, and retiring one left
  // the type answering to the other — which `alias.sync` then cleaned up, so
  // the kernel's result depended on an optional plugin being installed.
  //
  // The new name lands in the FIRST retired slot: the first entry is what a
  // block is displayed as (the sidebar reads `aliases[0]`), so a rename must
  // not promote some other alias by appending. Same replacement `alias.sync`'s
  // rule 1 would have made — this write just gets there first.
  const next: string[] = []
  let placed = false
  for (const alias of claimed) {
    if (!retiring.includes(alias)) {
      next.push(alias)
      continue
    }
    if (name !== null && !placed) {
      next.push(name)
      placed = true
    }
  }
  if (name !== null && !placed) next.push(name)
  // `setProperty` elides a write that changes nothing, so no guard here.
  await ctx.tx.setProperty(after.id, aliasesProp, [...new Set(next)], writeOptions)
}

const completeNewType = async (
  row: ChangedRow,
  after: BlockData,
  ctx: SameTxCtx,
): Promise<void> => {
  const currentLabel = readLabel(after)
  const trimmedContent = after.content.trim()
  const name = currentLabel || trimmedContent

  if (name !== '') assertWritableTypeName(name)

  // `aliasSyncProcessor` reconciles a rename by matching the OLD CONTENT, so
  // an alias tracking the LABEL is never replaced — it stays claimed, and
  // `[[oldName]]` keeps resolving here. An explicit label short-circuits
  // `name`, making this the only TAGGING path that can mint that shape.
  //
  // Declined: rewriting `content` to match (here it is text the user typed,
  // not a whitespace variant of the label).
  if (currentLabel !== '' && trimmedContent !== '' && trimmedContent !== currentLabel) {
    throw new ProcessorRejection(
      `Can't make this block a type: its text (${JSON.stringify(trimmedContent)}) and its ` +
      `${blockTypeLabelProp.name} (${JSON.stringify(currentLabel)}) are different names, but a type ` +
      `has ONE name — its text is the page title that "[[name]]" resolves to. Clear one of them, ` +
      `or make them match, and tag it again.`,
      BLOCK_TYPE_NAME_CONFLICT,
      {blockId: row.id, content: after.content, label: currentLabel},
    )
  }

  // PAGE_TYPE via the blessed raw membership helper (a full `properties`
  // write) goes FIRST; the label / alias amendments below are partial
  // `setProperty` writes that layer on top without clobbering it. All three
  // touch independent fields.
  if (!getBlockTypes(after).includes(PAGE_TYPE)) {
    await ctx.tx.update(row.id, {properties: addBlockTypeToProperties(after.properties, PAGE_TYPE)})
  }
  if (currentLabel === '' && name !== '') {
    await ctx.tx.setProperty(row.id, blockTypeLabelProp, name)
  }
  // Store the one name in `content` too. Lossless here — the refusal above
  // leaves only blank or whitespace-padded content — and it makes `content`
  // always a name the checks above already validated, so nothing downstream
  // has to re-validate it.
  if (name !== '' && after.content !== name) {
    await ctx.tx.update(row.id, {content: name})
  }
  if (name !== '') await moveTypeClaim(after, name, ctx)
}

/** A content write on a block that is already a type is a RENAME wherever the
 *  content WAS its name — so the label, and the claim on that name, follow it. */
const followRenamedContent = async (
  row: ChangedRow,
  after: BlockData,
  ctx: SameTxCtx,
): Promise<void> => {
  const before = row.before
  if (before === null || before.content === after.content) return

  const currentLabel = readLabel(after)
  // A label written in THIS tx is the naming gesture — the type editor writes
  // both halves — and a label CLEARED in it is the un-naming one. Either way
  // the label is the answer and nothing here second-guesses it.
  const previousLabel = readLabel(before)
  const labelMoved = previousLabel !== currentLabel
  const newContent = after.content.trim()

  // Two different names in ONE tx is the shape `completeNewType` refuses, and
  // it is refused here for the same reason: picking either silently discards a
  // name the caller wrote explicitly.
  if (labelMoved && currentLabel !== '' && newContent !== '' && newContent !== currentLabel) {
    throw new ProcessorRejection(
      `Can't rename this type: this change gives it two different names — its text ` +
      `(${JSON.stringify(newContent)}) and its ${blockTypeLabelProp.name} ` +
      `(${JSON.stringify(currentLabel)}) — but a type has ONE name, the page title that ` +
      `"[[name]]" resolves to. Write the same name to both.`,
      BLOCK_TYPE_NAME_CONFLICT,
      {blockId: row.id, content: after.content, label: currentLabel},
    )
  }

  // The name this row HAD, in the two spellings anything writes it: as STORED,
  // and as trimmed. The LABEL is that name wherever the two fields disagree — a
  // legacy or sync-applied row's title may never have been its name — and the
  // title otherwise, which is every row this code writes. Three decisions below
  // turn on it, and keying any of them on the title alone mis-reads a drifted
  // row: what it steps aside for, what it validates against, what it retires.
  const previousStored = previousLabel !== ''
    ? safeDecodeRowProperty(before, blockTypeLabelProp)
    : before.content
  const previousName = previousLabel !== '' ? previousLabel : before.content.trim()

  // Retire what the stored BAG shows, not what the index knows. Every other
  // reactor to a rename diffs the bag — `references.renameBacklinks` reads
  // `getAliases(row.before)` — so releasing a claim only the index can see
  // strands the inbound `[[old name]]` links nothing will rewrite. It doubles
  // as what the merge offer may drop, and matches the empty list `alias.sync`
  // reports for its A3 drift case.
  // The claim that SPELLS the old name. Anything that writes a type name writes
  // the trimmed spelling, and a legacy row can have stored a padded one — in
  // EITHER field that can hold the name, which is why both are candidates here
  // and only where they really are that name. An entry matching none of them is
  // a user's own alias, however similar it looks, and this rename does not get
  // to retire it.
  const oldNameSpellings = [previousStored, before.content, previousName]
    .filter(spelling => spelling !== '' && spelling.trim() === previousName)
  const claims = getAliases(before)
  const retiring = claims.filter(claim => oldNameSpellings.includes(claim))

  // A label written in THIS tx settles the name outright, blank INCLUDED: that
  // is the naming gesture, and a caller clearing it is un-naming the type on
  // purpose. Letting a body written in the same tx outrank it reversed that
  // gesture silently. (Two different non-blank names in one tx never reach
  // here — the conflict above refuses them.)
  //
  // Otherwise the body is the name, and an emptied body names nothing: the type
  // keeps the name it had and the body is restored to it, rather than the type
  // being dropped while its claim stays put. Whitespace counts as empty —
  // aliasSync's blank guard is `=== ''`, so `"   "` would otherwise be claimed
  // as the name.
  const name = labelMoved ? currentLabel : (newContent || previousName)
  if (name === '') {
    // Nothing names this row any more — the un-naming gesture. `tryBuildType`
    // drops a label-less block, so the type is gone and its claim goes with it;
    // left behind, `[[old name]]` resolves to a blank typeless block and holds
    // that name against anyone re-creating a type with it. `writeBlockTypeLabel`
    // does this for the type editor, which was the only caller that ever
    // reached it — an agent or an import clearing both fields did not.
    //
    // Unconditional: a row that never had a name has nothing to retire, and
    // `moveTypeClaim` returns without writing rather than materializing an
    // empty bag. Clearing the LABEL alone does not come through here at all —
    // this path is gated on content changing, and that transition stays the
    // editor's.
    await moveTypeClaim(after, null, ctx, {retiring, skipMetadata: true})
    // And the STORED label, which `readLabel` trimmed to reach this branch:
    // `parseTypeDefinitionMetadata` does not trim, so a whitespace-only label
    // keeps the row published as a type named whitespace — a type this branch
    // just declared gone, with nothing resolving to it. Guarded rather than
    // unconditional: `'' !== undefined`, so writing it onto a row that never
    // had a label would materialize the key.
    if (safeDecodeRowProperty(after, blockTypeLabelProp) !== '') {
      await ctx.tx.setProperty(row.id, blockTypeLabelProp, '', {skipMetadata: true})
    }
    return
  }

  // A content rewrite is a rename only where the content WAS this type's name,
  // and the LABEL is what says so. Where the two disagreed, the row is a legacy
  // or sync-applied one whose title was never its name — prose, or a title
  // embedding a reference — and whatever rewrote that title is doing something
  // else inside its own tx: `references` inlining a deleted target, or
  // retitling a renamed one. This path may neither take the working label nor
  // refuse that tx on its behalf.
  //
  // Unless the LABEL moved in this tx, which is the naming gesture itself: the
  // type editor writes both halves, and that is a rename however drifted the
  // row was. Stepping aside there would leave the new name unclaimed.
  if (!labelMoved && previousName !== before.content.trim()) return

  // The new name has to BE a name whenever somebody chose it: a label written in
  // this tx is a choice, so it is always checked, however broken the row it
  // lands on. The exemption is for DERIVED rewrites, which never move the label
  // — refuse a REGRESSION there, where the name being replaced worked or where
  // the type is being named for the first time (an UNNAMED type is not a broken
  // one), and otherwise let an already-unwritable row have its spellings
  // reconciled, which cannot make an unlinkable name worse.
  if (labelMoved || previousName === '' || isWritableLabel(previousName)) {
    assertWritableTypeName(name)
  }

  // The whole claim moves HERE — old name retired, new one taken — rather than
  // being left to `aliasSyncProcessor`: that plugin is togglable, AND it has
  // already had its only pass-one slot by the time a late writer dirties this
  // row, so on that path nothing else would move the claim at all. A name
  // another block holds is refused for the same reason, and refused BEFORE the
  // writes below. The plugin then finds the bag already reconciled and no-ops;
  // it is not a step this depends on.
  //
  // Only a name that CAN be linked to is claimed: an unwritable one buys
  // nothing by being claimed, and refusing its collision would abort whatever
  // tx is doing the rewriting — the same unrelated rename the check above steps
  // aside for. The old claim is released either way.
  if (isWritableLabel(name)) {
    await assertAliasClaimable(ctx.tx, {
      alias: name,
      blockId: row.id,
      workspaceId: after.workspaceId,
      dropSourceAliases: retiring,
      collisionOrigin: 'content-rename',
    })
    await moveTypeClaim(after, name, ctx, {retiring, skipMetadata: true})
  } else {
    await moveTypeClaim(after, null, ctx, {retiring, skipMetadata: true})
  }

  // `skipMetadata` on every write here: this reconciles a content change
  // somebody else made, and one that was itself derived would otherwise float
  // the type into recents with nobody having touched it.
  // Unconditional: `setProperty` elides a write that changes the stored value
  // nothing, and it compares the STORED encoding. Guarding on the trimmed READ
  // here instead left a legacy row's padded `" Book "` label stored padded once
  // its trimmed form matched — and `parseTypeDefinitionMetadata` does not trim,
  // so the registry published a name nothing resolved to.
  await ctx.tx.setProperty(row.id, blockTypeLabelProp, name, {skipMetadata: true})
  if (after.content !== name) {
    await ctx.tx.update(row.id, {content: name}, {skipMetadata: true})
  }
}

export const BLOCK_TYPE_TYPEIFY_PROCESSOR = defineSameTxProcessor({
  name: BLOCK_TYPE_TYPEIFY_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['content', 'properties']},
  // Issue #402: a plugin write that tags a row `block-type` AFTER this
  // ran (it's first in the pass) still gets completed into a full type
  // this tx. Every step is ensure-present, so re-seeing an
  // already-completed transition no-ops.
  rerunOnDirtyRows: true,
  apply: async (event, ctx) => {
    for (const row of event.changedRows) {
      const after = row.after
      if (!after || after.deleted) continue
      // Tolerant, because this now runs on every CONTENT edit in the
      // workspace: a sync-applied or pre-upgrade row can hold a `types` cell
      // the codec refuses, and a strict read would throw there — costing an
      // ordinary block its edit over a cell that names no type anyway.
      if (!safeDecodeRowProperty(after, typesProp).includes(BLOCK_TYPE_TYPE)) continue

      // Seed-owned type rows are code-authored, complete definitions — the
      // materializer writes the finished bag, so there is nothing to
      // complete, and forcing PAGE_TYPE + alias would both change behavior
      // and trip a BlockDefault scope clash against its Automation-scope tx.
      const seedKey = seededDefinitionKey(after)
      if (seedKey !== undefined && isTypeSeedKey(seedKey)) continue

      // Tolerant on BOTH sides, for the reason the gate above is: `addedTypes`
      // decodes `before` strictly, and a tx writing a well-formed cell over a
      // malformed one would throw there instead of completing the type.
      const hadBlockType = row.before !== null
        && safeDecodeRowProperty(row.before, typesProp).includes(BLOCK_TYPE_TYPE)
      if (!hadBlockType) {
        await completeNewType(row, after, ctx)
        continue
      }
      await followRenamedContent(row, after, ctx)
    }
  },
})

export const BLOCK_TYPE_KERNEL_PROCESSORS: ReadonlyArray<AnySameTxProcessor> = [
  BLOCK_TYPE_TYPEIFY_PROCESSOR,
]
