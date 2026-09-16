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

/** Claim `name` for this type, retiring `retiring` in the SAME write.
 *
 *  One write rather than append-then-retire: the intermediate bag goes through
 *  the maintenance trigger too, so it would re-insert the name being given up,
 *  and renaming AWAY from a name some sync-applied row co-claims would abort on
 *  the name being retired.
 *
 *  Accepted: a claim moved on a RERUN lands after `references.renameBacklinks`,
 *  so the old name's inbound spans are left alone — #991, not this write. */
const claimTypeName = async (
  after: BlockData,
  name: string,
  ctx: SameTxCtx,
  {retiring, ...writeOptions}: {retiring?: string} & TxWriteOpts = {},
): Promise<void> => {
  const claimed = await claimedAliases(ctx.tx, after)
  // In PLACE when a name is being retired: the first entry is what a block is
  // displayed as (the sidebar reads `aliases[0]`), so a rename must not promote
  // some other alias by appending. Same replacement `alias.sync`'s rule 1 would
  // have made — this write just gets there first.
  const renamed = retiring !== undefined && claimed.includes(retiring)
    ? claimed.map(alias => (alias === retiring ? name : alias))
    : [...claimed, name]
  // `setProperty` elides a write that changes nothing, so no guard here.
  await ctx.tx.setProperty(after.id, aliasesProp, [...new Set(renamed)], writeOptions)
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
  if (name !== '') await claimTypeName(after, name, ctx)
}

/** A content write on a block that is already a type is a RENAME — content is
 *  the name — so the label, and the claim on that name, follow it. */
const followRenamedContent = async (
  row: ChangedRow,
  after: BlockData,
  ctx: SameTxCtx,
): Promise<void> => {
  const before = row.before
  if (before === null || before.content === after.content) return

  const currentLabel = readLabel(after)
  // An emptied body names nothing, so the type keeps its name and the body is
  // restored to it — un-naming a type is the type editor's gesture, which
  // releases the alias too. Whitespace counts as empty: aliasSync's blank
  // guard is `=== ''`, so `"   "` would otherwise be claimed as the name.
  // A label written in THIS tx is the naming gesture — the type editor writes
  // both halves — and a label CLEARED in it is the un-naming one, which also
  // releases the claim. Either way the label is the answer and nothing here
  // second-guesses it.
  const labelMoved = readLabel(before) !== currentLabel
  // Otherwise the name to keep, in the order the row can hold one: the new
  // body, the label, or — for a legacy row that never had a label at all — the
  // body being cleared. A type named only by its content is still named, and
  // emptying it would otherwise drop the type while its claim stayed put.
  const name = after.content.trim() || currentLabel || (labelMoved ? '' : before.content.trim())
  if (name === '') return
  // A content rewrite is a rename only where the content WAS this type's name.
  // On a legacy or sync-applied row it may never have been one — a title that
  // is a bare `((id))`, or one embedding a wikilink — and then the name is the
  // LABEL. Something rewriting such a title is not renaming anything: it is
  // `references` inlining a deleted target or retitling a renamed one, inside
  // that gesture's own tx, and this path may neither take the working label nor
  // refuse that tx on its behalf.
  //
  // Unless the LABEL moved in this tx, which is the naming gesture itself: the
  // type editor writes both halves, and that is a rename however drifted the
  // row was. Stepping aside there would leave the new name unclaimed.
  const previousName = before.content.trim()
  if (!labelMoved && previousName !== '' && !isWritableLabel(previousName)
    && isWritableLabel(currentLabel)) return

  // Otherwise the new name has to be a name: refuse a REGRESSION, where the one
  // being replaced worked or where the type is being named for the first time
  // (an UNNAMED type is not a broken one). A row whose name was already
  // unwritable still gets its spellings reconciled — that cannot make an
  // unlinkable name worse.
  if (previousName === '' || isWritableLabel(previousName)) assertWritableTypeName(name)

  // Only a name that CAN be linked to is claimed. An unwritable one buys
  // nothing by being claimed, and refusing its collision would abort whatever
  // tx is doing the rewriting — the same unrelated rename the check above
  // steps aside for.
  if (isWritableLabel(name)) {
    // Retire what the stored BAG shows, not what the index knows. Every other
    // reactor to a rename diffs the bag — `references.renameBacklinks` reads
    // `getAliases(row.before)` — so releasing a claim only the index can see
    // strands the inbound `[[old name]]` links nothing will rewrite. It
    // doubles as what the merge offer may drop, and matches the empty list
    // `alias.sync` reports for its A3 drift case.
    // The claim that SPELLS the old name — as stored, or as trimmed. Those are
    // the only two spellings anything writes: every writer of a type name
    // writes the trimmed one, and a legacy row can carry the padded one in both
    // its content and its bag. An entry matching neither is a user's own alias,
    // however similar it looks, and this rename does not get to retire it.
    const oldNameSpellings = [before.content, before.content.trim()]
    const claims = getAliases(before)
    const retiring = oldNameSpellings.find(spelling => spelling !== '' && claims.includes(spelling))

    // The whole claim moves HERE — old name retired, new one taken — rather
    // than being left to `aliasSyncProcessor`: that plugin is togglable, and a
    // type the registry publishes under a name nothing resolves to is the bug
    // this path exists to close. A name another block holds is refused for the
    // same reason, and refused BEFORE the writes below. The plugin then finds
    // the bag already reconciled and no-ops; it is not a step this depends on.
    await assertAliasClaimable(ctx.tx, {
      alias: name,
      blockId: row.id,
      workspaceId: after.workspaceId,
      dropSourceAliases: retiring === undefined ? [] : [retiring],
      collisionOrigin: 'content-rename',
    })
    await claimTypeName(after, name, ctx, {retiring, skipMetadata: true})
  }

  // `skipMetadata` on every write here: this reconciles a content change
  // somebody else made, and one that was itself derived would otherwise float
  // the type into recents with nobody having touched it.
  if (currentLabel !== name) {
    await ctx.tx.setProperty(row.id, blockTypeLabelProp, name, {skipMetadata: true})
  }
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
