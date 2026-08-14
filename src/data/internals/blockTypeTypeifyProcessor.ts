/**
 * Same-tx processor: when a block gains the `block-type` meta-type via a
 * local `repo.tx` — the `#type` gesture, programmatic tagging, or an
 * import that creates the row through `repo.tx` — complete it into a
 * fully-formed user-defined type in the SAME tx:
 *
 * (Sync-applied writes do NOT run this — they bypass `repo.tx` and the
 * same-tx pass entirely; the invariant still holds for a synced type
 * because the originating device already completed it and the finished
 * `properties` replicate as data. The property-panel picker also never
 * reaches here: it filters `block-type` out of its options.)
 *
 *   - **adopt content as the label** if it has none — an empty
 *     `block-type:label` makes `UserTypesService.tryBuildType` drop the
 *     type, so `book` tagged `block-type` would otherwise register
 *     nothing;
 *   - **tag it PAGE_TYPE** so it doubles as a navigable `[[Label]]` page
 *     (matches the `createTypeBlock` "type flow" pattern);
 *   - **ensure its label is in `alias`** so `[[Label]]` resolves to THIS
 *     block instead of minting a duplicate alias-seat page. Ensure-present
 *     (not only-if-empty): a block that already carries some OTHER alias
 *     still gets its type name claimed, appended to the existing set.
 *
 * Every step is init-if-missing / ensure-present, so it's idempotent and
 * never clobbers a label / PAGE_TYPE / alias set explicitly upstream —
 * `createTypeBlock` writes all three itself and finds this a no-op. A
 * blank block (no content) is left unnamed; it's named later via the type
 * editor, which seeds the alias then (`writeBlockTypeLabel`).
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
  defineSameTxProcessor,
  type AnySameTxProcessor,
} from '@/data/api'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import {
  addBlockTypeToProperties,
  addedTypes,
  aliasesProp,
  blockTypeLabelProp,
  getAliases,
  getBlockTypes,
  hasOpaqueContent,
} from '@/data/properties'
import {
  assertNotGrammarShapedLabel,
  assertRoundTrippableReferenceLabel,
  GrammarShapedLabelError,
  OpaqueContentLabelError,
  parseExactReferenceBlockContent,
} from '@/data/referenceBlock'
import { seededDefinitionKey } from '@/data/definitionSeeds'
import { isTypeSeedKey } from '@/data/typeSeeds'

export const BLOCK_TYPE_TYPEIFY_PROCESSOR_NAME = 'core.blockTypeTypeify'

export const BLOCK_TYPE_TYPEIFY_PROCESSOR = defineSameTxProcessor({
  name: BLOCK_TYPE_TYPEIFY_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
  // Issue #402: a plugin write that tags a row `block-type` AFTER this
  // ran (it's first in the pass) still gets completed into a full type
  // this tx. Every step is ensure-present, so re-seeing an
  // already-completed transition no-ops.
  rerunOnDirtyRows: true,
  apply: async (event, ctx) => {
    for (const row of event.changedRows) {
      // Fire only on the transition INTO block-type — not on every later
      // edit to an existing type block.
      if (!addedTypes(row).includes(BLOCK_TYPE_TYPE)) continue
      const after = row.after
      if (!after || after.deleted) continue

      // Seed-owned type rows (`materializeTypeSeeds` mints a `block-type` block at
      // its deterministic `/type/` id) are code-authored, complete definitions —
      // do NOT typeify them into navigable `[[Label]]` pages + aliases. That's the
      // user-type gesture; code types were never pages, so forcing PAGE_TYPE +
      // alias here would be a visible behavior change at the C4 cutover (and the
      // materializer's Automation-scope tx would trip a BlockDefault scope clash).
      // The materializer writes the finished bag; there is nothing to complete.
      const seedKey = seededDefinitionKey(after)
      if (seedKey !== undefined && isTypeSeedKey(seedKey)) continue

      const rawLabel = after.properties[blockTypeLabelProp.name]
      const currentLabel = (typeof rawLabel === 'string' ? rawLabel : '').trim()
      const name = currentLabel || after.content.trim()

      // This adopts existing content as the type's name and claims it as
      // an alias, on ANY path that adds `block-type` — so the check has to
      // be here and not only in `createTypeBlock` (which pre-checks, making
      // these a no-op for it); the agent bridge's raw properties bag is the
      // path that gets here unvalidated.
      //
      // THROWS rather than skipping the claim: a type whose name can't be
      // written as `[[name]]` is unlinkable, and minting one silently is
      // the failure mode this whole family of bugs is made of. Same-tx, so
      // it rolls the tagging back atomically; both refusals derive from
      // `UnwritableLabelError`, which the type-label UI catches to revert.
      if (name !== '') {
        assertNotGrammarShapedLabel(name, 'Block type label')
        assertRoundTrippableReferenceLabel(name, 'Block type label')
      }

      // An explicit label short-circuits `name`, so the content is neither
      // adopted nor rewritten below — and the checks above never saw it.
      // Only the MARKED field form is refused: §9 recognition needs the `::`
      // bit, so that is the shape that makes `core.deriveReferenceTarget`
      // stamp `is_field_form` and the finished type project as property
      // machinery instead of appearing in the outline. An UNMARKED `[[Foo]]`
      // or `((id))` stamps only `reference_target_id`, which is not
      // machinery — refusing it would roll back a perfectly good type whose
      // note happens to be a reference.
      if (currentLabel !== '' && parseExactReferenceBlockContent(after.content)?.fieldForm) {
        throw new GrammarShapedLabelError(after.content.trim(), 'Block type content')
      }

      // PAGE_TYPE via the blessed raw membership helper (a full
      // `properties` write) goes FIRST; the label / alias amendments
      // below are partial `setProperty` writes that layer on top without
      // clobbering it. All three touch independent fields.
      if (!getBlockTypes(after).includes(PAGE_TYPE)) {
        await ctx.tx.update(row.id, {properties: addBlockTypeToProperties(after.properties, PAGE_TYPE)})
      }
      if (currentLabel === '' && name !== '') {
        // Adopting the content means BOTH claiming it as a name and trimming
        // the stored bytes to it. For an opaque payload each is wrong on its
        // own, so refuse and make the caller supply a label.
        if (hasOpaqueContent(after, ctx.opaqueContentTypes)) {
          throw new OpaqueContentLabelError('Block type label')
        }
        await ctx.tx.setProperty(row.id, blockTypeLabelProp, name)
        // Trim the block's own content to the clean name too. `name` was
        // adopted FROM `content` (`content.trim()`), so this only strips
        // surrounding whitespace — it never clobbers meaningful text. It
        // keeps content == label == alias, which matters on a LATER
        // rename: `aliasSyncProcessor` replaces aliases by matching the
        // OLD content, so a `content` of "  Book" against an alias of
        // "Book" would leave the stale alias claimed (and `[[Book]]`
        // resolving to the renamed type) instead of being replaced.
        if (after.content !== name) {
          await ctx.tx.update(row.id, {content: name})
        }
      }
      if (name !== '') {
        const aliases = getAliases(after)
        if (!aliases.includes(name)) {
          await ctx.tx.setProperty(row.id, aliasesProp, [...aliases, name])
        }
      }
    }
  },
})

export const BLOCK_TYPE_KERNEL_PROCESSORS: ReadonlyArray<AnySameTxProcessor> = [
  BLOCK_TYPE_TYPEIFY_PROCESSOR,
]
