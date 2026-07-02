import { normalizeReferences } from "../../data/api/blockData.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { derivedRefKey, reconcileDerived } from "../../data/api/derivedData.js";
import { definePostCommitProcessor } from "../../data/api/processor.js";
import { array, object, string } from "../../../node_modules/zod/v4/classic/schemas.js";
import "../../data/api/index.js";
import { devAssertionsEnabled } from "../../data/internals/devAssertions.js";
import { aliasSeatReaderFromDb, ensureAliasTarget, resolveAliasSeatId } from "../../data/targets.js";
import { dailyNoteBlockId, ensureDailyNoteTarget } from "../daily-notes/dailyNotes.js";
import { parseBlockRefs, parseReferences } from "./referenceParser.js";
import { isRetainableAbsentRef, projectPropertyReferences } from "./referenceProjection.js";
import { parseLiteralDailyPageTitle } from "../../utils/relativeDate.js";
//#region src/plugins/references/referencesProcessor.ts
/**
* Reference parsing + orphan-alias cleanup post-commit processors (spec §7).
*
* `references.parseReferences`
*   - watches: { kind: 'field', table: 'blocks', fields: ['content', 'properties'] }
*   - For each changedRow whose `content` or `properties` changed (insert
*     or update), parse `[[alias]]` / `((uuid))` references and ref-typed
*     properties.
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
var PARSE_REFERENCES_PROCESSOR = "references.parseReferences";
var CLEANUP_ORPHAN_ALIASES_PROCESSOR = "references.cleanupOrphanAliases";
var SELECT_LIVE_REFERENCE_SOURCE_SQL = `
  SELECT 1 AS present
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND source.deleted = 0
  LIMIT 1
`;
/** Read phase: parse refs, resolve existing alias targets via committed-
*  state lookup, and produce a SourcePlan describing what the write
*  phase needs to do. No tx opened here — `ctx.repo.query.aliasLookup`
*  hits committed state. */
var buildSourcePlan = async (ctx, source, before) => {
	const aliasMarks = parseReferences(source.content);
	const blockRefMarks = parseBlockRefs(source.content);
	const aliasRefs = [];
	const dateRefs = [];
	const aliasesToEnsure = [];
	const datesToEnsure = [];
	const seenAliases = /* @__PURE__ */ new Set();
	for (const mark of aliasMarks) {
		if (seenAliases.has(mark.alias)) continue;
		seenAliases.add(mark.alias);
		const dailyTitle = parseLiteralDailyPageTitle(mark.alias);
		if (dailyTitle !== null) {
			const id = dailyNoteBlockId(source.workspaceId, dailyTitle.iso);
			dateRefs.push({
				id,
				alias: mark.alias
			});
			datesToEnsure.push(dailyTitle.iso);
			continue;
		}
		const existing = await ctx.repo.query.aliasLookup({
			workspaceId: source.workspaceId,
			alias: mark.alias
		}).load();
		if (existing !== null) {
			aliasRefs.push({
				id: existing.id,
				alias: mark.alias
			});
			continue;
		}
		const id = await resolveAliasSeatId(aliasSeatReaderFromDb(ctx.db), mark.alias, source.workspaceId);
		aliasRefs.push({
			id,
			alias: mark.alias
		});
		aliasesToEnsure.push(mark.alias);
	}
	const blockRefs = [];
	const seenBlockRefs = /* @__PURE__ */ new Set();
	for (const mark of blockRefMarks) {
		if (seenBlockRefs.has(mark.blockId)) continue;
		seenBlockRefs.add(mark.blockId);
		blockRefs.push({
			id: mark.blockId,
			alias: mark.blockId
		});
	}
	const propertyRefs = projectPropertyReferences(source, ctx.propertySchemas);
	const references = reconcileDerived({
		prior: source.references,
		recomputed: [
			...aliasRefs,
			...dateRefs,
			...blockRefs,
			...propertyRefs
		],
		keyOf: derivedRefKey,
		retain: (ref) => isRetainableAbsentRef(ref, source, before, ctx.propertySchemas)
	});
	if (devAssertionsEnabled()) {
		const resultKeys = new Set(references.map(derivedRefKey));
		for (const ref of [
			...aliasRefs,
			...dateRefs,
			...blockRefs,
			...propertyRefs
		]) if (!resultKeys.has(derivedRefKey(ref))) throw new Error(`[references] reconcile dropped a recomputed ref ${ref.sourceField ?? ""}/${ref.id} on ${source.id}`);
		for (const ref of source.references) if (isRetainableAbsentRef(ref, source, before, ctx.propertySchemas) && !resultKeys.has(derivedRefKey(ref))) throw new Error(`[references] reconcile dropped a retainable absent-schema ref ${ref.sourceField ?? ""}/${ref.id} on ${source.id}`);
	}
	const referencesChanged = JSON.stringify(source.references) !== JSON.stringify(normalizeReferences(references));
	return {
		sourceId: source.id,
		workspaceId: source.workspaceId,
		references,
		aliasesToEnsure,
		datesToEnsure,
		referencesChanged
	};
};
/** Write phase: apply one source's plan inside the active tx. Returns
*  the list of alias-target ids this tx actually inserted (for
*  cleanup-eligibility filtering — only `ensureAliasTarget`'s
*  `inserted: true` results count; date results never feed cleanup per
*  §7.6). */
var applySourcePlan = async (tx, ctx, plan, typeSnapshot) => {
	const newlyInserted = [];
	for (const date of plan.datesToEnsure) await ensureDailyNoteTarget(tx, ctx.repo, date, plan.workspaceId, typeSnapshot);
	for (const alias of plan.aliasesToEnsure) {
		const ensured = await ensureAliasTarget(tx, ctx.repo, alias, plan.workspaceId, typeSnapshot);
		if (ensured.inserted) newlyInserted.push(ensured.id);
	}
	if (plan.referencesChanged) await tx.update(plan.sourceId, { references: plan.references }, { skipMetadata: true });
	return newlyInserted;
};
/** True iff this plan needs any write — either a target ensure call
*  (insert/restore) or a references-column update. Used to skip opening
*  a tx entirely when the parse came out idempotent. */
var planNeedsWrite = (plan) => plan.referencesChanged || plan.aliasesToEnsure.length > 0 || plan.datesToEnsure.length > 0;
var parseReferencesProcessor = definePostCommitProcessor({
	name: PARSE_REFERENCES_PROCESSOR,
	watches: {
		kind: "field",
		table: "blocks",
		fields: ["content", "properties"]
	},
	apply: async (event, ctx) => {
		const plans = [];
		for (const row of event.changedRows) {
			if (row.after === null) continue;
			if (row.after.deleted) continue;
			plans.push(await buildSourcePlan(ctx, row.after, row.before));
		}
		if (!plans.some(planNeedsWrite)) return;
		const typeSnapshot = ctx.repo.snapshotTypeRegistries();
		await ctx.repo.tx(async (tx) => {
			const allNewlyInserted = [];
			let workspaceForCleanup = null;
			for (const plan of plans) {
				if (!planNeedsWrite(plan)) continue;
				const inserted = await applySourcePlan(tx, ctx, plan, typeSnapshot);
				allNewlyInserted.push(...inserted);
				workspaceForCleanup ??= plan.workspaceId;
			}
			if (allNewlyInserted.length > 0 && workspaceForCleanup !== null) tx.afterCommit(CLEANUP_ORPHAN_ALIASES_PROCESSOR, {
				workspaceId: workspaceForCleanup,
				newlyInsertedAliasTargetIds: allNewlyInserted
			}, { delayMs: 4e3 });
		}, {
			scope: ChangeScope.References,
			description: `processor: ${PARSE_REFERENCES_PROCESSOR}`
		});
	}
});
var cleanupOrphanAliasesProcessor = definePostCommitProcessor({
	name: CLEANUP_ORPHAN_ALIASES_PROCESSOR,
	watches: { kind: "explicit" },
	scheduledArgsSchema: object({
		workspaceId: string(),
		newlyInsertedAliasTargetIds: array(string())
	}),
	apply: async (event, ctx) => {
		const ids = event.scheduledArgs?.newlyInsertedAliasTargetIds ?? [];
		const workspaceId = event.scheduledArgs?.workspaceId ?? "";
		if (ids.length === 0 || !workspaceId) return;
		const orphans = [];
		for (const id of ids) if (await ctx.db.getOptional(SELECT_LIVE_REFERENCE_SOURCE_SQL, [workspaceId, id]) === null) orphans.push(id);
		if (orphans.length === 0) return;
		await ctx.repo.tx(async (tx) => {
			for (const id of orphans) await tx.delete(id);
		}, {
			scope: ChangeScope.References,
			description: `processor: ${CLEANUP_ORPHAN_ALIASES_PROCESSOR}`
		});
	}
});
var referencesPostCommitProcessors = [parseReferencesProcessor, cleanupOrphanAliasesProcessor];
//#endregion
export { CLEANUP_ORPHAN_ALIASES_PROCESSOR, PARSE_REFERENCES_PROCESSOR, cleanupOrphanAliasesProcessor, parseReferencesProcessor, referencesPostCommitProcessors };

//# sourceMappingURL=referencesProcessor.js.map