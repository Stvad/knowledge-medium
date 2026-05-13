/**
 * Same-tx processor: canonicalize `blocks.references_json` on every
 * write. Replaces the inline `normalizeReferences(...)` calls that
 * previously lived in `txEngine.ts` (`update`, `restore`,
 * `insertBlockData`). Equivalent end-state — the row commits with
 * normalized references — but pluggable, so other plugins can
 * compose value-level normalizers onto the same pipeline stage
 * without modifying the engine.
 *
 * Why the canonical form matters (excerpted from
 * `blockData.ts:normalizeReferences` doc): on-disk shape is
 * independent of writer-side iteration order, so equality reduces
 * to JSON text compare; consumers (`json_each` backlinks index,
 * BACKLINKS_FOR_BLOCK_QUERY, Map-keyed invalidation) treat
 * references as a set.
 *
 * Same-tx placement notes (per docs/alias-rename-cases.html):
 *   - Cheap (pure compute, no I/O), correctness-critical (commit
 *     invariant), single-row (each tx may write several blocks but
 *     each row's normalization is independent).
 *   - Latency added is paid by the user-commit path; matches the
 *     pre-existing inline cost.
 */

import {
  defineSameTxProcessor,
  normalizeReferences,
  type AnySameTxProcessor,
} from '@/data/api'

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
  apply: async (event, ctx) => {
    for (const row of event.changedRows) {
      if (!row.after) continue  // hard-delete; nothing to normalize
      const canonical = normalizeReferences(row.after.references)
      // Already canonical? Skip — saves a no-op write + UPDATE.
      if (referencesEqual(canonical, row.after.references)) continue
      // `skipMetadata: true` so the normalization doesn't bump
      // `updatedAt` / `updatedBy` — it's a bookkeeping write, not
      // a user intent. Same convention used by parseReferences when
      // it updates the projected references column.
      await ctx.tx.update(row.id, {references: canonical}, {skipMetadata: true})
    }
  },
})

export const KERNEL_SAME_TX_PROCESSORS: ReadonlyArray<AnySameTxProcessor> = [
  NORMALIZE_REFERENCES_PROCESSOR,
]
