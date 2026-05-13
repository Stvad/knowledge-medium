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
 * Two-phase shape mirrors parseReferences:
 *   - Read phase computes a plan per row from the event's `(before,
 *     after)` snapshot, outside any tx.
 *   - Write phase opens one tx; for each plan, re-reads the target
 *     row via `tx.get` and verifies the row's current state still
 *     matches the snapshot we planned against. If diverged — the
 *     user (or another processor) wrote to the row between event
 *     and apply — the plan is stale; skip rather than clobber. The
 *     watcher will re-fire on the newer state and the next planSync
 *     pass will produce a fresh decision.
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

/** What the write phase should do for one row. `null` means no-op
 *  on that side. `expectedContent` / `expectedAliases` snapshot what
 *  the planner observed; the write phase compares against current
 *  state and skips on mismatch (stale-plan guard). */
interface SyncPlan {
  id: string
  workspaceId: string
  expectedContent: string
  expectedAliases: readonly string[]
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
 *  rule would propagate a blank value (sync never creates a `""`
 *  alias entry or a `""` content body — see the blank-string guards
 *  below). */
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

  const planShell = {
    id: row.id,
    workspaceId: after.workspaceId,
    expectedContent: after.content,
    expectedAliases: afterAliases,
  }

  if (contentChanged) {
    // Blank-content guard for the content→alias direction: never
    // write a `""` alias entry. The alias index supports the row but
    // lookup ignores empty aliases — a blank entry pollutes the
    // alias list without being useful. The user clearing a page title
    // expressing "no name" should keep the existing aliases as-is.
    if (after.content === '') return null

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
        ...planShell,
        contentNext: null,
        aliasesNext: replaced,
      }
    }
    // Rule 2 (A3): old content wasn't an alias anchor — heal additively
    // by appending new content. Skip if already an alias (e.g. the
    // user edited to a name that was already an alternate).
    if (afterAliases.includes(after.content)) return null
    return {
      ...planShell,
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
    // Defensive: don't propagate a blank rename-to into content. A
    // user renaming alias "Foo" → "" is unusual but possible; we'd
    // rather leave content alone than create a blank-titled block.
    if (added[0] === '') return null
    // Guard: the added value equals current content already (somehow)
    // → nothing to do. Defensive; the swap-shape check above should
    // already rule this out (added === current would mean content is
    // also in beforeAliases, so it can't have been "removed").
    if (after.content === added[0]) return null
    return {
      ...planShell,
      contentNext: added[0],
      aliasesNext: null,
    }
  }

  return null
}

/** Apply one plan inside the write tx. Re-reads the row via `tx.get`
 *  and skips if state has diverged from the planner's snapshot — the
 *  watcher will re-fire on the fresher state and produce a new plan.
 *  See file-header for the rationale. */
const applyPlan = async (tx: Tx, plan: SyncPlan): Promise<void> => {
  const current = await tx.get(plan.id)
  if (current === null || current.deleted) return
  if (current.content !== plan.expectedContent) return
  const currentAliases = decodeAliases(current)
  if (!arraysEqual(currentAliases, plan.expectedAliases)) return
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
