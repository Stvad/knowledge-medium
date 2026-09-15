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
 * rewritten (the agent bridge, an import updating an existing row): the
 * label follows the new name. Completion is a one-shot, so without this
 * the label kept the old name while `aliasSyncProcessor` moved the alias
 * to the new content — leaving the type registered under a name nothing
 * resolved to (#926).
 *
 * (Sync-applied writes do NOT run this — they bypass `repo.tx` and the
 * same-tx pass entirely; the invariant still holds for a synced type
 * because the originating device already ran both jobs and the finished
 * row replicates as data. The property-panel picker also never reaches
 * completion: it filters `block-type` out of its options.)
 *
 * A label colliding with a live alias in the workspace is rejected by the
 * `block_aliases_workspace_alias_unique` storage trigger
 * (`alias.collision`), rolling back the whole tx.
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
} from '@/data/api'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import {
  addBlockTypeToProperties,
  addedTypes,
  aliasesProp,
  blockTypeLabelProp,
  getAliases,
  getBlockTypes,
} from '@/data/properties'
import {
  assertNotGrammarShapedLabel,
  assertRoundTrippableReferenceLabel,
} from '@/data/referenceBlock'
import { seededDefinitionKey } from '@/data/definitionSeeds'
import { isTypeSeedKey } from '@/data/typeSeeds'

export const BLOCK_TYPE_TYPEIFY_PROCESSOR_NAME = 'core.blockTypeTypeify'

/** Needs no `rejectionToastFacet` contribution — the generic route falls
 *  back to the raw message, which says what to fix. */
export const BLOCK_TYPE_NAME_CONFLICT = 'blockType.nameConflict'

const readLabel = (row: BlockData): string => {
  const raw = row.properties[blockTypeLabelProp.name]
  return (typeof raw === 'string' ? raw : '').trim()
}

/** THROWS rather than skipping the name: a type whose name can't be
 *  written as `[[name]]` is unlinkable, and minting one silently is the
 *  failure mode this whole family of bugs is made of. Same-tx, so it rolls
 *  the tagging (or the rename) back atomically; both refusals derive from
 *  `UnwritableLabelError`, which the type-label UI catches to revert.
 *
 *  Needed on every path that names a type, not only in `createTypeBlock`
 *  (which pre-checks, making this a no-op for it) — the agent bridge's raw
 *  properties bag arrives here unvalidated. */
const assertWritableTypeName = (name: string): void => {
  assertNotGrammarShapedLabel(name, 'Block type label')
  assertRoundTrippableReferenceLabel(name, 'Block type label')
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
  if (name !== '') {
    const aliases = getAliases(after)
    if (!aliases.includes(name)) {
      await ctx.tx.setProperty(row.id, aliasesProp, [...aliases, name])
    }
  }
}

/** A content write on a block that is already a type is a RENAME — content
 *  is the name — so the label follows it.
 *
 *  `aliasSyncProcessor` owns the alias move (and the collision preflight
 *  that lets a rejected rename offer a merge), so the only alias work left
 *  here is the case it declines: a type with none to move. */
const followRenamedContent = async (
  row: ChangedRow,
  after: BlockData,
  ctx: SameTxCtx,
): Promise<void> => {
  if (row.before === null || row.before.content === after.content) return

  const currentLabel = readLabel(after)
  // An emptied body names nothing, so the type keeps the name it has and the
  // body is restored to it: un-naming a type is the type editor's own
  // gesture, which also releases the alias. Whitespace is emptiness here —
  // aliasSync's blank guard is `=== ''`, so it would otherwise claim `"   "`
  // as this type's name and `[[Name]]` would resolve to nothing.
  const name = after.content.trim() || currentLabel
  if (name === '') return
  assertWritableTypeName(name)

  if (currentLabel !== name) {
    await ctx.tx.setProperty(row.id, blockTypeLabelProp, name)
  }
  if (after.content !== name) {
    await ctx.tx.update(row.id, {content: name})
  }
  if (getAliases(after).length === 0) {
    await ctx.tx.setProperty(row.id, aliasesProp, [name])
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
      if (!getBlockTypes(after).includes(BLOCK_TYPE_TYPE)) continue

      // Seed-owned type rows are code-authored, complete definitions — the
      // materializer writes the finished bag, so there is nothing to
      // complete, and forcing PAGE_TYPE + alias would both change behavior
      // and trip a BlockDefault scope clash against its Automation-scope tx.
      const seedKey = seededDefinitionKey(after)
      if (seedKey !== undefined && isTypeSeedKey(seedKey)) continue

      if (addedTypes(row).includes(BLOCK_TYPE_TYPE)) {
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
