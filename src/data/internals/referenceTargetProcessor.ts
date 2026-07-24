/**
 * `core.deriveReferenceTarget` — same-tx derivation of the LOCAL
 * `reference_target_id` column (properties-as-blocks migration, slice A;
 * PR #288 §5/§7).
 *
 * Watches `content`. When a row's whole content trims to exactly one
 * reference span — `((id))`, `[[alias]]`, or `[label](((uuid)))`, each
 * optionally preceded by the `::` field marker (§7 grammar box) — resolves
 * it: the id-carrying forms textually (no lookup), `[[alias]]` through the
 * tx-aware generic alias lookup — and writes BOTH local derived columns in
 * the same transaction via `tx.stampReferenceTarget`: `reference_target_id`
 * (the resolved target) and `is_field_form` (pure syntax — the marker
 * matched, resolution-independent). LOCAL-column writes: no `updated_at`
 * bump, no upload PATCH — per-device reflections of content, never synced.
 * Detection everywhere downstream is a column read, never a content parse.
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

/** Both LOCAL derived columns for `content`, computed in one textual pass
 *  (§7 grammar box):
 *  - `targetId`: `null` — content is not a whole-block reference (the column
 *    must clear); `undefined` — content IS a `[[alias]]` span but nothing
 *    resolves it (callers decide: keep a caller-provided id on create, else
 *    clear). The id-carrying spans — `((id))` AND `[label](((id)))` — resolve
 *    textually with no lookup, so canonical property field rows (§7) never
 *    touch the alias path.
 *  - `isFieldForm`: pure syntax — the `::` marker matched with any span form,
 *    stamped whether or not the span resolves (§9 condition 1; only the
 *    target column late-binds). */
export interface DerivedReferenceColumns {
  targetId: string | null | undefined
  isFieldForm: boolean
}

export const deriveReferenceColumns = async (
  content: string,
  workspaceId: string,
  lookups: ReferenceTargetLookups,
): Promise<DerivedReferenceColumns> => {
  const exact = parseExactReferenceBlockContent(content)
  if (!exact) return {targetId: null, isFieldForm: false}
  if (exact.kind === 'blockRef' || exact.kind === 'aliasedBlockRef') {
    return {targetId: exact.id, isFieldForm: exact.fieldForm}
  }

  const aliasTarget = await lookups.aliasTargetId(exact.alias, workspaceId)
  return {targetId: aliasTarget ?? undefined, isFieldForm: exact.fieldForm}
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
      const derived = await deriveReferenceColumns(
        row.content,
        row.workspaceId,
        lookups,
      )
      // Unresolvable-alias CREATE keeps a caller-provided id (a create that
      // seeds `reference_target_id` alongside an as-yet-unresolvable
      // `[[alias]]`); everywhere else unresolvable clears — content is the
      // source, the column never outlives it. The bit has no such case: it
      // is pure syntax, always exactly what the content says.
      const targetId = derived.targetId === undefined && changed.before === null
        ? row.referenceTargetId ?? null
        : derived.targetId ?? null
      // Both are LOCAL derived columns — writing them is not a synced edit,
      // so use the dedicated stamp primitive (no `updated_at` bump, no
      // upload PATCH) rather than a `{skipMetadata}` update, which would
      // still bump `updated_at` and ship a redundant envelope. The
      // primitive no-ops when both columns already match.
      await ctx.tx.stampReferenceTarget(row.id, targetId, derived.isFieldForm)
    }
  },
})
