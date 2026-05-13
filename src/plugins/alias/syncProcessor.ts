/**
 * Alias sync — same-tx processor (spec: docs/alias-rename-cases.html).
 *
 * Reconciles `content` ↔ `aliases` on the same block when one side
 * changes, AND rejects collisions when a block tries to claim an
 * alias already held by a different live block. Both behaviors live
 * here because they share the "what new aliases is this row
 * claiming?" computation.
 *
 * Decision ladder (unchanged from the post-commit version):
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
 *
 * Collision policy (V1):
 *   Refuse the user's tx via `throw new ProcessorRejection`. SQLite
 *   rolls back atomically; content and aliases stay in their
 *   pre-edit state. The caller (editor save handler, command
 *   palette, etc.) surfaces the rejection via the toast layer. The
 *   eventual goal is Roam-style "suggest merge" but the merge flow
 *   has its own design surface — V1 disallows.
 */

import {
  defineSameTxProcessor,
  ProcessorRejection,
  type AnySameTxProcessor,
  type BlockData,
  type ChangedRow,
  type SameTxCtx,
  type SameTxEvent,
} from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'
import { aliasSeatReaderFromTx, findAliasClaimant } from '@/data/targets'

export const ALIAS_SYNC_PROCESSOR = 'alias.sync'

/** What the write phase should do for one row. `null` on either side
 *  means no-op for that direction. */
interface SyncPlan {
  id: string
  workspaceId: string
  /** Aliases the user is *newly claiming* on this row. Used by the
   *  collision check; empty when the diff doesn't add anything (A3
   *  drift heal adds new content as alias, A1/A2 replace the anchor,
   *  AR1 only changes content). Computed from the planner's diff
   *  so it stays consistent with the actual write the plan describes. */
  claimedAliases: readonly string[]
  contentNext: string | null
  aliasesNext: readonly string[] | null
}

const decodeAliases = (block: BlockData): readonly string[] => {
  const encoded = block.properties[aliasesProp.name]
  if (encoded === undefined) return []
  try {
    return aliasesProp.codec.decode(encoded)
  } catch {
    return []
  }
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
 *  rule would propagate a blank value. */
export const planSync = (row: ChangedRow): SyncPlan | null => {
  if (row.before === null || row.after === null) return null
  if (row.after.deleted) return null

  const before = row.before
  const after = row.after
  const beforeAliases = decodeAliases(before)
  const afterAliases = decodeAliases(after)
  // Sync only reconciles blocks that ARE aliased.
  if (afterAliases.length === 0) return null
  const contentChanged = before.content !== after.content

  const planShell = {id: row.id, workspaceId: after.workspaceId}

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
      // The newly claimed alias here is `after.content` — provided
      // it's not also in the previous alias list.
      const claimedAliases = beforeAliases.includes(after.content) ? [] : [after.content]
      return {
        ...planShell,
        claimedAliases,
        contentNext: null,
        aliasesNext: replaced,
      }
    }
    // Rule 2 (A3): old content wasn't an alias anchor — heal
    // additively by appending new content.
    if (afterAliases.includes(after.content)) return null
    return {
      ...planShell,
      claimedAliases: beforeAliases.includes(after.content) ? [] : [after.content],
      contentNext: null,
      aliasesNext: [...afterAliases, after.content],
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
      ...planShell,
      // AR1's added alias is the new claim; collision check applies.
      claimedAliases: [added[0]],
      contentNext: added[0],
      aliasesNext: null,
    }
  }

  // No matched rule, but the user may still have ADDED aliases
  // directly (e.g. via the alias chip editor in a future UI, or via
  // a programmatic mutator). Sync doesn't write anything, but
  // collision still needs to check those.
  const directlyClaimed = afterAliases.filter(a => !beforeAliases.includes(a) && a !== '')
  if (directlyClaimed.length > 0) {
    return {
      ...planShell,
      claimedAliases: directlyClaimed,
      contentNext: null,
      aliasesNext: null,
    }
  }

  return null
}

/** Apply one plan: collision-check newly claimed aliases, then issue
 *  the amendment writes if any.
 *
 *  No stale-plan re-validation here — we're inside the user's tx, so
 *  `event.changedRows`'s `after` state IS the live state. (If a
 *  preceding same-tx processor amended this row, the same-tx
 *  runner recomputes our `changedRows` from the live snapshot
 *  before our `apply` fires, so we'd see those amendments.) */
const applyPlan = async (ctx: SameTxCtx, plan: SyncPlan): Promise<void> => {
  // Collision check: for each newly claimed alias, is there a
  // different live block in this workspace that already claims it?
  if (plan.claimedAliases.length > 0) {
    const reader = aliasSeatReaderFromTx(ctx.tx)
    for (const alias of plan.claimedAliases) {
      if (alias === '') continue  // belt-and-suspenders; planner skips blanks
      const claimantId = await findAliasClaimant(reader, alias, plan.workspaceId)
      if (claimantId !== null && claimantId !== plan.id) {
        throw new ProcessorRejection(
          `Alias "${alias}" is already used by another block`,
          'alias.collision',
          {
            alias,
            conflictingBlockId: claimantId,
            attemptedOn: plan.id,
          },
        )
      }
    }
  }

  if (plan.aliasesNext !== null) {
    await ctx.tx.setProperty(plan.id, aliasesProp, [...plan.aliasesNext], {skipMetadata: true})
  }
  if (plan.contentNext !== null) {
    await ctx.tx.update(plan.id, {content: plan.contentNext}, {skipMetadata: true})
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
