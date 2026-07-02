import { aliasesProp } from "../data/properties.js";
import { buildFilterPrefixes, rankCandidates } from "./fuzzyRank.js";
//#region src/utils/linkTargetAutocomplete.ts
/** How many candidate rows to pull from SQL before JS ranking. The pre-
*  filter is permissive (token-prefix LIKE), so over-fetching gives the
*  ranker enough material to find typo / out-of-order matches even when
*  the display limit is small. */
var ALIAS_CANDIDATE_MULTIPLIER = 4;
var ALIAS_CANDIDATE_CEILING = 200;
/** Minimum trimmed query length before the content substring scan runs.
*  Shorter prefixes match a huge fraction of any non-trivial workspace
*  and produce no useful ranking signal, while the underlying LIKE scan
*  is O(total content bytes) regardless of result count. Aliases are
*  index-backed and meaningful at any length, so they still fire below
*  this threshold. */
var MIN_CONTENT_SEARCH_LEN = 3;
var labelForBlockData = (data, fallback) => {
	const aliases = data?.properties[aliasesProp.name];
	if (Array.isArray(aliases)) {
		const alias = aliases.find((value) => typeof value === "string" && value.trim() !== "");
		if (alias) return alias;
	}
	return data?.content?.trim() || fallback;
};
var stringSet = (values) => new Set(values ?? []);
var aliasMatchesFromRows = (rows, seenBlockIds) => {
	const aliases = [];
	for (const row of rows) {
		if (seenBlockIds.has(row.blockId)) continue;
		seenBlockIds.add(row.blockId);
		aliases.push({
			alias: row.alias,
			blockId: row.blockId,
			content: row.content
		});
	}
	return aliases;
};
var blockMatchesFromRows = (rows, seenBlockIds) => {
	const blocks = [];
	for (const block of rows) {
		if (seenBlockIds.has(block.id)) continue;
		seenBlockIds.add(block.id);
		blocks.push({
			blockId: block.id,
			content: block.content,
			label: labelForBlockData(block, block.id)
		});
	}
	return blocks;
};
var searchAliasLabels = async (repo, { workspaceId, query, recentBlockIds, limit = 50 }) => {
	if (!workspaceId) return [];
	const trimmed = query.trim();
	if (!trimmed) return repo.query.aliasesInWorkspace({
		workspaceId,
		filter: ""
	}).load();
	const rows = await runFuzzyAliasSearch(repo, {
		workspaceId,
		query: trimmed,
		recentBlockIds,
		limit
	});
	const seen = /* @__PURE__ */ new Set();
	const labels = [];
	for (const row of rows) {
		if (seen.has(row.alias)) continue;
		seen.add(row.alias);
		labels.push(row.alias);
	}
	return labels;
};
var runFuzzyAliasSearch = async (repo, { workspaceId, query, recentBlockIds, limit }) => {
	const prefixes = buildFilterPrefixes(query);
	const fetchLimit = Math.min(limit * ALIAS_CANDIDATE_MULTIPLIER, ALIAS_CANDIDATE_CEILING);
	return rankCandidates({
		candidates: (await repo.query.aliasMatchesFuzzy({
			workspaceId,
			prefixes,
			query,
			limit: fetchLimit
		}).load()).map((row) => ({
			blockId: row.blockId,
			label: row.alias,
			updatedAt: row.updatedAt,
			content: row.content
		})),
		query,
		recentBlockIds
	}).slice(0, limit).map((item) => ({
		alias: item.candidate.label,
		blockId: item.candidate.blockId,
		content: item.candidate.content
	}));
};
var searchAliasMatches = async (repo, args) => {
	if (!args.workspaceId) return [];
	const trimmed = args.query.trim();
	if (!trimmed) return [];
	return (await runFuzzyAliasSearch(repo, {
		workspaceId: args.workspaceId,
		query: trimmed,
		recentBlockIds: args.recentBlockIds,
		limit: args.limit
	})).map((row) => ({
		alias: row.alias,
		blockId: row.blockId,
		content: row.content
	}));
};
var searchLinkTargets = async (repo, { workspaceId, query, limit, excludeBlockIds, recentBlockIds }) => {
	const trimmed = query.trim();
	if (!workspaceId || !trimmed) return {
		aliases: [],
		blocks: []
	};
	return searchLinkTargetsProgressively(repo, {
		workspaceId,
		query: trimmed,
		limit,
		excludeBlockIds,
		recentBlockIds
	});
};
var SCORE_BLOCK_FULL_EXACT = 300;
var SCORE_BLOCK_FULL_PREFIX = 200;
var SCORE_BLOCK_FULL_SUBSTRING = 100;
var SCORE_BLOCK_RECENT_MRU_HEAD = 80;
var SCORE_BLOCK_RECENT_MRU_STEP = 6;
var blockSearchRecencyBoost = (blockId, recentBlockIds) => {
	if (!recentBlockIds) return 0;
	const idx = recentBlockIds.indexOf(blockId);
	if (idx === -1) return 0;
	return Math.max(SCORE_BLOCK_RECENT_MRU_HEAD - idx * SCORE_BLOCK_RECENT_MRU_STEP, 0);
};
var blockSearchTextScore = (content, query) => {
	const lowerContent = content.toLowerCase();
	const lowerQuery = query.toLowerCase().trim();
	if (!lowerQuery) return 0;
	if (lowerContent === lowerQuery) return SCORE_BLOCK_FULL_EXACT;
	if (lowerContent.startsWith(lowerQuery)) return SCORE_BLOCK_FULL_PREFIX;
	const idx = lowerContent.indexOf(lowerQuery);
	if (idx === -1) return 0;
	return SCORE_BLOCK_FULL_SUBSTRING - Math.min(idx, SCORE_BLOCK_FULL_SUBSTRING);
};
var orderBlockSearchRows = (rows, query, recentBlockIds, limit) => {
	const scored = rows.map((row, index) => ({
		row,
		index,
		score: blockSearchTextScore(row.content, query) + blockSearchRecencyBoost(row.id, recentBlockIds)
	}));
	scored.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.index - b.index;
	});
	return scored.slice(0, limit).map((item) => item.row);
};
var searchLinkTargetsProgressively = async (repo, { workspaceId, query, limit, excludeBlockIds, recentBlockIds }, callbacks = {}) => {
	const trimmed = query.trim();
	if (!workspaceId || !trimmed) return {
		aliases: [],
		blocks: []
	};
	const aliasRowsPromise = searchAliasMatches(repo, {
		workspaceId,
		query: trimmed,
		limit,
		recentBlockIds
	});
	const fetchLimit = Math.min(limit * ALIAS_CANDIDATE_MULTIPLIER, ALIAS_CANDIDATE_CEILING);
	const blockRowsPromise = trimmed.length >= MIN_CONTENT_SEARCH_LEN ? repo.query.searchByContent({
		workspaceId,
		query: trimmed,
		limit: fetchLimit
	}).load().then((rows) => ({
		ok: true,
		rows
	}), (error) => ({
		ok: false,
		error
	})) : null;
	const seenBlockIds = stringSet(excludeBlockIds);
	const aliases = aliasMatchesFromRows(await aliasRowsPromise, seenBlockIds);
	callbacks.onAliases?.(aliases);
	if (blockRowsPromise === null) {
		const result = {
			aliases,
			blocks: []
		};
		callbacks.onBlocks?.(result.blocks, result);
		return result;
	}
	const blockRows = await blockRowsPromise;
	if (!blockRows.ok) throw blockRows.error;
	const blocks = blockMatchesFromRows(orderBlockSearchRows(blockRows.rows, trimmed, recentBlockIds, limit), seenBlockIds);
	const result = {
		aliases,
		blocks
	};
	callbacks.onBlocks?.(blocks, result);
	return result;
};
var searchLinkTargetIdCandidates = async (repo, args) => {
	const matches = await searchLinkTargets(repo, {
		workspaceId: args.workspaceId,
		query: args.query,
		limit: args.limit,
		excludeBlockIds: args.excludeIds
	});
	return [...matches.aliases.map((row) => ({
		id: row.blockId,
		label: row.alias,
		detail: row.content
	})), ...matches.blocks.map((block) => ({
		id: block.blockId,
		label: block.label,
		detail: block.content
	}))].slice(0, args.limit);
};
var searchLinkTargetValueCandidates = async (repo, args) => {
	const matches = await searchLinkTargets(repo, {
		workspaceId: args.workspaceId,
		query: args.query,
		limit: args.limit
	});
	const seenValues = stringSet(args.excludeValues);
	const candidates = [];
	const pushCandidate = (candidate) => {
		const value = candidate.value.trim();
		if (!value || seenValues.has(value)) return;
		seenValues.add(value);
		candidates.push({
			...candidate,
			value
		});
	};
	for (const row of matches.aliases) pushCandidate({
		key: `alias:${row.blockId}:${row.alias}`,
		value: row.alias,
		label: row.alias,
		detail: row.content
	});
	for (const block of matches.blocks) pushCandidate({
		key: `block:${block.blockId}`,
		value: block.label,
		label: block.label,
		detail: block.content
	});
	return candidates.slice(0, args.limit);
};
//#endregion
export { labelForBlockData, searchAliasLabels, searchAliasMatches, searchLinkTargetIdCandidates, searchLinkTargetValueCandidates, searchLinkTargets, searchLinkTargetsProgressively };

//# sourceMappingURL=linkTargetAutocomplete.js.map