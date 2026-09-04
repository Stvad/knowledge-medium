/**
 * `core.aliasClaimRederive` — kernel post-commit hook on "a block's
 * alias list gained entries" (issue #402).
 *
 * A `[[Foo]]` row written before anything claimed "Foo" stamps NULL and
 * nothing content-driven revisits it — the CLAIM is the trigger. Observed
 * at this seam rather than scheduled per-caller, because every
 * alias-adding path would otherwise have to remember.
 *
 * Effective-claim diff: a tombstoned block claims nothing (the alias
 * index excludes deleted rows), so a restore counts every alias as
 * gained and a soft-delete never schedules. Losses schedule nothing —
 * un-claiming can't make a NULL-stamped row resolvable, and re-pointing
 * ALREADY-stamped rows (the handoff/reclaim half) stays deliberately
 * out until auto-claim makes definitions name-resolvable (see
 * `drainNameRederives`' docblock).
 *
 * Sync arrivals don't run post-commit processors; they are covered by
 * the materializer's `onAliasTargetsAdded` seam (`repo.ts`), which calls
 * the same schedule.
 */

import {
  definePostCommitProcessor,
  type BlockData,
} from '@/data/api'
import { getAliases } from '@/data/properties'

export const ALIAS_CLAIM_REDERIVE_PROCESSOR_NAME = 'core.aliasClaimRederive'

/** Aliases this row-state actually claims in the alias index: none while
 *  tombstoned or absent. */
const effectiveAliases = (row: BlockData | null): readonly string[] =>
  row === null || row.deleted ? [] : getAliases(row)

export const ALIAS_CLAIM_REDERIVE_PROCESSOR = definePostCommitProcessor({
  name: ALIAS_CLAIM_REDERIVE_PROCESSOR_NAME,
  // `deleted` is watched so a restore (deleted -> live) schedules for the
  // block's whole alias list even when `properties` didn't change.
  watches: {kind: 'field', table: 'blocks', fields: ['properties', 'deleted']},
  apply: async (event, ctx) => {
    const gained = new Set<string>()
    for (const row of event.changedRows) {
      const before = effectiveAliases(row.before)
      const after = effectiveAliases(row.after)
      if (after.length === 0) continue
      const beforeSet = new Set(before)
      for (const alias of after) {
        if (!beforeSet.has(alias)) gained.add(alias)
      }
    }
    if (gained.size === 0) return
    ctx.repo.scheduleReferenceTargetNameRederive(event.workspaceId, [...gained])
  },
})
