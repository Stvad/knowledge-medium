/**
 * Alias sync post-commit processor (spec: docs/alias-rename-cases.html
 * — sync ladder).
 *
 * Reconciles `content` ↔ `aliases` on the same block when one side
 * changes. Rules (decision ladder):
 *
 *   1. Content changed, old value ∈ aliases (A1, A2) → replace that
 *      entry with new content. Dedupe.
 *   2. Content changed, old value ∉ aliases (A3 — drift heal) → add
 *      new content as a fresh alias. Block heals; next content edit
 *      hits rule 1.
 *   3. Alias diff is a 1-for-1 swap AND content === removed alias
 *      (AR1) → rewrite content to the added alias.
 *   4. Otherwise → no sync write.
 *
 * Composition with rename: sync writes a 1-for-1 alias swap on rule
 * 1 / 3, which re-fires the watcher and lets the rename processor
 * (in `@/plugins/references`) do cross-block backlink rewriting via
 * the same alias-diff path. No special path.
 *
 * Convergence: each rule's "did this write actually change state?"
 * guard ensures the second pass (the watcher re-firing on this
 * processor's own writes) is a no-op — see the per-rule check in
 * `planSync`.
 *
 * Two-phase shape mirrors parseReferences: read phase computes a plan
 * per row outside any tx; write phase opens one tx for all plans
 * that need writing.
 */

import {
  ChangeScope,
  definePostCommitProcessor,
  type AnyPostCommitProcessor,
  type BlockData,
  type ChangedRow,
  type CommittedEvent,
  type ProcessorCtx,
  type Tx,
} from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'

export const ALIAS_SYNC_PROCESSOR = 'alias.sync'

/** What the write phase should do for one row. `null` means no-op. */
interface SyncPlan {
  id: string
  workspaceId: string
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
 *  written — the row was created/deleted in this commit, or no rule
 *  applies, or the rule's output is identical to current state. */
export const planSync = (row: ChangedRow): SyncPlan | null => {
  // Skip creates (before === null), hard-deletes (after === null), and
  // soft-deletes. None of these are "edits" the ladder reasons about.
  if (row.before === null || row.after === null) return null
  if (row.after.deleted) return null

  const before = row.before
  const after = row.after
  const beforeAliases = decodeAliases(before)
  const afterAliases = decodeAliases(after)
  // Sync only reconciles blocks that ARE aliased (an "aliased block"
  // / page-like row). A block with no aliases isn't a sync target —
  // we never silently promote a plain block into an aliased one. Note
  // this still lets rename fire on a "removed last alias" case (R7);
  // rename has its own gating on the cross-block side.
  if (afterAliases.length === 0) return null
  const contentChanged = before.content !== after.content

  if (contentChanged) {
    if (afterAliases.includes(before.content)) {
      // Rule 1 (A1, A2): replace old content's alias entry with new
      // content; dedupe. Guard: if the dedup'd result equals current,
      // no write — the second pass after sync's own write hits this
      // branch with afterAliases already containing the new content
      // (A1) or with afterAliases unchanged (other edge cases).
      const replaced = dedupe(
        afterAliases.map(a => (a === before.content ? after.content : a)),
      )
      if (arraysEqual(replaced, afterAliases)) return null
      return {
        id: row.id,
        workspaceId: after.workspaceId,
        contentNext: null,
        aliasesNext: replaced,
      }
    }
    // Rule 2 (A3): old content wasn't an alias anchor — heal additively
    // by appending new content. Skip if already an alias (e.g. the
    // user edited to a name that was already an alternate).
    if (afterAliases.includes(after.content)) return null
    return {
      id: row.id,
      workspaceId: after.workspaceId,
      contentNext: null,
      aliasesNext: [...afterAliases, after.content],
    }
  }

  // Reverse sync (AR1): content didn't change in this commit. Look
  // for an alias 1-for-1 swap whose removed entry matches current
  // content — that's the user renaming the alias and expecting
  // content to follow.
  const removed = beforeAliases.filter(a => !afterAliases.includes(a))
  const added = afterAliases.filter(a => !beforeAliases.includes(a))
  if (removed.length === 1 && added.length === 1 && after.content === removed[0]) {
    // Guard: the added value equals current content already (somehow)
    // → nothing to do. Defensive; the swap-shape check above should
    // already rule this out (added === current would mean content is
    // also in beforeAliases, so it can't have been "removed").
    if (after.content === added[0]) return null
    return {
      id: row.id,
      workspaceId: after.workspaceId,
      contentNext: added[0],
      aliasesNext: null,
    }
  }

  return null
}

const applyPlan = async (tx: Tx, plan: SyncPlan): Promise<void> => {
  if (plan.aliasesNext !== null) {
    await tx.setProperty(plan.id, aliasesProp, [...plan.aliasesNext], {skipMetadata: true})
  }
  if (plan.contentNext !== null) {
    await tx.update(plan.id, {content: plan.contentNext}, {skipMetadata: true})
  }
}

export const aliasSyncProcessor = definePostCommitProcessor({
  name: ALIAS_SYNC_PROCESSOR,
  watches: { kind: 'field', table: 'blocks', fields: ['content', 'properties'] },
  apply: async (event: CommittedEvent<undefined>, ctx: ProcessorCtx) => {
    const plans: SyncPlan[] = []
    for (const row of event.changedRows) {
      const plan = planSync(row)
      if (plan !== null) plans.push(plan)
    }
    if (plans.length === 0) return

    await ctx.repo.tx(async tx => {
      for (const plan of plans) await applyPlan(tx, plan)
    }, {
      scope: ChangeScope.References,
      description: `processor: ${ALIAS_SYNC_PROCESSOR}`,
    })
  },
})

export const aliasPostCommitProcessors: ReadonlyArray<AnyPostCommitProcessor> = [
  aliasSyncProcessor,
]
