import { ProcessorRejection, defineSameTxProcessor } from "../../data/api/sameTxProcessor.js";
import "../../data/api/index.js";
import { aliasesProp } from "../../data/properties.js";
//#region src/plugins/alias/syncProcessor.ts
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
var ALIAS_SYNC_PROCESSOR = "alias.sync";
var decodeAliases = (block) => {
	const encoded = block.properties[aliasesProp.name];
	if (encoded === void 0) return [];
	try {
		return aliasesProp.codec.decode(encoded);
	} catch {
		return [];
	}
};
var arraysEqual = (a, b) => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
};
var dedupe = (values) => {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const v of values) {
		if (seen.has(v)) continue;
		seen.add(v);
		out.push(v);
	}
	return out;
};
/** Build the plan for one row. Returns null when nothing should be
*  written — the row was created/deleted in this commit, no rule
*  applies, the rule's output is identical to current state, or the
*  rule would propagate a blank value. Storage triggers remain the
*  final uniqueness invariant; content-rename plans also carry intent
*  metadata so a rejected merge can drop only the replaced alias. */
var planSync = (row) => {
	if (row.before === null || row.after === null) return null;
	if (row.after.deleted) return null;
	const before = row.before;
	const after = row.after;
	const beforeAliases = decodeAliases(before);
	const afterAliases = decodeAliases(after);
	if (afterAliases.length === 0) return null;
	if (before.content !== after.content) {
		if (after.content === "") return null;
		if (afterAliases.includes(before.content)) {
			const replaced = dedupe(afterAliases.map((a) => a === before.content ? after.content : a));
			if (arraysEqual(replaced, afterAliases)) return null;
			return {
				id: row.id,
				workspaceId: after.workspaceId,
				contentNext: null,
				aliasesNext: replaced,
				dropSourceAliasesOnCollision: before.content === "" ? [] : [before.content]
			};
		}
		if (afterAliases.includes(after.content)) return null;
		return {
			id: row.id,
			workspaceId: after.workspaceId,
			contentNext: null,
			aliasesNext: [...afterAliases, after.content],
			dropSourceAliasesOnCollision: []
		};
	}
	const removed = beforeAliases.filter((a) => !afterAliases.includes(a));
	const added = afterAliases.filter((a) => !beforeAliases.includes(a));
	if (removed.length === 1 && added.length === 1 && after.content === removed[0]) {
		if (added[0] === "") return null;
		if (after.content === added[0]) return null;
		return {
			id: row.id,
			workspaceId: after.workspaceId,
			contentNext: added[0],
			aliasesNext: null,
			dropSourceAliasesOnCollision: []
		};
	}
	return null;
};
var assertNoAliasCollision = async (ctx, plan) => {
	if (plan.aliasesNext === null) return;
	for (const alias of plan.aliasesNext) {
		const claimant = await ctx.tx.aliasLookup(alias, plan.workspaceId);
		if (claimant === null || claimant.id === plan.id) continue;
		throw new ProcessorRejection(`Alias "${alias}" is already used by another block`, "alias.collision", {
			alias,
			conflictingBlockId: claimant.id,
			conflictingBlockTitle: claimant.content.slice(0, 80),
			workspaceId: plan.workspaceId,
			attemptedOn: plan.id,
			dropSourceAliases: [...plan.dropSourceAliasesOnCollision],
			collisionOrigin: "content-rename"
		});
	}
};
/** Apply one plan: issue the amendment writes. The preflight above is
*  for user-facing merge intent only; the storage-layer trigger still
*  handles any write path that reaches the alias index. */
var applyPlan = async (ctx, plan) => {
	if (plan.aliasesNext !== null) {
		await assertNoAliasCollision(ctx, plan);
		await ctx.tx.setProperty(plan.id, aliasesProp, [...plan.aliasesNext], { skipMetadata: true });
	}
	if (plan.contentNext !== null) await ctx.tx.update(plan.id, { content: plan.contentNext }, { skipMetadata: true });
};
var aliasSyncProcessor = defineSameTxProcessor({
	name: ALIAS_SYNC_PROCESSOR,
	watches: {
		kind: "field",
		table: "blocks",
		fields: ["content", "properties"]
	},
	apply: async (event, ctx) => {
		for (const row of event.changedRows) {
			const plan = planSync(row);
			if (plan === null) continue;
			await applyPlan(ctx, plan);
		}
	}
});
var aliasSameTxProcessors = [aliasSyncProcessor];
//#endregion
export { ALIAS_SYNC_PROCESSOR, aliasSameTxProcessors, aliasSyncProcessor, planSync };

//# sourceMappingURL=syncProcessor.js.map