import { normalizeReferences } from "../../data/api/blockData.js";
import { ChangeScope } from "../../data/api/changeScope.js";
import { definePostCommitProcessor } from "../../data/api/processor.js";
import "../../data/api/index.js";
import { aliasesProp } from "../../data/properties.js";
import { parseReferences, renderAliasedBlockref, renderWikilink, rewriteWikilinks } from "./referenceParser.js";
//#region src/plugins/references/renameProcessor.ts
/**
* Alias-rename backlink rewriter (spec: docs/alias-rename-cases.html
* — rename ladder).
*
* Watches alias-property diffs on `blocks`. For each removed alias α
* with live backlinks (found via the `block_references` projection):
*
*   1. 1-for-1 swap (|removed| = |added| = 1) — R1, R2, A1-cascade,
*      AR1-cascade: rewrite `[[α]] → [[new]]` in source content.
*   2. Anything else with backlinks (R4, R5, R6, R7, A2-cascade):
*      rewrite `[[α]] → [α](((target-id)))` (aliased blockref).
*      Preserves the display text the source author wrote; doesn't
*      depend on what's left in `aliases`.
*   3. Pure add (no removed aliases) — R3: no-op.
*
* Lives next to `parseReferencesProcessor` in the references plugin
* because it needs the `block_references` projection to find source
* blocks.
*
* Two-phase shape mirrors parseReferences: read phase outside any tx
* builds a plan describing per-source rewrites AND records the source
* content observed at decision time. Write phase opens one tx,
* re-reads source content via `tx.get`, and skips the source entirely
* if content has changed (later user edit wins — see `applyPlan`).
* Otherwise applies the rewrites via parser-aware span splicing
* (`rewriteWikilinks`) AND surgically swaps the matching `references`
* entries in the same tx so the `block_references` trigger refreshes
* in lockstep. Without that, a second rapid rename's SELECT would
* race the separate parseReferences processor and miss the source —
* leaving the backlink stuck on an alias the target no longer carries.
*
* Idempotency: the rewrite produces source content that no longer
* contains `[[α]]`, so a second pass over the same source content is
* a no-op (no matching span). Rename doesn't re-fire on the source
* content edit because its watcher is `properties`-only.
*/
var RENAME_BACKLINKS_PROCESSOR = "references.renameBacklinks";
var SELECT_BACKLINK_SOURCES_SQL = `
  SELECT br.source_id AS sourceId, source.content AS sourceContent
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND br.alias = ?
    AND source.deleted = 0
`;
var decodeAliases = (block) => {
	const encoded = block.properties[aliasesProp.name];
	if (encoded === void 0) return [];
	try {
		return aliasesProp.codec.decode(encoded);
	} catch {
		return [];
	}
};
var replacementFor = (alias, removed, added, targetId) => {
	if (removed.length === 1 && added.length === 1) {
		const candidate = renderWikilink(added[0]);
		if (parseReferences(candidate)[0]?.alias === added[0]) return {
			text: candidate,
			refAlias: added[0]
		};
	}
	return {
		text: renderAliasedBlockref(alias, targetId),
		refAlias: targetId
	};
};
/** Pull source plans for one target's alias diff and merge into the
*  per-event `plansBySourceId` map. Reads via committed-state SQL —
*  no tx open. */
var collectTargetPlans = async (ctx, before, after, plansBySourceId) => {
	const beforeAliases = decodeAliases(before);
	const afterAliases = decodeAliases(after);
	const removed = beforeAliases.filter((a) => !afterAliases.includes(a));
	if (removed.length === 0) return;
	const added = afterAliases.filter((a) => !beforeAliases.includes(a));
	for (const alias of removed) {
		const replacement = replacementFor(alias, removed, added, after.id);
		const sources = await ctx.db.getAll(SELECT_BACKLINK_SOURCES_SQL, [
			after.workspaceId,
			after.id,
			alias
		]);
		for (const row of sources) {
			let plan = plansBySourceId.get(row.sourceId);
			if (plan === void 0) {
				plan = {
					sourceId: row.sourceId,
					originalContent: row.sourceContent,
					rewrites: []
				};
				plansBySourceId.set(row.sourceId, plan);
			}
			plan.rewrites.push({
				alias,
				replacement: replacement.text,
				targetId: after.id,
				refAlias: replacement.refAlias
			});
		}
	}
};
/** Apply rewrites to a source's `references` list. Swaps the alias on
*  content edges matching `(targetId, oldAlias)` to the new ref alias.
*  Property-typed refs (`sourceField !== ''`) are untouched — wikilink
*  rewrites never affect them. Returned list is run through
*  `normalizeReferences` so duplicates introduced by the swap (e.g.
*  source already had `[[β]]` before we rewrote `[[α]] → [[β]]`)
*  collapse, and the on-disk JSON stays canonical. */
var applyRefRewrites = (refs, rewrites) => {
	if (rewrites.length === 0) return [...refs];
	const swaps = /* @__PURE__ */ new Map();
	const key = (targetId, alias) => `${targetId}\u0000${alias}`;
	for (const rw of rewrites) swaps.set(key(rw.targetId, rw.alias), rw.refAlias);
	const next = [];
	for (const ref of refs) {
		if ((ref.sourceField ?? "") !== "") {
			next.push(ref);
			continue;
		}
		const swapped = swaps.get(key(ref.id, ref.alias));
		next.push(swapped === void 0 ? ref : {
			...ref,
			alias: swapped
		});
	}
	return normalizeReferences(next);
};
var applyPlan = async (tx, plan) => {
	const current = await tx.get(plan.sourceId);
	if (current === null || current.deleted) return;
	if (current.content !== plan.originalContent) return;
	let nextContent = current.content;
	for (const rewrite of plan.rewrites) nextContent = rewriteWikilinks(nextContent, rewrite.alias, rewrite.replacement);
	if (nextContent === current.content) return;
	const nextRefs = applyRefRewrites(current.references, plan.rewrites);
	await tx.update(plan.sourceId, {
		content: nextContent,
		references: nextRefs
	}, { skipMetadata: true });
};
/** True iff the alias-encoded value differs between before/after.
*  Cheap pre-filter on the properties-field watcher so we skip the
*  per-row decode + SQL when the change was a non-alias property. */
var aliasFieldChanged = (before, after) => {
	const b = before.properties[aliasesProp.name];
	const a = after.properties[aliasesProp.name];
	return JSON.stringify(b ?? null) !== JSON.stringify(a ?? null);
};
/** Process-wide FIFO queue for rename invocations.
*
*  Rapid back-to-back title edits (e.g. cmd-Z + retype, or two
*  setContent calls in quick succession) produce one rename event
*  per user tx. Each event reads `block_references` to find sources,
*  then opens a writeTransaction to rewrite. The READ phase runs
*  outside the tx (cheap, doesn't hold a writer slot) — which means
*  rename-N+1's SELECT can race ahead of rename-N's write commit,
*  miss the source, and leave the backlink stuck on an alias the
*  target no longer carries.
*
*  SQLite serializes writeTransactions, so rename-N+1's tx waits for
*  rename-N's tx to commit — but by then rename-N+1 has already
*  taken its (stale) read snapshot. The serializer-at-write boundary
*  is too late; we have to serialize the whole read-plan-write
*  cycle. Module-level FIFO queue does that with one promise chain.
*
*  Cost: at most one rename runs at a time process-wide. Acceptable
*  because rename is post-commit and not on the typing path; the
*  alternative (in-tx SELECT, or per-source mutex keyed on resolved
*  source ids that we don't know pre-read) is more complex for the
*  same end-state.
*
*  Errors swallowed at the chain level (re-thrown to the original
*  caller) so a single rename failure doesn't block subsequent
*  renames. */
var renameQueue = Promise.resolve();
var serializeRename = (fn) => {
	const next = renameQueue.then(fn);
	renameQueue = next.then(() => {}, () => {});
	return next;
};
var renameBacklinksProcessor = definePostCommitProcessor({
	name: RENAME_BACKLINKS_PROCESSOR,
	watches: {
		kind: "field",
		table: "blocks",
		fields: ["properties"]
	},
	apply: async (event, ctx) => serializeRename(async () => {
		const plansBySourceId = /* @__PURE__ */ new Map();
		for (const row of event.changedRows) {
			if (row.before === null || row.after === null) continue;
			if (row.after.deleted) continue;
			if (!aliasFieldChanged(row.before, row.after)) continue;
			await collectTargetPlans(ctx, row.before, row.after, plansBySourceId);
		}
		if (plansBySourceId.size === 0) return;
		await ctx.repo.tx(async (tx) => {
			for (const plan of plansBySourceId.values()) await applyPlan(tx, plan);
		}, {
			scope: ChangeScope.References,
			description: `processor: ${RENAME_BACKLINKS_PROCESSOR}`
		});
	})
});
var renamePostCommitProcessors = [renameBacklinksProcessor];
//#endregion
export { RENAME_BACKLINKS_PROCESSOR, renameBacklinksProcessor, renamePostCommitProcessors, replacementFor };

//# sourceMappingURL=renameProcessor.js.map