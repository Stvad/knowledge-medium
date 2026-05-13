/**
 * Alias sync — same-tx processor (spec: docs/alias-rename-cases.html).
 *
 * Reconciles `content` ↔ `aliases` on the same block when one side
 * changes. Collision detection (refusing a tx that would claim a
 * taken alias) is enforced at the storage layer by the
 * `block_aliases_workspace_alias_unique` trigger; the tx engine
 * translates the trigger's RAISE into a `ProcessorRejection` with
 * `code: 'alias.collision'`. That arrangement means every write path
 * (local mutators, `tx.create`, `tx.restore`, undo replay, future
 * plugins) gets the uniqueness check for free — this processor only
 * needs to worry about keeping the two representations in agreement.
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
  defineSameTxProcessor,
  type AnySameTxProcessor,
  type BlockData,
  type ChangedRow,
  type SameTxCtx,
  type SameTxEvent,
} from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'

export const ALIAS_SYNC_PROCESSOR = 'alias.sync'

/** What the write phase should do for one row. `null` on either side
 *  means no-op for that direction. */
interface SyncPlan {
  id: string
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
 *  rule would propagate a blank value. Collision is a separate
 *  concern handled by the storage-layer trigger; this planner doesn't
 *  need to consider it. */
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
        contentNext: null,
        aliasesNext: replaced,
      }
    }
    // Rule 2 (A3): old content wasn't an alias anchor — heal
    // additively by appending new content.
    if (afterAliases.includes(after.content)) return null
    return {
      id: row.id,
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
      id: row.id,
      contentNext: added[0],
      aliasesNext: null,
    }
  }

  return null
}

/** Apply one plan: issue the amendment writes. The storage-layer
 *  trigger handles collision detection on the alias write below; if
 *  it fires, the user's writeTransaction rolls back atomically and
 *  the tx engine translates the RAISE into `ProcessorRejection`. */
const applyPlan = async (ctx: SameTxCtx, plan: SyncPlan): Promise<void> => {
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
