/**
 * `core.deriveReferenceTarget` — same-tx derivation of the LOCAL
 * `reference_target_id` column (properties-as-blocks migration, slice A;
 * PR #288 §5/§7).
 *
 * Watches `content`. When a row's whole content trims to exactly one
 * reference token (`((uuid))` or `[[alias]]`), resolves it — a `((uuid))`
 * block-ref textually (no lookup), an `[[alias]]` through the tx-aware generic
 * alias lookup — and writes the target id into `reference_target_id` in the
 * same transaction via `tx.stampReferenceTarget` (a LOCAL-column write: no
 * `updated_at` bump, no upload PATCH — the column is a per-device reflection
 * of content, never synced). Detection everywhere downstream is a column read,
 * never a content parse.
 *
 * Property field rows currently address their definition BY ID (`((fieldId))`,
 * §7), resolving on the textual `blockRef` branch — no property-name tier, no
 * deferred resolution. `[[alias]]` resolution is the ONE normal alias policy,
 * never special-cased for properties: it resolves to whatever claims the alias
 * — today a page; a definition too, once auto-claim (a later change) makes
 * definitions name-resolvable. Recognition keys off the resolved TARGET, not
 * the bracket form, so a whole-block `[[name]]` becomes a field row then with
 * no change here.
 *
 * The column is local-only and derived per device: sync arrival re-derives
 * it in the materializer seam (`deriveReferenceTargetForArrival`), and undo
 * replay restores it from snapshots (same-tx processors are skipped on
 * replay).
 */

import {
  defineSameTxProcessor,
  type Tx,
} from '@/data/api'
import { parseExactReferenceBlockContent } from '@/data/referenceBlock'

export const DERIVE_REFERENCE_TARGET_PROCESSOR_NAME = 'core.deriveReferenceTarget'

/** Resolution seam shared by the same-tx processor and the sync materializer's
 *  derive-at-arrival: both must resolve identically or the column diverges
 *  across write paths (§5's determinism requirement). Purely `[[alias]]` →
 *  target id; `((id))` block-refs resolve textually with no lookup, so nothing
 *  property-specific lives here anymore. */
export interface ReferenceTargetLookups {
  /** Generic alias lookup (`block_aliases` index): target block id, or null
   *  when nothing claims the alias. */
  aliasTargetId(alias: string, workspaceId: string): Promise<string | null>
}

/** Derive the target for `content`, or:
 *  - `null` — content is not an exact reference (the column must clear);
 *  - `undefined` — content IS an exact `[[alias]]` reference but nothing
 *    resolves it (callers decide: keep a caller-provided id on create, else
 *    clear). A `((id))` block-ref resolves textually — no lookup, so property
 *    field rows (id-addressed, §7) never touch the alias path. */
export const deriveReferenceTargetId = async (
  content: string,
  workspaceId: string,
  lookups: ReferenceTargetLookups,
): Promise<string | null | undefined> => {
  const exact = parseExactReferenceBlockContent(content)
  if (!exact) return null
  if (exact.kind === 'blockRef') return exact.id

  const aliasTarget = await lookups.aliasTargetId(exact.alias, workspaceId)
  return aliasTarget ?? undefined
}

/** Build the `ReferenceTargetLookups` for a same-tx processor: generic alias
 *  resolution from `tx.aliasLookup`. Shared by the derive processor itself and
 *  by plugin same-tx processors that rewrite `content` AFTER derivation already
 *  ran (merge retarget, deleted-block inlining) and so must recompute the
 *  column inline rather than leave it describing pre-rewrite content. */
export const sameTxReferenceTargetLookups = (
  tx: Tx,
): ReferenceTargetLookups => ({
  aliasTargetId: async (alias, workspaceId) =>
    (await tx.aliasLookup(alias, workspaceId))?.id ?? null,
})

export const DERIVE_REFERENCE_TARGET_PROCESSOR = defineSameTxProcessor({
  name: DERIVE_REFERENCE_TARGET_PROCESSOR_NAME,
  watches: {kind: 'field', table: 'blocks', fields: ['content']},
  // Issue #402: a plugin content rewrite after this ran (merge retarget,
  // deleted-ref inlining, alias reverse-sync) re-derives here instead of
  // committing a stale column. The plugins' inline recomputes stay — they
  // keep the column honest for processors BETWEEN them and this re-run.
  rerunOnDirtyRows: true,
  apply: async (event, ctx) => {
    const lookups = sameTxReferenceTargetLookups(ctx.tx)
    for (const changed of event.changedRows) {
      const row = changed.after
      // Tombstoned rows derive too (matches the arrival path): a content
      // edit while deleted would otherwise leave a stale column that a
      // later content-unchanged restore never repairs.
      if (row === null) continue
      const derivedTargetId = await deriveReferenceTargetId(
        row.content,
        row.workspaceId,
        lookups,
      )
      // Unresolvable-alias CREATE keeps a caller-provided id (a create that
      // seeds `reference_target_id` alongside an as-yet-unresolvable
      // `[[alias]]`); everywhere else unresolvable clears — content is the
      // source, the column never outlives it.
      const targetId = derivedTargetId === undefined && changed.before === null
        ? row.referenceTargetId ?? null
        : derivedTargetId ?? null
      // `reference_target_id` is a LOCAL derived column — writing it is not a
      // synced edit, so use the dedicated stamp primitive (no `updated_at`
      // bump, no upload PATCH) rather than a `{skipMetadata}` update, which
      // would still bump `updated_at` and ship a redundant envelope. The
      // primitive no-ops when the column is already `targetId`.
      await ctx.tx.stampReferenceTarget(row.id, targetId)
    }
  },
})
