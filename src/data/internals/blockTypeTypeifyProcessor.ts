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
} from '@/data/properties'

export const BLOCK_TYPE_TYPEIFY_PROCESSOR_NAME = 'core.blockTypeTypeify'

export const BLOCK_TYPE_TYPEIFY_PROCESSOR = defineSameTxProcessor({
  name: BLOCK_TYPE_TYPEIFY_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['properties']},
  apply: async (event, ctx) => {
    for (const row of event.changedRows) {
      // Fire only on the transition INTO block-type — not on every later
      // edit to an existing type block.
      if (!addedTypes(row).includes(BLOCK_TYPE_TYPE)) continue
      const after = row.after
      if (!after || after.deleted) continue

      const rawLabel = after.properties[blockTypeLabelProp.name]
      const currentLabel = (typeof rawLabel === 'string' ? rawLabel : '').trim()
      const name = currentLabel || after.content.trim()

      // PAGE_TYPE via the blessed raw membership helper (a full
      // `properties` write) goes FIRST; the label / alias amendments
      // below are partial `setProperty` writes that layer on top without
      // clobbering it. All three touch independent fields.
      if (!getBlockTypes(after).includes(PAGE_TYPE)) {
        await ctx.tx.update(row.id, {properties: addBlockTypeToProperties(after.properties, PAGE_TYPE)})
      }
      if (currentLabel === '' && name !== '') {
        await ctx.tx.setProperty(row.id, blockTypeLabelProp, name)
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
