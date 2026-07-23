/**
 * Reference parsing + orphan-alias cleanup post-commit processors (spec §7).
 *
 * `references.parseReferences`
 *   - watches: { kind: 'field', table: 'blocks', fields: ['content', 'properties', 'references', 'deleted'] }
 *   - For each changedRow whose `content` or `properties` changed (insert
 *     or update), parse `[[alias]]` / `((uuid))` references and ref-typed
 *     properties. `references` and `deleted` are also watched — not to
 *     drive parsing off them, but so references-only writers re-converge
 *     and a tombstone→live restore re-derives; see the registration's
 *     `watches` comment below for the full rationale.
 *   - Resolve aliases to existing target ids via a workspace-scoped
 *     SQL lookup (committed-state read via ctx.db). On miss, create
 *     the target via ensureAliasTarget / ensureDailyNoteTarget.
 *   - Write `tx.update(sourceId, {references}, {skipMetadata: true})`.
 *   - If any non-date alias target was newly inserted (or restored),
 *     schedule `references.cleanupOrphanAliases` with
 *     `{newlyInsertedAliasTargetIds}` after delayMs: 4000.
 *   - Opens its own tx via `ctx.repo.tx(..., {scope:
 *     ChangeScope.References})` — separate undo bucket; uploads.
 *
 * `references.cleanupOrphanAliases`
 *   - watches: { kind: 'explicit' }
 *   - scheduledArgsSchema: z.object({newlyInsertedAliasTargetIds: z.array(z.string())})
 *     (validated at enqueue time so a bad arg fails the originating tx)
 *   - For each candidate id: if no block currently references it,
 *     `tx.delete(id)` (subtree-aware soft-delete via the kernel
 *     mutator path? — for v1 just tx.delete since target blocks are
 *     leaves).
 *   - Date-shaped alias targets are excluded from the cleanup list at
 *     parseReferences-schedule time (§7.6 daily-note exemption); this
 *     processor only sees non-date ids.
 *
 * Why not in-tx parseReferences (§7.1): same-tx parsing would add
 * typing latency to a hot path. Today's app already runs follow-up
 * parsing fire-and-forget; the redesign keeps that shape.
 *
 * Two-phase shape (v4.32, see §5.7): both processors do their reads
 * BEFORE opening a write tx. The framework no longer auto-wraps apply
 * in a writeTransaction, so the read phase doesn't hold a writer slot
 * and reads can't queue behind a writer-that-awaits-them (the
 * `tasks/processor-tx-deadlock.md` shape). The write phase still uses a
 * single tx for atomicity (target writes + references update +
 * afterCommit schedule all commit together).
 */

import { z } from 'zod'
import {
  ChangeScope,
  definePostCommitProcessor,
  derivedRefKey,
  normalizeReferences,
  reconcileDerived,
  type BlockData,
  type BlockReference,
  type AnyPostCommitProcessor,
  type CommittedEvent,
  type ProcessorCtx,
  type TypeRegistrySnapshot,
  type Tx,
} from '@/data/api'
import {
  parseReferences as parseAliasMarks,
  parseBlockRefs,
} from './referenceParser.ts'
import { isRetainableAbsentRef, projectPropertyReferences } from './referenceProjection.ts'
import { devAssertionsEnabled } from '@/data/internals/devAssertions.js'
import { parseAliasCollisionError } from '@/data/internals/raiseProtocol.js'
import {
  aliasSeatReaderFromDb,
  ensureAliasTarget,
  isAliasSeatSlotId,
  matchesAliasSeatSeed,
  resolveAliasSeatId,
} from '@/data/targets'
import { aliasesProp, typesProp } from '@/data/properties'
import { propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { deleteSubtreeInTx } from '@/data/subtreeDelete'
import {
  dailyNoteBlockId,
  ensureDailyNoteTarget,
} from '@/plugins/daily-notes/dailyNotes.js'
import { parseLiteralDailyPageTitle } from '@/utils/relativeDate.js'

export const PARSE_REFERENCES_PROCESSOR = 'references.parseReferences'
export const CLEANUP_ORPHAN_ALIASES_PROCESSOR = 'references.cleanupOrphanAliases'

const SELECT_LIVE_REFERENCE_SOURCE_SQL = `
  SELECT 1 AS present
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND source.deleted = 0
  LIMIT 1
`

/** Parse-basis fingerprint of a row's parse-relevant columns (content,
 *  properties, references), serialized together so the write phase can
 *  compare "has anything the parse depends on moved" with one equality
 *  check. Adding a new parse-relevant column is a single-edit change here. */
const planBasisOf = (row: BlockData): string =>
  JSON.stringify([row.content, row.properties, row.references])

/** Per-source plan built during the read phase. The write phase consumes
 *  this and issues all writes in a single tx. */
interface SourcePlan {
  sourceId: string
  workspaceId: string
  /** Parse basis observed at read time, from `planBasisOf`. The write
   *  phase re-reads the source and skips the plan when the fingerprint has
   *  moved — mirrors renameProcessor.applyPlan's stale-plan guard. Safe to
   *  skip: the write that moved the source re-fires this processor (all
   *  three underlying fields are watched) with a fresh plan, so the LAST
   *  write's event always applies. Without the content/properties portion,
   *  a concurrent rewriter (e.g. the rename backlink rewriter fired by the
   *  same properties commit) can land first and have its result clobbered
   *  by this stale plan (found by referencesRecompute.fuzz.test.ts:
   *  self-referencing block whose alias is renamed ends with content
   *  `[[new]]` but a stored ref still carrying `old`). The references
   *  portion covers writers that touch ONLY the references column — the
   *  ref-backfill reprojection on schema load, raw bridge writes: their
   *  entries would otherwise be silently dropped by a plan built from the
   *  pre-write row, with no watched-field change left to re-derive them
   *  (Codex review on PR #371). */
  basis: string
  /** Resolved-or-to-be-created refs the source's `references` column
   *  should end up with. The id may name a non-yet-existing target if
   *  the write phase will create it (alias case below). */
  references: BlockReference[]
  /** Aliases to be created via `ensureAliasTarget` in the write phase,
   *  each with the seat id the read phase PREDICTED for it. Excludes
   *  ids resolved by lookup (those already exist). The prediction can
   *  go stale — a live block may claim the alias between plan build and
   *  apply — so the write phase compares the ensure's actual id against
   *  `id` and retargets the planned references on divergence (see
   *  applySourcePlan). */
  aliasesToEnsure: Array<{alias: string; id: string}>
  /** Date marks to be materialized via `ensureDailyNoteTarget` in the
   *  write phase — one entry per distinct mark alias, carrying the
   *  LITERAL alias so the write phase can recheck it for a mid-plan
   *  claimant (long-form date aliases don't equal the ISO the seat
   *  claims). */
  datesToEnsure: Array<{iso: string; alias: string}>
  /** True iff the planned `references` differ from what's currently on
   *  the row — used to skip a no-op write that would re-fire the
   *  field-watcher and produce a useless row_events / ps_crud entry. */
  referencesChanged: boolean
}

/** Read phase: parse refs, resolve existing alias targets via committed-
 *  state lookup, and produce a SourcePlan describing what the write
 *  phase needs to do. No tx opened here — `ctx.repo.query.aliasLookup`
 *  hits committed state. */

const buildSourcePlan = async (
  ctx: ProcessorCtx,
  source: BlockData,
  before: BlockData | null,
): Promise<SourcePlan> => {
  const aliasMarks = parseAliasMarks(source.content)
  const blockRefMarks = parseBlockRefs(source.content)

  const aliasRefs: BlockReference[] = []
  const dateRefs: BlockReference[] = []
  const aliasesToEnsure: Array<{alias: string; id: string}> = []
  const datesToEnsure: Array<{iso: string; alias: string}> = []
  const seenAliases = new Set<string>()

  for (const mark of aliasMarks) {
    if (seenAliases.has(mark.alias)) continue
    seenAliases.add(mark.alias)
    const dailyTitle = parseLiteralDailyPageTitle(mark.alias)
    // Lookup-first for both date and non-date aliases, before either
    // miss path below: when a live block ALREADY owns this alias (e.g.
    // an imported page aliased "2026-01-05" on a non-seat id, or typing
    // `[[Inbox]]` for an Inbox someone else made via the create-page UI;
    // §7.5 race), bind to it rather than minting a fresh target. For the
    // date path this also sidesteps a guaranteed collision: minting the
    // deterministic seat instead would have `ensureDailyNoteTarget` set
    // the same alias on the new seat, trip the alias-uniqueness trigger,
    // and roll back the whole write tx — permanently stripped references
    // for the source (found by referencesRecompute.fuzz.test.ts).
    // Convergent either way: alias uniqueness means every client
    // resolves the same owner, and on a lookup miss every client mints
    // the same deterministic id (daily seat or alias-seat probe, below).
    const existing = await ctx.repo.query
      .aliasLookup({workspaceId: source.workspaceId, alias: mark.alias})
      .load()
    if (existing !== null) {
      (dailyTitle !== null ? dateRefs : aliasRefs).push({id: existing.id, alias: mark.alias})
      continue
    }
    if (dailyTitle !== null) {
      // Daily note path — distinct deterministic id, never feeds cleanup.
      // Store the user's literal alias on the source reference, but
      // materialise the canonical ISO daily-note target. `parseLiteral...`
      // accepts ISO and Roam long-form titles while rejecting relative
      // words like "today", "friday", and "may" so those remain aliases.
      const id = dailyNoteBlockId(source.workspaceId, dailyTitle.iso)
      dateRefs.push({id, alias: mark.alias})
      datesToEnsure.push({iso: dailyTitle.iso, alias: mark.alias})
      continue
    }
    // Will be created by ensureAliasTarget in the write phase. The
    // id is the result of the indexed-deterministic seat probe — slot
    // 0 unless a prior alias claims it (post-rename collision) or it's
    // tombstoned. We probe here (read-phase, committed state) so the
    // predicted id matches what ensureAliasTarget will pick in the
    // write phase. Convergence: same world-state → same probe answer.
    const id = await resolveAliasSeatId(
      aliasSeatReaderFromDb(ctx.db),
      mark.alias,
      source.workspaceId,
    )
    aliasRefs.push({id, alias: mark.alias})
    aliasesToEnsure.push({alias: mark.alias, id})
  }

  const blockRefs: BlockReference[] = []
  const seenBlockRefs = new Set<string>()
  for (const mark of blockRefMarks) {
    if (seenBlockRefs.has(mark.blockId)) continue
    seenBlockRefs.add(mark.blockId)
    blockRefs.push({id: mark.blockId, alias: mark.blockId})
  }

  const propertyRefs = projectPropertyReferences(source, ctx.propertySchemas)
  // Add-only / retain-on-source contract
  // (docs/contracts/derived-data-add-only.md): recompute is authoritative for
  // content + present-schema property refs, but a prior ref whose schema is
  // ABSENT can't be re-derived, so `reconcileDerived` retains it rather than
  // dropping it (see `isRetainableAbsentRef`). Dropping such a ref is the
  // per-block "drip" that, fleet-wide, complements the reprojection mass-strip
  // (both silently deleted ~10k SRS `next-review-date` backlinks).
  const references = reconcileDerived<BlockReference>({
    prior: source.references,
    recomputed: [...aliasRefs, ...dateRefs, ...blockRefs, ...propertyRefs],
    keyOf: derivedRefKey,
    retain: ref => isRetainableAbsentRef(ref, source, before, ctx.propertySchemas),
  })
  if (devAssertionsEnabled()) {
    // L2 dev/test-only assertion (off in prod): the basis of the
    // written refs is the committed source, and the reconcile must honor the
    // add-only / retain-on-source contract AT THIS SITE — every recomputed ref
    // (content + present-schema property) survives, and every prior ref we're
    // bound to retain (absent-schema, value unchanged) survives. Catches a
    // future "made it strip again" here, which a reconcileDerived unit test
    // can't (wrong args at this call site would still pass there).
    const resultKeys = new Set(references.map(derivedRefKey))
    for (const ref of [...aliasRefs, ...dateRefs, ...blockRefs, ...propertyRefs]) {
      if (!resultKeys.has(derivedRefKey(ref))) {
        throw new Error(
          `[references] reconcile dropped a recomputed ref ${ref.sourceField ?? ''}/${ref.id} on ${source.id}`,
        )
      }
    }
    for (const ref of source.references) {
      if (
        isRetainableAbsentRef(ref, source, before, ctx.propertySchemas)
        && !resultKeys.has(derivedRefKey(ref))
      ) {
        throw new Error(
          `[references] reconcile dropped a retainable absent-schema ref ${ref.sourceField ?? ''}/${ref.id} on ${source.id}`,
        )
      }
    }
  }
  // tx.update normalises references on write, so `source.references`'s
  // JSON text — when written by any tx.* path — is already in canonical
  // form (sorted, deduped, omitted-empty-sourceField, no whitespace).
  // Re-stringifying through V8's key-order-preserving JSON.parse →
  // JSON.stringify reproduces the same text, so equality compares
  // canonical to canonical without a second normalize on this side.
  // Rows that bypassed normalize-on-write (legacy data, raw bypass
  // writes) will fail this equality and get rewritten on first parse —
  // exactly the convergence we want.
  const referencesChanged =
    JSON.stringify(source.references)
    !== JSON.stringify(normalizeReferences(references))

  return {
    sourceId: source.id,
    workspaceId: source.workspaceId,
    basis: planBasisOf(source),
    references,
    aliasesToEnsure,
    datesToEnsure,
    referencesChanged,
  }
}

/** Write phase: apply one source's plan inside the active tx. Returns
 *  the list of alias-target ids this tx actually inserted (for
 *  cleanup-eligibility filtering — only `ensureAliasTarget`'s
 *  `inserted: true` results count; date results never feed cleanup per
 *  §7.6). */
/** Make the resolved date target CLAIM each long-form literal spelling
 *  that bound to it (e.g. "January 5th, 2026" alongside the ISO
 *  "2026-01-05"), so the binding gets the same
 *  `block_aliases_workspace_alias_unique` exclusivity protection a
 *  plain-alias seat gets from `ensureAliasTarget` claiming its literal.
 *  Without the claim the literal string stays unowned: any later block
 *  can legitimately claim it, and existing bindings are left silently
 *  pointing at the old target FOREVER — nothing watches "a
 *  previously-unclaimed literal was just claimed", and the source only
 *  re-parses on its own row's changes (found by
 *  referencesRecompute.fuzz.test.ts' stable-wrong-binding sweep).
 *
 *  `targetId` is whatever the ensure resolved — the deterministic daily
 *  seat OR a live block that claims the ISO (a user page aliased to the
 *  date). Claiming the spelling on the latter mutates a user page's
 *  alias list, deliberately: that page IS what the spelling resolves to,
 *  the claim is exactly the record that makes future resolutions
 *  exclusive, and removing it triggers the rename ladder which rewrites
 *  the sources properly. Callers run this AFTER the per-literal
 *  `tx.aliasLookup` recheck, so within this tx the literal is known
 *  unclaimed — the uniqueness trigger backstops same-device racers.
 *
 *  Documented residuals (adversarial review, PR #384):
 *  - The claim outlives the referencing edit: undo of the source (or a
 *    later removal of the ISO alias from a user-page target) leaves the
 *    auto-claimed literal in place — orphan cleanup exempts dates
 *    (§7.6) and the rename ladder only rewrites sources bound under the
 *    REMOVED string, so a page can keep resolving a spelling the user
 *    never claimed. Rare, needs a lifecycle design (see issue #383's
 *    release/reclaim discussion) rather than a spot fix.
 *  - Concurrent claims of two spellings on two devices merge via
 *    whole-column properties LWW server-side: one device's append can be
 *    silently dropped, reverting that literal to bound-but-unclaimed
 *    (the pre-claim state). Nothing re-fires the claim — same blind spot
 *    this docblock's first paragraph describes. Small-fleet-rare;
 *    accepted. */
const claimLiteralDateAliases = async (
  tx: Tx,
  targetId: string,
  iso: string,
  aliases: readonly string[],
): Promise<boolean> => {
  const literals = [...new Set(aliases.filter(alias => alias !== iso))]
  if (literals.length === 0) return false
  const target = await tx.get(targetId)
  if (target === null || target.deleted) return false
  let existing: readonly string[]
  try {
    const encoded = target.properties[aliasesProp.name]
    existing = encoded === undefined ? [] : aliasesProp.codec.decode(encoded)
  } catch {
    // Malformed alias property (e.g. legacy `["2026-01-05", 1]`): the
    // append below would REPLACE the whole list, dropping entries the
    // block_aliases trigger still indexes — parsing a long-form date
    // must never un-claim the target's ISO. Losing a live binding is
    // worse than leaving the literal unclaimed, so skip the claim for
    // this target; it degrades to the pre-claim first-writer behavior.
    return false
  }
  const missing = literals.filter(literal => !existing.includes(literal))
  if (missing.length === 0) return false
  // skipMetadata: derived bookkeeping, same as the source-references
  // write in applySourcePlan — advances updatedAt for sync but must not
  // stamp userUpdatedAt/updatedBy, or a background re-parse of some
  // unrelated source makes the target look freshly user-edited.
  try {
    await tx.setProperty(targetId, aliasesProp, [...existing, ...missing], {skipMetadata: true})
    return true
  } catch (err) {
    // Swallow ONLY alias-collision aborts. The alias-update trigger
    // deletes and re-inserts ALL of the target's aliases, re-checking
    // each against the uniqueness trigger — so a LATENT duplicate on a
    // pre-existing alias (cross-client dupes sync in trigger-free; V1
    // leaves their merge latent, see clientSchema.ts) would abort here
    // even though the newly claimed literals are fine. Letting that
    // propagate would roll back the WHOLE parse batch — references for
    // every other changed row — and recur on every re-edit: a silent,
    // permanent recompute outage keyed to someone else's dupe. RAISE
    // (ABORT) backs out only this statement (tx stays open) and
    // setProperty records bookkeeping only after a successful execute,
    // so skipping is clean: the claim degrades to the pre-claim
    // first-writer behavior for this target only (adversarial review
    // on PR #384).
    if (parseAliasCollisionError(err) === null) throw err
    return false
  }
}

const applySourcePlan = async (
  tx: Tx,
  ctx: ProcessorCtx,
  plan: SourcePlan,
  typeSnapshot: TypeRegistrySnapshot,
): Promise<string[]> => {
  // Stale-plan guard — see the SourcePlan.basis docblock.
  const current = await tx.get(plan.sourceId)
  if (current === null || current.deleted) return []
  if (planBasisOf(current) !== plan.basis) return []
  const newlyInserted: string[] = []
  // The read phase's target predictions (seat/daily ids) can go stale:
  // a live block claiming the alias between plan build and apply makes
  // the ensure resolve to the CLAIMANT (tx-scoped lookup-first inside
  // ensureAliasTarget / ensureDailyNoteTarget), not the predicted seat.
  // The interfering write touched the claimant row, not the source, so
  // no watched field re-fires the source — skipping like the stale-plan
  // guard would drop the update permanently. Retargeting the planned
  // entries to the ensure's actual id converges to exactly what a fresh
  // re-parse would produce (its lookup would hit the claimant). The
  // `alias !== id` conjunct keeps raw `((id))` blockrefs literal.
  let references = plan.references
  const retarget = (predicted: string, actual: string, alias?: string) => {
    if (actual === predicted) return
    references = references.map(ref =>
      ref.sourceField === undefined
      && ref.id === predicted
      && ref.alias !== ref.id
      && (alias === undefined || ref.alias === alias)
        ? {...ref, id: actual}
        : ref,
    )
  }
  // Per-mark alias recheck for dates: the mark's LITERAL alias (possibly
  // long-form, e.g. "May 20th, 2026") can be claimed mid-plan too —
  // ensureDailyNoteTarget's internal lookup-first only rechecks the ISO,
  // so a long-form claimant would otherwise be missed and the entry left
  // bound to the daily seat where a fresh parse would bind the claimant
  // (Codex review on PR #371).
  const seatAliasesByIso = new Map<string, string[]>()
  for (const {iso, alias} of plan.datesToEnsure) {
    const claimant = await tx.aliasLookup(alias, plan.workspaceId)
    if (claimant !== null) {
      retarget(dailyNoteBlockId(plan.workspaceId, iso), claimant.id, alias)
      continue
    }
    seatAliasesByIso.set(iso, [...(seatAliasesByIso.get(iso) ?? []), alias])
  }
  for (const [iso, aliases] of seatAliasesByIso) {
    const ensured = await ensureDailyNoteTarget(tx, ctx.repo, iso, plan.workspaceId, typeSnapshot)
    // Retarget ONLY the entries for the literal date-mark aliases that
    // fell through to this ensure — never every entry sharing the seat
    // id. A renamed daily seat can be lookup-bound under an unrelated
    // alias in the SAME plan (e.g. `[[Foo]]` resolved to the seat that
    // now claims only "Foo"); an unfiltered retarget would hijack that
    // binding to wherever the ensure resolved, and the wrong state is
    // STABLE — every re-parse recomputes and re-retargets the same way,
    // so referencesChanged sees no delta and nothing heals (round-2
    // adversarial review, verified repro).
    for (const alias of aliases) {
      retarget(dailyNoteBlockId(plan.workspaceId, iso), ensured.id, alias)
    }
    // §9 arrival-order repair (a whole-block `[[2026-01-05]]` — or
    // long-form — row written before this daily-note target existed
    // derived its reference_target_id to NULL) is no longer scheduled
    // here: the kernel `core.aliasClaimRederive` hook observes this tx's
    // alias gains (the seat insert AND any newly-claimed literal) and
    // schedules the batched rederive centrally (issue #402 — per-caller
    // schedule calls were the forget-me failure mode).
    await claimLiteralDateAliases(tx, ensured.id, iso, aliases)
  }
  for (const {alias, id: predicted} of plan.aliasesToEnsure) {
    const ensured = await ensureAliasTarget(tx, ctx.repo, alias, plan.workspaceId, typeSnapshot)
    if (ensured.inserted) newlyInserted.push(ensured.id)
    retarget(predicted, ensured.id, alias)
    // The §9 arrival-order repair (late-binding rederive of NULL-stamped
    // `[[alias]]` rows) rides the kernel `core.aliasClaimRederive` hook,
    // which observes the seat's alias claim in this tx's own post-commit
    // dispatch — no per-caller schedule call (issue #402).
  }
  // Retargeting invalidates the read phase's referencesChanged verdict —
  // recompute it the same canonical-to-canonical way buildSourcePlan does
  // (`current.references` equals the plan basis; the guard above ensured
  // that).
  const referencesChanged = references === plan.references
    ? plan.referencesChanged
    : JSON.stringify(current.references) !== JSON.stringify(normalizeReferences(references))
  if (referencesChanged) {
    await tx.update(plan.sourceId, {references}, {skipMetadata: true})
  }
  return newlyInserted
}

/** True iff this plan needs any write — either a target ensure call
 *  (insert/restore) or a references-column update. Used to skip opening
 *  a tx entirely when the parse came out idempotent. */
const planNeedsWrite = (plan: SourcePlan): boolean =>
  plan.referencesChanged
  || plan.aliasesToEnsure.length > 0
  || plan.datesToEnsure.length > 0

export const parseReferencesProcessor = definePostCommitProcessor({
  name: PARSE_REFERENCES_PROCESSOR,
  // `deleted` is watched so a RESTORE re-derives references: tx.update
  // legally writes content/properties on tombstones (sync, undo), but
  // apply() skips soft-deleted rows — without re-firing on the
  // deleted→live flip, a block edited while tombstoned comes back live
  // with marks in content and no derived refs (the audit's
  // content_link_recompute "stripped" anomaly; found by
  // referencesRecompute.fuzz.test.ts). Pure deletes still exit via the
  // `row.after.deleted` skip below, so the extra firings are no-ops.
  //
  // `references` is watched so references-ONLY writers (the ref-backfill
  // reprojection on schema load, raw bridge writes) re-converge: the
  // stale-plan guard drops a plan whose references basis moved, and this
  // re-fire is what rebuilds it from the fresh row — retention
  // (isRetainableAbsentRef) keeps entries the parse can't re-derive.
  // No self-loop: this processor's own references write re-fires one
  // read phase that comes out idempotent (planNeedsWrite false) and
  // stops. (Codex review on PR #371.)
  watches: { kind: 'field', table: 'blocks', fields: ['content', 'properties', 'references', 'deleted'] },
  apply: async (event: CommittedEvent<undefined>, ctx: ProcessorCtx) => {
    // Read phase — outside any tx; bare-connection reads, no writer
    // contention. Each plan describes what the write phase needs to do
    // (or nothing, if the parse came out idempotent).
    const plans: SourcePlan[] = []
    for (const row of event.changedRows) {
      // Skip hard-deletes (after === null) — nothing to parse.
      if (row.after === null) continue
      // Skip soft-deletes (after.deleted === true) — same reason.
      if (row.after.deleted) continue
      plans.push(await buildSourcePlan(ctx, row.after, row.before))
    }
    if (!plans.some(planNeedsWrite)) return

    // Write phase — single tx, atomic for refs + targets + afterCommit.
    const typeSnapshot = ctx.repo.snapshotTypeRegistries()
    await ctx.repo.tx(async tx => {
      const allNewlyInserted: string[] = []
      let workspaceForCleanup: string | null = null
      for (const plan of plans) {
        if (!planNeedsWrite(plan)) continue
        const inserted = await applySourcePlan(tx, ctx, plan, typeSnapshot)
        allNewlyInserted.push(...inserted)
        // All sources in one tx share a workspace per spec invariant 11
        // — pin the first non-null and use it for cleanup scheduling.
        workspaceForCleanup ??= plan.workspaceId
      }
      if (allNewlyInserted.length > 0 && workspaceForCleanup !== null) {
        tx.afterCommit(
          CLEANUP_ORPHAN_ALIASES_PROCESSOR,
          {
            workspaceId: workspaceForCleanup,
            newlyInsertedAliasTargetIds: allNewlyInserted,
          },
          { delayMs: 4000 },
        )
      }
    }, {
      scope: ChangeScope.References,
      description: `processor: ${PARSE_REFERENCES_PROCESSOR}`,
    })
  },
})

// ──── references.cleanupOrphanAliases ────

const cleanupArgsSchema = z.object({
  workspaceId: z.string(),
  newlyInsertedAliasTargetIds: z.array(z.string()),
})

interface CleanupArgs {
  workspaceId: string
  newlyInsertedAliasTargetIds: string[]
}

declare module '@/data/api' {
  interface PostCommitProcessorRegistry {
    [CLEANUP_ORPHAN_ALIASES_PROCESSOR]: CleanupArgs
  }
}

export const cleanupOrphanAliasesProcessor = definePostCommitProcessor<CleanupArgs>({
  name: CLEANUP_ORPHAN_ALIASES_PROCESSOR,
  watches: { kind: 'explicit' },
  scheduledArgsSchema: cleanupArgsSchema,
  apply: async (event: CommittedEvent<CleanupArgs>, ctx: ProcessorCtx) => {
    const ids = event.scheduledArgs?.newlyInsertedAliasTargetIds ?? []
    const workspaceId = event.scheduledArgs?.workspaceId ?? ''
    if (ids.length === 0 || !workspaceId) return

    // Read phase — gather actual orphans without holding a writer slot.
    const orphans: string[] = []
    for (const id of ids) {
      const source = await ctx.db.getOptional<{present: number}>(
        SELECT_LIVE_REFERENCE_SOURCE_SQL,
        [workspaceId, id],
      )
      if (source === null) orphans.push(id)
    }
    if (orphans.length === 0) return

    // Write phase — soft-delete the orphans. Single tx so the deletes
    // are atomic and produce one command_events row.
    await reapSeatsInTx(ctx, workspaceId, orphans, CLEANUP_ORPHAN_ALIASES_PROCESSOR)
  },
})

/** Soft-delete orphaned seats in one tx (shared by the mint-time cleanup
 *  above and the reference-drop reaper below). In a child-backed
 *  workspace a seat's OWN generated properties (alias / types)
 *  materialize as hidden field rows (PR #288 §9) — delete those
 *  alongside the seat or they dangle live under the tombstone. Only
 *  machinery-generated field rows go; user content under a seat is left
 *  alone. Flip-gated (§9): generated field rows exist only in
 *  child-backed workspaces — in an un-flipped one, a column match under
 *  a seat is by construction user-authored content, never machinery's
 *  to delete. */
const reapSeatsInTx = async (
  ctx: ProcessorCtx,
  workspaceId: string,
  ids: readonly string[],
  processorName: string,
): Promise<void> => {
  await ctx.repo.tx(async tx => {
    const sweepGeneratedFieldRows = await tx.isPropertyChildBackedWorkspace(workspaceId)
    const generatedFieldIds = new Set([
      propertyDefinitionBlockId(workspaceId, aliasesProp.seedKey),
      propertyDefinitionBlockId(workspaceId, typesProp.seedKey),
    ])
    for (const id of ids) {
      // Re-read in-tx: a racer may have deleted (or hard-removed) the
      // seat since the read phase — nothing to reap then.
      const current = await tx.get(id)
      if (current === null || current.deleted) continue
      // Soft-delete the seat, then its generated field rows (with their
      // value children).
      await tx.delete(id)
      if (!sweepGeneratedFieldRows) continue
      const children = await tx.childrenOf(id, undefined)
      for (const child of children) {
        const target = child.referenceTargetId ?? null
        if (target !== null && generatedFieldIds.has(target)) {
          await deleteSubtreeInTx(tx, child.id)
        }
      }
    }
  }, {
    scope: ChangeScope.References,
    description: `processor: ${processorName}`,
  })
}

// ──── references.reapOrphanAliasSeats ────

export const REAP_ORPHAN_ALIAS_SEATS_PROCESSOR = 'references.reapOrphanAliasSeats'

/** Reference-target ids a row-state actually contributes to the live
 *  backlink index: none while tombstoned or absent (the index joins on
 *  `source.deleted = 0`, so a source's soft-delete releases its refs). */
const liveReferenceTargetIds = (row: BlockData | null): ReadonlySet<string> =>
  row === null || row.deleted
    ? new Set<string>()
    : new Set(row.references.map(ref => ref.id))

/** Rewrite-side orphan-seat re-enqueue (issue #402): when a
 *  reference-dropping write removes the LAST live reference to a
 *  machine-minted alias seat, nothing used to re-check the seat — its
 *  one mint-time check (4s after creation) ran while the referencing
 *  row was still live, and skipped ids are never re-enqueued. The seat
 *  then survives indefinitely, squatting the released name (concrete
 *  path: a client re-derives `[[old]]` in a rename window, minting a
 *  seat; the arriving rename rewrite then drops the reference).
 *
 *  Same derived-transition→schedule shape as `core.aliasClaimRederive`,
 *  for the opposite transition: reference count → zero. Watches the
 *  `references` column diff (plus `deleted`, since tombstoning a source
 *  releases its refs) rather than relying on any particular rewriter to
 *  remember a schedule call.
 *
 *  Collection gate — ALL of, checked per dropped target:
 *   - no live source still references it (committed-state index probe);
 *   - the row is live and matches `aliasSeatSeed` exactly (shape);
 *   - its id is a deterministic seat-slot id for its own content
 *     (machine-mint discriminator — a user-created page can share the
 *     seed shape byte-for-byte, e.g. quick-find's create-page, but
 *     never the uuidv5 slot id);
 *   - not date-shaped (§7.6 daily-note exemption — belt on top of the
 *     id gate, which already excludes the daily namespace);
 *   - no live children beyond the seat's own generated field rows.
 *  A wrongly-skipped seat is the safe miss (it just keeps squatting
 *  until the alias is re-typed and re-dropped); a wrong DELETE of a
 *  user page is the failure this gate stack exists to make unreachable.
 *  If a re-reference lands concurrently, the seat-slot probe restores
 *  the pristine tombstone on the next parse — convergent either way. */
export const reapOrphanAliasSeatsProcessor = definePostCommitProcessor({
  name: REAP_ORPHAN_ALIAS_SEATS_PROCESSOR,
  watches: {kind: 'field', table: 'blocks', fields: ['references', 'deleted']},
  apply: async (event: CommittedEvent<undefined>, ctx: ProcessorCtx) => {
    const dropped = new Set<string>()
    for (const row of event.changedRows) {
      const before = liveReferenceTargetIds(row.before)
      const after = liveReferenceTargetIds(row.after)
      for (const id of before) {
        if (!after.has(id)) dropped.add(id)
      }
    }
    if (dropped.size === 0) return

    const workspaceId = event.workspaceId
    const readSeat = aliasSeatReaderFromDb(ctx.db)
    const generatedFieldIds = new Set([
      propertyDefinitionBlockId(workspaceId, aliasesProp.seedKey),
      propertyDefinitionBlockId(workspaceId, typesProp.seedKey),
    ])
    const orphans: string[] = []
    for (const id of dropped) {
      const source = await ctx.db.getOptional<{present: number}>(
        SELECT_LIVE_REFERENCE_SOURCE_SQL,
        [workspaceId, id],
      )
      if (source !== null) continue
      const seat = await readSeat(id)
      if (seat === null || seat.deleted) continue
      if (parseLiteralDailyPageTitle(seat.content) !== null) continue
      if (!matchesAliasSeatSeed(seat)) continue
      if (!isAliasSeatSlotId(id, seat.content, workspaceId)) continue
      if (seat.hasLiveChildren) {
        const children = await ctx.db.getAll<{reference_target_id: string | null}>(
          'SELECT reference_target_id FROM blocks WHERE parent_id = ? AND deleted = 0',
          [id],
        )
        const onlyGeneratedChildren = children.every(child =>
          child.reference_target_id !== null
          && generatedFieldIds.has(child.reference_target_id))
        if (!onlyGeneratedChildren) continue
      }
      orphans.push(id)
    }
    if (orphans.length === 0) return

    await reapSeatsInTx(ctx, workspaceId, orphans, REAP_ORPHAN_ALIAS_SEATS_PROCESSOR)
  },
})

// ──── Bundle ────

export const referencesPostCommitProcessors: ReadonlyArray<AnyPostCommitProcessor> = [
  parseReferencesProcessor,
  cleanupOrphanAliasesProcessor,
  reapOrphanAliasSeatsProcessor,
]
