/**
 * Same-tx processor: canonicalize `blocks.references_json` on every write,
 * so the on-disk shape is independent of writer-side iteration order and
 * equality reduces to a JSON text compare — the `json_each` backlinks
 * index, BACKLINKS_FOR_BLOCK_QUERY and Map-keyed invalidation all treat
 * references as a set. Pluggable, so other plugins can compose
 * value-level normalizers onto the same pipeline stage. See
 * `blockData.ts:normalizeReferences` for the canonical-form rules.
 */

import {
  defineSameTxProcessor,
  normalizeReferences,
  type AnySameTxProcessor,
} from '@/data/api'
import { BLOCK_TYPE_KERNEL_PROCESSORS } from './blockTypeTypeifyProcessor'
import { DERIVE_REFERENCE_TARGET_PROCESSOR } from './referenceTargetProcessor'
import {
  MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR,
  PROJECT_PROPERTY_CHILDREN_PROCESSOR,
} from './propertyChildrenProcessor'
import { MIGRATE_PROPERTY_RENAME_PROCESSOR } from './propertyRenameProcessor'

const referencesEqual = (
  a: ReturnType<typeof normalizeReferences>,
  b: ReturnType<typeof normalizeReferences>,
): boolean => {
  if (a.length !== b.length) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

export const NORMALIZE_REFERENCES_PROCESSOR_NAME = 'core.normalizeReferences'

export const NORMALIZE_REFERENCES_PROCESSOR = defineSameTxProcessor({
  name: NORMALIZE_REFERENCES_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['references']},
  // Issue #402: a plugin writing `references` after this ran commits
  // canonical anyway (merge retarget calls normalizeReferences itself
  // today, but the commit invariant shouldn't hinge on that per-caller
  // discipline).
  rerunOnDirtyRows: true,
  apply: async (event, ctx) => {
    for (const row of event.changedRows) {
      if (!row.after) continue  // hard-delete; nothing to normalize
      const canonical = normalizeReferences(row.after.references)
      // Already canonical? Skip — saves a no-op write + UPDATE.
      if (referencesEqual(canonical, row.after.references)) continue
      // `skipMetadata: true` keeps `userUpdatedAt` / `updatedBy` untouched —
      // canonicalizing is derived bookkeeping, not a user edit, so it must not
      // float the row to the top of "recent" or change its "edited by". But
      // `updatedAt` STILL advances (skipMetadata does not suppress it —
      // metadataPatch always returns it): `references_json` is a SYNCED
      // column, so a change to it must carry a new row version like any other
      // synced edit, or a peer's LWW gate would drop the canonical value. Same
      // convention as parseReferences' projection write next door.
      await ctx.tx.update(row.id, {references: canonical}, {skipMetadata: true})
    }
  },
})

// Single pass, registration order — plus the bounded derivation re-run
// (issue #402): every processor here except the rename migrator opts into
// `rerunOnDirtyRows`, so a row a LATER writer (plugin stage, or a kernel
// stamp behind a stale-column read) dirtied after a derivation ran gets
// re-derived once at the end of the pass. Ordering below still governs
// both passes. Block-type typeify runs FIRST: its bag
// amendments (page type, label, aliases) are raw/setProperty cell writes,
// and in a child-backed workspace those must still be ahead of materialize
// or the value children go stale until an unrelated edit (PR #386 review).
// The residual trade: a transition-into-block-type written by PROJECT
// itself (hand-editing a hidden `types` VALUE row) no longer re-fires
// typeify this tx — machinery-row surgery, self-heals on the next bag
// write. Then the §5 trio: materialize (cell→children) before derive so a
// raw cell write's fresh field/value rows get their column stamped in the
// same tx; project (children→cell) after both so a tree-side edit
// reprojects from settled children. Each write is idempotent, so a
// dual-write round-trip through the trio no-ops. Typeify still precedes
// the alias plugin's content<->alias sync (kernel before plugins), so a
// freshly-tagged block-type block claims its label alias before any
// reconciliation.
export const KERNEL_SAME_TX_PROCESSORS: ReadonlyArray<AnySameTxProcessor> = [
  ...BLOCK_TYPE_KERNEL_PROCESSORS,
  MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR,
  DERIVE_REFERENCE_TARGET_PROCESSOR,
  PROJECT_PROPERTY_CHILDREN_PROCESSOR,
  NORMALIZE_REFERENCES_PROCESSOR,
  // Runs LAST: it re-keys consuming-parent cells for a definition rename, and
  // the stale in-tx registry would make MATERIALIZE read the dropped old name
  // as a user delete and tombstone the field rows if it ran afterward. See
  // propertyRenameProcessor.ts header.
  MIGRATE_PROPERTY_RENAME_PROCESSOR,
]
