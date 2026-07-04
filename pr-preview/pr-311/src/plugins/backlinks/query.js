import { defineQuery } from "../../data/api/query.js";
import { object, string } from "../../../node_modules/zod/v4/classic/schemas.js";
import { backlinksFilterSchema } from "../../data/api/typedBlockQuery.js";
import "../../data/api/index.js";
import isEqual from "../../../node_modules/lodash-es/isEqual.js";
import { TYPED_BLOCKS_STRUCTURE_CHANNEL, typedBlocksStructureKey } from "../../data/invalidation.js";
//#region src/plugins/backlinks/query.ts
var BACKLINKS_FOR_BLOCK_QUERY = "backlinks.forBlock";
var stringArraySchema = { parse: (input) => input };
var isPredicateMeaningful = (p) => {
	const hasWhere = p.where !== void 0 && Object.keys(p.where).length > 0;
	const hasRef = p.referencedBy !== void 0;
	const hasId = p.id !== void 0;
	return hasWhere || hasRef || hasId;
};
var stripEmpty = (predicates) => (predicates ?? []).filter(isPredicateMeaningful);
var normalizeBacklinksFilter = (filter) => ({
	include: stripEmpty(filter?.include),
	exclude: stripEmpty(filter?.exclude)
});
var samePredicate = (a, b) => isEqual(a, b);
/** Page-local filter overrides workspace defaults. The merge rules:
*   - everything the page added (include or exclude) wins outright
*   - default predicates carry through unless the page added the same
*     predicate to the opposite list (e.g. workspace removes [[done]],
*     this page wants to include it). */
var mergeBacklinksFilters = (defaults, overrides) => {
	const d = normalizeBacklinksFilter(defaults);
	const o = normalizeBacklinksFilter(overrides);
	return normalizeBacklinksFilter({
		include: [...o.include, ...d.include.filter((p) => !o.exclude.some((other) => samePredicate(p, other)))],
		exclude: [...o.exclude, ...d.exclude.filter((p) => !o.include.some((other) => samePredicate(p, other)))]
	});
};
var hasBacklinksFilter = (filter) => {
	const n = normalizeBacklinksFilter(filter);
	return n.include.length > 0 || n.exclude.length > 0;
};
/** Backlinks: blocks whose references point at `id`. Thin wrapper
*  around `resolveTypedBlocks` — the typed-query compiler drives from
*  the indexed `block_references` lookup when `referencedBy` is set,
*  preserving the perf shape of the previous dedicated SQL.
*
*  Self-reference (the target block referencing itself) is filtered
*  out post-fetch — it's a one-line check, not worth a special SQL
*  predicate. */
var backlinksForBlockQuery = defineQuery({
	name: BACKLINKS_FOR_BLOCK_QUERY,
	argsSchema: object({
		workspaceId: string(),
		id: string(),
		filter: backlinksFilterSchema.optional()
	}),
	resultSchema: stringArraySchema,
	resolve: async ({ workspaceId, id, filter }, ctx) => {
		if (!workspaceId || !id) return [];
		ctx.depend({
			kind: "plugin",
			channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
			key: typedBlocksStructureKey(workspaceId, id)
		});
		const normalized = normalizeBacklinksFilter(filter);
		return (await ctx.run("core.typedBlockIds", {
			workspaceId,
			referencedBy: { id },
			match: normalized.include,
			exclude: normalized.exclude,
			order: "created-desc"
		})).filter((sourceId) => sourceId !== id);
	}
});
//#endregion
export { BACKLINKS_FOR_BLOCK_QUERY, backlinksForBlockQuery, hasBacklinksFilter, mergeBacklinksFilters, normalizeBacklinksFilter };

//# sourceMappingURL=query.js.map