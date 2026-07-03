import { defineQuery } from "../../data/api/query.js";
import { array, object, string } from "../../../node_modules/zod/v4/classic/schemas.js";
import { backlinksFilterSchema } from "../../data/api/typedBlockQuery.js";
import "../../data/api/index.js";
import { typesProp } from "../../data/properties.js";
import { buildQualifiedBlockColumnsSql } from "../../data/blockSchema.js";
import { TYPED_BLOCKS_LABEL_CHANNEL, TYPED_BLOCKS_PROPERTY_CHANNEL, TYPED_BLOCKS_REFS_OF_CHANNEL, TYPED_BLOCKS_STRUCTURE_CHANNEL, typedBlocksLabelKey, typedBlocksPropertyKey, typedBlocksRefsOfKey, typedBlocksStructureKey } from "../../data/invalidation.js";
import { typesFacet } from "../../data/facets.js";
import { hasBacklinksFilter, normalizeBacklinksFilter } from "../backlinks/query.js";
import { EMPTY_GROUPED_BACKLINKS_CONFIG, GROUP_WITH_PROP_NAME, normalizeGroupedBacklinksConfig } from "./config.js";
import { labelForBlockData } from "../../utils/linkTargetAutocomplete.js";
import { buildGroupedBacklinks } from "./grouping.js";
//#region src/plugins/grouped-backlinks/query.ts
var GROUPED_BACKLINKS_FOR_BLOCK_QUERY = "groupedBacklinks.forBlock";
var groupedBacklinksSchema = { parse: (input) => input };
var groupedBacklinksConfigSchema = object({
	highPriorityTags: array(string()).optional(),
	lowPriorityTags: array(string()).optional(),
	excludedTags: array(string()).optional(),
	excludedPatterns: array(string()).optional()
}).optional();
var asBlockRows = (rows) => rows;
var dependOnSourceContextNode = (ctx, workspaceId, id) => {
	ctx.depend({
		kind: "plugin",
		channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
		key: typedBlocksStructureKey(workspaceId, id)
	});
	ctx.depend({
		kind: "plugin",
		channel: TYPED_BLOCKS_REFS_OF_CHANNEL,
		key: typedBlocksRefsOfKey(workspaceId, id)
	});
};
var dependOnGroupLabel = (ctx, workspaceId, id) => {
	ctx.depend({
		kind: "plugin",
		channel: TYPED_BLOCKS_LABEL_CHANNEL,
		key: typedBlocksLabelKey(workspaceId, id)
	});
};
var resolveBacklinkSourceIds = async (ctx, workspaceId, id, filter) => (await ctx.run("core.typedBlockIds", {
	workspaceId,
	referencedBy: { id },
	match: filter?.include,
	exclude: filter?.exclude,
	order: "created-desc"
})).filter((sourceId) => sourceId !== id);
var resolveSourceParents = async (ctx, workspaceId, sourceIds) => {
	if (sourceIds.length === 0) return [];
	const entries = await ctx.run("core.manyAncestors", { ids: sourceIds }, { deps: "none" });
	for (const sourceId of sourceIds) dependOnSourceContextNode(ctx, workspaceId, sourceId);
	for (const entry of entries) for (const ancestor of entry.ancestors) dependOnSourceContextNode(ctx, ancestor.workspaceId, ancestor.id);
	return entries.map((entry) => ({
		sourceId: entry.startId,
		parentIds: entry.ancestors.map((ancestor) => ancestor.id).reverse()
	}));
};
/** Source ids ride in a single JSON-array bind parameter and unpack
*  via `json_each`. One bind regardless of source count — avoids
*  the SQLite parameter ceiling that would have been hit by a
*  per-id `VALUES (?)` list on heavily-linked targets. */
var SOURCE_IDS_CTE = `source_ids(id) AS (SELECT value FROM json_each(?))`;
/** Hydrate the member (source/backlink) rows by id. Grouping consumes the
*  members' *references* (via `block_references`) and their parent edges, but
*  never the members' own rows — `resolveBacklinkSourceIds` returns ids only.
*  Group-header actions (e.g. daily-notes "spread") gate visibility on each
*  member's content through the action's `isVisible` (`block.peek()`), so this
*  primes those rows into the cache. One JSON-array bind (same trick as
*  `SOURCE_IDS_CTE`) avoids the SQLite parameter ceiling on heavily-linked
*  targets. */
var SELECT_GROUPED_BACKLINK_MEMBER_ROWS_SQL = `
  WITH ${SOURCE_IDS_CTE}
  SELECT ${buildQualifiedBlockColumnsSql("b")}
  FROM source_ids s
  JOIN blocks b ON b.id = s.id
  WHERE b.deleted = 0
`;
/** Group context = (refs from source + each ancestor) UNION (root
*  ancestor's own id). Roam-style: "what context is each backlink
*  in?" — the page it lives on plus any tags/refs anywhere up the
*  chain. Source ids come pre-filtered from the backlinks wrapper
*  (which delegates to typed-blocks predicates), so this SQL is now
*  filter-free and just walks ancestors for the given source set. */
var SELECT_GROUPED_BACKLINK_CANDIDATES_SQL = `
  WITH RECURSIVE
    ${SOURCE_IDS_CTE},
    ancestor_chain(source_id, anc_id, anc_parent_id, depth, path) AS (
      SELECT s.id, b.id, b.parent_id, 0, '!' || hex(b.id) || '/'
      FROM source_ids s
      JOIN blocks b ON b.id = s.id
      WHERE b.deleted = 0
      UNION ALL
      SELECT
        ancestor_chain.source_id,
        parent.id,
        parent.parent_id,
        ancestor_chain.depth + 1,
        ancestor_chain.path || '!' || hex(parent.id) || '/'
      FROM ancestor_chain
      JOIN blocks parent ON parent.id = ancestor_chain.anc_parent_id
      WHERE parent.deleted = 0
        AND ancestor_chain.depth < 100
        AND INSTR(ancestor_chain.path, '!' || hex(parent.id) || '/') = 0
    ),
    group_context_refs AS (
      SELECT DISTINCT
        ancestor_chain.source_id,
        refs.target_id AS context_id,
        'ref' AS context_kind
      FROM ancestor_chain
      JOIN block_references refs ON refs.source_id = ancestor_chain.anc_id
      WHERE refs.workspace_id = ?
        AND (refs.source_field = '' OR refs.target_id != ?)
      UNION
      SELECT
        ancestor_chain.source_id,
        ancestor_chain.anc_id AS context_id,
        'root' AS context_kind
      FROM ancestor_chain
      WHERE ancestor_chain.anc_parent_id IS NULL
    )
  SELECT DISTINCT
    cr.source_id AS source_id,
    cr.context_kind AS context_kind,
    ${buildQualifiedBlockColumnsSql("group_block")}
  FROM group_context_refs cr
  JOIN blocks group_block ON group_block.id = cr.context_id
  WHERE group_block.deleted = 0
  ORDER BY cr.source_id, coalesce(group_block.user_updated_at, group_block.updated_at) DESC, group_block.id
`;
var SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL = `
  WITH ${SOURCE_IDS_CTE}
  SELECT DISTINCT
    refs.source_id AS source_id,
    refs.source_field AS source_field
  FROM source_ids s
  JOIN block_references refs ON refs.source_id = s.id
  WHERE refs.workspace_id = ?
    AND refs.target_id = ?
    AND refs.source_field != ''
  ORDER BY refs.source_id, refs.source_field
`;
/** Roam-date `addAttributeGroups` equivalent. For each context block C
*  that the main candidates query surfaced (i.e. a block any backlink
*  references directly or through an ancestor), pull C's `groupWith`
*  property values via `block_references.source_field`. The caller
*  fans these out: every source whose context chain contained C also
*  gets C's groupWith targets as additional group candidates. The
*  context block ids ride in via the same JSON-array bind trick as
*  `SOURCE_IDS_CTE` so we don't hit the SQLite parameter ceiling. */
var SELECT_GROUPED_BACKLINK_ATTRIBUTE_CANDIDATES_SQL = `
  WITH context_ids(id) AS (SELECT value FROM json_each(?))
  SELECT DISTINCT
    refs.source_id AS context_id,
    ${buildQualifiedBlockColumnsSql("group_block")}
  FROM context_ids c
  JOIN block_references refs ON refs.source_id = c.id
  JOIN blocks group_block ON group_block.id = refs.target_id
  WHERE refs.workspace_id = ?
    AND refs.source_field = ?
    AND refs.target_id != ?
    AND group_block.deleted = 0
  ORDER BY refs.source_id, coalesce(group_block.user_updated_at, group_block.updated_at) DESC, group_block.id
`;
/** Type enrichment. For each distinct context block C the main query
*  surfaced, contribute the type names of (A) C itself and (B) blocks
*  that C references one hop out. The result is keyed by the original
*  context_id so the JS side can fan out: every source whose context
*  chain reached C also picks up the produced type names as group
*  candidates. UNION dedupes across A and B (e.g. when D is reached
*  via both paths through different context blocks for the same
*  source). The context block ids ride in via the same JSON-array
*  bind trick as `SOURCE_IDS_CTE` so we don't hit the SQLite
*  parameter ceiling. */
var SELECT_GROUPED_BACKLINK_TYPE_CANDIDATES_SQL = `
  WITH context_ids(id) AS (SELECT value FROM json_each(?))
  SELECT bt.block_id AS context_id, bt.type AS type_name
    FROM context_ids c
    JOIN block_types bt
      ON bt.block_id = c.id
     AND bt.workspace_id = ?
  UNION
  SELECT refs.source_id AS context_id, bt.type AS type_name
    FROM context_ids c
    JOIN block_references refs
      ON refs.source_id = c.id
     AND refs.workspace_id = ?
    JOIN block_types bt
      ON bt.block_id = refs.target_id
     AND bt.workspace_id = ?
  ORDER BY context_id, type_name
`;
var groupedBacklinksForBlockQuery = defineQuery({
	name: GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
	argsSchema: object({
		workspaceId: string(),
		id: string(),
		filter: backlinksFilterSchema.optional(),
		groupingConfig: groupedBacklinksConfigSchema
	}),
	resultSchema: groupedBacklinksSchema,
	resolve: async ({ workspaceId, id, filter, groupingConfig }, ctx) => {
		if (!workspaceId || !id) return {
			groups: [],
			total: 0,
			unfilteredSourceIds: [],
			sourceParents: []
		};
		const normalizedFilter = normalizeBacklinksFilter(filter);
		const normalizedGroupingConfig = normalizeGroupedBacklinksConfig(groupingConfig ?? EMPTY_GROUPED_BACKLINKS_CONFIG);
		ctx.depend({
			kind: "plugin",
			channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
			key: typedBlocksStructureKey(workspaceId, id)
		});
		ctx.depend({
			kind: "plugin",
			channel: TYPED_BLOCKS_PROPERTY_CHANNEL,
			key: typedBlocksPropertyKey(workspaceId, typesProp.name)
		});
		const unfilteredSourceIds = await resolveBacklinkSourceIds(ctx, workspaceId, id);
		const sourceIds = hasBacklinksFilter(normalizedFilter) ? await resolveBacklinkSourceIds(ctx, workspaceId, id, normalizedFilter) : unfilteredSourceIds;
		if (sourceIds.length === 0) return {
			groups: [],
			total: 0,
			unfilteredSourceIds,
			sourceParents: []
		};
		const sourceParents = await resolveSourceParents(ctx, workspaceId, sourceIds);
		const sourceIdsJson = JSON.stringify(sourceIds);
		const memberRows = await ctx.db.getAll(SELECT_GROUPED_BACKLINK_MEMBER_ROWS_SQL, [sourceIdsJson]);
		ctx.hydrateBlocks(asBlockRows(memberRows), { declareRowDeps: false });
		const candidateRows = await ctx.db.getAll(SELECT_GROUPED_BACKLINK_CANDIDATES_SQL, [
			sourceIdsJson,
			workspaceId,
			id
		]);
		const fieldCandidateRows = await ctx.db.getAll(SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL, [
			sourceIdsJson,
			workspaceId,
			id
		]);
		const sourcesByContextId = /* @__PURE__ */ new Map();
		for (const row of candidateRows) {
			let sources = sourcesByContextId.get(row.id);
			if (!sources) {
				sources = /* @__PURE__ */ new Set();
				sourcesByContextId.set(row.id, sources);
			}
			sources.add(row.source_id);
		}
		const contextIds = Array.from(sourcesByContextId.keys());
		const contextIdsJson = contextIds.length === 0 ? "[]" : JSON.stringify(contextIds);
		const attributeCandidateRows = contextIds.length === 0 ? [] : await ctx.db.getAll(SELECT_GROUPED_BACKLINK_ATTRIBUTE_CANDIDATES_SQL, [
			contextIdsJson,
			workspaceId,
			GROUP_WITH_PROP_NAME,
			id
		]);
		const typeCandidateRows = contextIds.length === 0 ? [] : await ctx.db.getAll(SELECT_GROUPED_BACKLINK_TYPE_CANDIDATES_SQL, [
			contextIdsJson,
			workspaceId,
			workspaceId,
			workspaceId
		]);
		const typesRegistry = ctx.repo.facetRuntime?.read(typesFacet);
		const typeLabelById = /* @__PURE__ */ new Map();
		if (typesRegistry) for (const contribution of typesRegistry.values()) typeLabelById.set(contribution.id, contribution.label ?? contribution.id);
		const groupRowsById = /* @__PURE__ */ new Map();
		for (const row of candidateRows) groupRowsById.set(row.id, row);
		for (const row of attributeCandidateRows) if (!groupRowsById.has(row.id)) groupRowsById.set(row.id, row);
		const groupData = ctx.hydrateBlocks(asBlockRows(Array.from(groupRowsById.values())), { declareRowDeps: false });
		for (const group of groupData) dependOnGroupLabel(ctx, group.workspaceId, group.id);
		const labelByGroupId = new Map(groupData.map((data) => [data.id, labelForBlockData(data, data.id)]));
		const candidates = candidateRows.map((row) => ({
			sourceId: row.source_id,
			groupId: row.id,
			groupLabel: labelByGroupId.get(row.id) ?? (row.content.trim() || row.id),
			kind: row.context_kind === "root" ? "root" : "ref"
		}));
		for (const row of fieldCandidateRows) candidates.push({
			sourceId: row.source_id,
			groupId: `field:${row.source_field}`,
			groupLabel: row.source_field,
			kind: "field"
		});
		for (const row of attributeCandidateRows) {
			const sources = sourcesByContextId.get(row.context_id);
			if (!sources) continue;
			const groupLabel = labelByGroupId.get(row.id) ?? (row.content.trim() || row.id);
			for (const sourceId of sources) candidates.push({
				sourceId,
				groupId: row.id,
				groupLabel,
				kind: "attribute"
			});
		}
		const emittedTypeCandidates = /* @__PURE__ */ new Set();
		for (const row of typeCandidateRows) {
			const sources = sourcesByContextId.get(row.context_id);
			if (!sources) continue;
			const groupId = `type:${row.type_name}`;
			const groupLabel = typeLabelById.get(row.type_name) ?? row.type_name;
			for (const sourceId of sources) {
				const key = `${sourceId}\x00${groupId}`;
				if (emittedTypeCandidates.has(key)) continue;
				emittedTypeCandidates.add(key);
				candidates.push({
					sourceId,
					groupId,
					groupLabel,
					kind: "type"
				});
			}
		}
		return {
			groups: buildGroupedBacklinks({
				targetId: id,
				sourceOrder: sourceIds,
				candidates,
				groupingConfig: normalizedGroupingConfig
			}),
			total: sourceIds.length,
			unfilteredSourceIds,
			sourceParents
		};
	}
});
//#endregion
export { GROUPED_BACKLINKS_FOR_BLOCK_QUERY, SELECT_GROUPED_BACKLINK_ATTRIBUTE_CANDIDATES_SQL, SELECT_GROUPED_BACKLINK_CANDIDATES_SQL, SELECT_GROUPED_BACKLINK_FIELD_CANDIDATES_SQL, SELECT_GROUPED_BACKLINK_MEMBER_ROWS_SQL, SELECT_GROUPED_BACKLINK_TYPE_CANDIDATES_SQL, groupedBacklinksForBlockQuery };

//# sourceMappingURL=query.js.map