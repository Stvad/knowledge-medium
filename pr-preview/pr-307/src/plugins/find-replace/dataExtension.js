import { ChangeScope } from "../../data/api/changeScope.js";
import { defineMutator } from "../../data/api/mutator.js";
import { defineQuery } from "../../data/api/query.js";
import { array, boolean, number, object, string } from "../../../node_modules/zod/v4/classic/schemas.js";
import "../../data/api/index.js";
import { KERNEL_CONTENT_CHANNEL, kernelContentKey } from "../../data/invalidation.js";
import { mutatorsFacet, queriesFacet } from "../../data/facets.js";
import { DEFAULT_FIND_REPLACE_OPTIONS, buildContentSearchMatch, replaceLiteralMatches } from "./search.js";
//#region src/plugins/find-replace/dataExtension.ts
var FIND_REPLACE_SEARCH_CONTENT_QUERY = "findReplace.searchContent";
var FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR = "findReplace.applyContentReplace";
var DEFAULT_FIND_REPLACE_MAX_BLOCKS = 500;
var MAX_FIND_REPLACE_MAX_BLOCKS = 500;
var CANDIDATE_MULTIPLIER = 20;
var MAX_CANDIDATES = 5e3;
var findReplaceOptionsSchema = object({
	matchCase: boolean().optional(),
	wholeWord: boolean().optional()
});
var normalizeOptions = (options) => ({
	matchCase: options?.matchCase ?? DEFAULT_FIND_REPLACE_OPTIONS.matchCase,
	wholeWord: options?.wholeWord ?? DEFAULT_FIND_REPLACE_OPTIONS.wholeWord
});
var normalizeMaxBlocks = (maxBlocks) => Math.max(1, Math.min(maxBlocks ?? 500, MAX_FIND_REPLACE_MAX_BLOCKS));
var contentSearchResultSchema = { parse: (input) => input };
var applyContentReplaceResultSchema = { parse: (input) => input };
var searchContentArgsSchema = object({
	workspaceId: string(),
	query: string(),
	options: findReplaceOptionsSchema.optional(),
	maxBlocks: number().optional()
});
var applyContentReplaceArgsSchema = object({
	workspaceId: string(),
	find: string(),
	replace: string(),
	options: findReplaceOptionsSchema,
	items: array(object({
		blockId: string(),
		originalContent: string()
	}))
});
var SELECT_CONTENT_CANDIDATES_SQL = `
  SELECT id, content
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
    AND (
      (? != 0 AND instr(content, ?) > 0)
      OR (? = 0 AND instr(LOWER(content), LOWER(?)) > 0)
    )
  ORDER BY coalesce(user_updated_at, updated_at) DESC, id ASC
  LIMIT ?
`;
var searchContentQuery = defineQuery({
	name: FIND_REPLACE_SEARCH_CONTENT_QUERY,
	argsSchema: searchContentArgsSchema,
	resultSchema: contentSearchResultSchema,
	resolve: async ({ workspaceId, query, options, maxBlocks }, ctx) => {
		const trimmed = query.trim();
		if (!workspaceId || !trimmed) return {
			query: trimmed,
			matches: [],
			truncated: false
		};
		const normalizedOptions = normalizeOptions(options);
		const normalizedMaxBlocks = normalizeMaxBlocks(maxBlocks);
		const candidateLimit = Math.min(normalizedMaxBlocks * CANDIDATE_MULTIPLIER, MAX_CANDIDATES);
		ctx.depend({
			kind: "plugin",
			channel: KERNEL_CONTENT_CHANNEL,
			key: kernelContentKey(workspaceId)
		});
		const matchCase = normalizedOptions.matchCase ? 1 : 0;
		const rows = await ctx.db.getAll(SELECT_CONTENT_CANDIDATES_SQL, [
			workspaceId,
			matchCase,
			trimmed,
			matchCase,
			trimmed,
			candidateLimit + 1
		]);
		const matches = rows.slice(0, candidateLimit).map((row) => buildContentSearchMatch(row.id, row.content, trimmed, normalizedOptions)).filter((match) => match !== null);
		return {
			query: trimmed,
			matches: matches.slice(0, normalizedMaxBlocks),
			truncated: rows.length > candidateLimit || matches.length > normalizedMaxBlocks
		};
	}
});
var applyContentReplaceMutator = defineMutator({
	name: FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
	argsSchema: applyContentReplaceArgsSchema,
	resultSchema: applyContentReplaceResultSchema,
	scope: ChangeScope.BlockDefault,
	describe: ({ items }) => `replace content across ${items.length} blocks`,
	apply: async (tx, args) => {
		const find = args.find.trim();
		if (!find) return {
			updatedBlocks: 0,
			replacements: 0,
			skippedChangedBlocks: 0,
			skippedUnavailableBlocks: 0
		};
		const seen = /* @__PURE__ */ new Set();
		const options = normalizeOptions(args.options);
		const result = {
			updatedBlocks: 0,
			replacements: 0,
			skippedChangedBlocks: 0,
			skippedUnavailableBlocks: 0
		};
		for (const item of args.items) {
			if (seen.has(item.blockId)) continue;
			seen.add(item.blockId);
			const current = await tx.get(item.blockId);
			if (current === null || current.deleted || current.workspaceId !== args.workspaceId) {
				result.skippedUnavailableBlocks += 1;
				continue;
			}
			if (current.content !== item.originalContent) {
				result.skippedChangedBlocks += 1;
				continue;
			}
			const replaced = replaceLiteralMatches(current.content, find, args.replace, options);
			if (replaced.replacementCount === 0) continue;
			await tx.update(current.id, { content: replaced.content });
			result.updatedBlocks += 1;
			result.replacements += replaced.replacementCount;
		}
		return result;
	}
});
var findReplaceDataExtension = [queriesFacet.of(searchContentQuery, { source: "find-replace" }), mutatorsFacet.of(applyContentReplaceMutator, { source: "find-replace" })];
//#endregion
export { DEFAULT_FIND_REPLACE_MAX_BLOCKS, FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR, FIND_REPLACE_SEARCH_CONTENT_QUERY, applyContentReplaceMutator, findReplaceDataExtension, searchContentQuery };

//# sourceMappingURL=dataExtension.js.map