/**
 * Alias sync — same-tx processor (spec: docs/alias-rename-cases.html).
 *
 * Reconciles `content` ↔ `aliases` on the same block when one side
 * changes. Collision detection (refusing a tx that would claim a
 * taken alias) is enforced at the storage layer by the
 * `block_aliases_workspace_alias_unique` trigger; the tx engine
 * translates the trigger's RAISE into a `ProcessorRejection` with
 * `code: 'alias.collision'`. Content-rename sync preflights the same
 * lookup before its alias amendment so the rejection can also carry
 * which source alias the merge action should drop.
 *
 * Decision ladder:
 *   1. Content changed, old value ∈ aliases (A1, A2) → replace that
 *      entry with new content. Dedupe.
 *   2. Content changed, old value ∉ aliases (A3 — drift heal) → add
 *      new content as a fresh alias.
 *   3. Alias diff is a 1-for-1 swap AND content === removed alias
 *      (AR1) → rewrite content to the added alias.
 *   4. Otherwise → no sync write.
 *
 * Placement (same-tx vs post-commit):
 *   Sync runs inside the user's writeTransaction so content + alias
 *   writes commit atomically. Rename remains post-commit (see
 *   `@/plugins/references/renameProcessor.ts`) — the cross-block
 *   rewrites are too expensive to inline on the typing path, and
 *   eventual consistency is fine for backlink display text.
 *
 *   The "stale plan" guard that the post-commit version needed
 *   (re-read row at apply time, skip on divergence) is gone here —
 *   we're inside the same tx, so the snapshot we plan against IS
 *   the live state.
 */

import {
  ProcessorRejection,
  defineSameTxProcessor,
  type AnySameTxProcessor,
  type BlockData,
  type ChangedRow,
  type SameTxCtx,
  type SameTxEvent,
} from '@/data/api'
import {
  deriveReferenceColumns,
  sameTxReferenceTargetLookups,
} from '@/data/internals/referenceTargetProcessor'
import { aliasesProp, getAliases } from '@/data/properties'

export const ALIAS_SYNC_PROCESSOR = 'alias.sync'

/** What the write phase should do for one row. `null` on either side
 *  means no-op for that direction. */
interface SyncPlan {
  id: string
  workspaceId: string
  contentNext: string | null
  aliasesNext: readonly string[] | null
  dropSourceAliasesOnCollision: readonly string[]
  /** The row's derived `reference_target_id` as the tx already has it, so a
   *  content rewrite can recompute the column without re-reading the row. */
  referenceTargetIdBefore: string | null
}


const arraysEqual = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const dedupe = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of values) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** Build the plan for one row. Returns null when nothing should be
 *  written — the row was created/deleted in this commit, no rule
 *  applies, the rule's output is identical to current state, or the
 *  rule would propagate a blank value. Storage triggers remain the
 *  final uniqueness invariant; content-rename plans also carry intent
 *  metadata so a rejected merge can drop only the replaced alias. */
export const planSync = (row: ChangedRow): SyncPlan | null => {
  if (row.before === null || row.after === null) return null
  if (row.after.deleted) return null

  const before = row.before
  const after = row.after
  const beforeAliases = getAliases(before)
  const afterAliases = getAliases(after)
  // Sync only reconciles blocks that ARE aliased.
  if (afterAliases.length === 0) return null
  const contentChanged = before.content !== after.content

  if (contentChanged) {
    // Blank-content guard for content→alias direction: never write a
    // `""` alias entry.
    if (after.content === '') return null

    if (afterAliases.includes(before.content)) {
      // Rule 1 (A1, A2): replace old content's alias entry with new
      // content; dedupe.
      const replaced = dedupe(
        afterAliases.map(a => (a === before.content ? after.content : a)),
      )
      if (arraysEqual(replaced, afterAliases)) return null
      return {
        id: row.id,
        workspaceId: after.workspaceId,
        contentNext: null,
        aliasesNext: replaced,
        referenceTargetIdBefore: after.referenceTargetId ?? null,
        dropSourceAliasesOnCollision: before.content === '' ? [] : [before.content],
      }
    }
    // Rule 2 (A3): old content wasn't an alias anchor — heal
    // additively by appending new content.
    if (afterAliases.includes(after.content)) return null
    return {
      id: row.id,
      workspaceId: after.workspaceId,
      contentNext: null,
      aliasesNext: [...afterAliases, after.content],
      referenceTargetIdBefore: after.referenceTargetId ?? null,
      dropSourceAliasesOnCollision: [],
    }
  }

  // Reverse sync (AR1): content didn't change in this commit. Look
  // for an alias 1-for-1 swap whose removed entry matches current
  // content.
  const removed = beforeAliases.filter(a => !afterAliases.includes(a))
  const added = afterAliases.filter(a => !beforeAliases.includes(a))
  if (removed.length === 1 && added.length === 1 && after.content === removed[0]) {
    // Blank-rename guard: don't propagate empty into content.
    if (added[0] === '') return null
    if (after.content === added[0]) return null
    return {
      id: row.id,
      workspaceId: after.workspaceId,
      contentNext: added[0],
      aliasesNext: null,
      referenceTargetIdBefore: after.referenceTargetId ?? null,
      dropSourceAliasesOnCollision: [],
    }
  }

  return null
}

const assertNoAliasCollision = async (
  ctx: SameTxCtx,
  plan: SyncPlan,
): Promise<void> => {
  if (plan.aliasesNext === null) return
  for (const alias of plan.aliasesNext) {
    const claimant = await ctx.tx.aliasLookup(alias, plan.workspaceId)
    if (claimant === null || claimant.id === plan.id) continue
    throw new ProcessorRejection(
      `Alias "${alias}" is already used by another block`,
      'alias.collision',
      {
        alias,
        conflictingBlockId: claimant.id,
        conflictingBlockTitle: claimant.content.slice(0, 80),
        workspaceId: plan.workspaceId,
        attemptedOn: plan.id,
        dropSourceAliases: [...plan.dropSourceAliasesOnCollision],
        collisionOrigin: 'content-rename',
      },
    )
  }
}

/** Apply one plan: issue the amendment writes. The preflight above is
 *  for user-facing merge intent only; the storage-layer trigger still
 *  handles any write path that reaches the alias index. */
const applyPlan = async (ctx: SameTxCtx, plan: SyncPlan): Promise<void> => {
  if (plan.aliasesNext !== null) {
    await assertNoAliasCollision(ctx, plan)
    await ctx.tx.setProperty(plan.id, aliasesProp, [...plan.aliasesNext], {skipMetadata: true})
  }
  if (plan.contentNext !== null) {
    // AR1 rewrites content AFTER `core.deriveReferenceTarget` ran (kernel
    // same-tx processors precede plugin ones), and AR1's own precondition is
    // that content did NOT change in this tx — so derive never fired for this
    // row at all and nothing will re-derive the column. Recompute it inline
    // from the rewritten content, the same contract `mergeRetargetProcessor`
    // and `inlineDeletedBlockRefsProcessor` follow.
    //
    // Reachable when the swapped alias is itself spelled as a reference
    // (`[[Foo]]` as an alias STRING): the row's stamp would keep pointing at
    // the removed alias's target while its content names the added one — and
    // in a child-backed workspace a stamp resolving to a property definition
    // is what makes a row a field row, so the row would stay hidden and
    // projected under the wrong definition.
    const patch: Partial<Pick<BlockData, 'content' | 'referenceTargetId' | 'isFieldForm'>> = {
      content: plan.contentNext,
    }
    const derived = await deriveReferenceColumns(
      plan.contentNext,
      plan.workspaceId,
      sameTxReferenceTargetLookups(ctx.tx),
    )
    // Always an update of an existing row (never a create), so an
    // unresolvable alias (`undefined`) clears rather than preserving an id.
    const nextTargetId = derived.targetId ?? null
    if ((plan.referenceTargetIdBefore ?? null) !== nextTargetId) {
      patch.referenceTargetId = nextTargetId
    }
    // The bit rides the same recompute — a rewrite can move content into or
    // out of the marked form, and nothing else re-derives it this tx.
    patch.isFieldForm = derived.isFieldForm
    await ctx.tx.update(plan.id, patch, {skipMetadata: true})
  }
}

export const aliasSyncProcessor = defineSameTxProcessor({
  name: ALIAS_SYNC_PROCESSOR,
  watches: {kind: 'field', table: 'blocks', fields: ['content', 'properties']},
  apply: async (event: SameTxEvent, ctx: SameTxCtx) => {
    for (const row of event.changedRows) {
      const plan = planSync(row)
      if (plan === null) continue
      await applyPlan(ctx, plan)
    }
  },
})

export const aliasSameTxProcessors: ReadonlyArray<AnySameTxProcessor> = [
  aliasSyncProcessor,
]
