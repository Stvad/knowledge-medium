import { defineQuery } from "../api/query.js";
import { _enum, array, boolean, number, object, record, string, unknown } from "../../../node_modules/zod/v4/classic/schemas.js";
import { blockPredicateSchema, referenceFilterSchema } from "../api/typedBlockQuery.js";
import "../api/index.js";
import { SELECT_BLOCK_COLUMNS_SQL, buildQualifiedBlockColumnsSql } from "../blockSchema.js";
import { ANCESTORS_SQL, CHILDREN_IDS_SQL, CHILDREN_SQL, SUBTREE_SQL, manyAncestorsSql } from "./treeQueries.js";
import { assertAncestorWalkBounded, buildCandidatesCte, compileTypedBlockQuery, isSelectiveWhereValue, normalizeTypedBlockQuery } from "./typedBlockQuery.js";
import { KERNEL_ALIASES_CHANNEL, KERNEL_CONTENT_CHANNEL, TYPED_BLOCKS_LIVE_CHANNEL, TYPED_BLOCKS_PROPERTY_CHANNEL, TYPED_BLOCKS_REFERENCE_CHANNEL, TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL, TYPED_BLOCKS_STRUCTURE_CHANNEL, TYPED_BLOCKS_TYPE_CHANNEL, kernelAliasesKey, kernelContentKey, typedBlocksLiveKey, typedBlocksPropertyKey, typedBlocksReferenceFieldKey, typedBlocksReferenceKey, typedBlocksStructureKey, typedBlocksTypeKey } from "../invalidation.js";
//#region src/data/internals/kernelQueries.ts
/**
* Kernel queries — raw SQL constants + `defineQuery` facet contributions
* for outside-tx reads (UI hooks, search, alias lookup, type
* filters, tree walks).
*
* Surface: SQL constants up top (used by tests, kept stable for plugin
* authors who want the same queries without going through the facet),
* then `KERNEL_QUERIES` (Phase 4 chunk B) — the bundle that the kernel
* data extension and the Repo's construction-time registration consume.
* Each `defineQuery` wraps a SQL constant and re-declares the same
* dependencies the legacy `repo.X(id)` factories on `Repo` did.
*
* Property-shape note: the new `BlockData.properties` is flat
* `{name: encodedValue}`, NOT the legacy `{name: {name, type, value}}`
* record. So `json_extract(properties_json, '$.alias')` returns the
* encoded value directly (string[] for alias, string for type, etc.).
* The legacy `'$.alias.value'` paths don't exist anymore.
*/
var SELECT_BLOCK_BY_ID_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`;
/** Type filter — array membership via the trigger-maintained block_types index. */
var SELECT_BLOCKS_BY_TYPE_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql("b")}
  FROM blocks b
  JOIN block_types bt
    ON bt.block_id = b.id
   AND bt.workspace_id = b.workspace_id
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND bt.type = ?
  ORDER BY b.created_at ASC, b.id ASC
`;
var BLOCKS_CONTENT_FTS_MIN_QUERY_LENGTH = 3;
var quoteFtsPhrase = (text) => `"${text.replace(/"/g, "\"\"")}"`;
var stripOuterQuotePair = (query) => {
	const trimmed = query.trim();
	return trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"") ? trimmed.slice(1, -1) : trimmed;
};
var tokenizeContentSearchQuery = (query) => {
	const tokens = [];
	let i = 0;
	const pushTerm = (text, excluded) => {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (!excluded && (trimmed === "AND" || trimmed === "OR" || trimmed === "NOT")) {
			tokens.push({
				kind: "operator",
				op: trimmed
			});
			return;
		}
		tokens.push({
			kind: "term",
			text: trimmed,
			excluded
		});
	};
	while (i < query.length) {
		while (i < query.length && /\s/.test(query[i] ?? "")) i++;
		if (i >= query.length) break;
		let excluded = false;
		if (query[i] === "-" && i + 1 < query.length && !/\s/.test(query[i + 1] ?? "")) {
			excluded = true;
			i++;
		}
		if (query[i] === "\"") {
			i++;
			const start = i;
			while (i < query.length && query[i] !== "\"") i++;
			pushTerm(query.slice(start, i), excluded);
			if (query[i] === "\"") i++;
			continue;
		}
		const start = i;
		while (i < query.length && !/\s/.test(query[i] ?? "")) i++;
		pushTerm(query.slice(start, i), excluded);
	}
	return tokens;
};
var isTrigramSearchable = (text) => text.trim().length >= BLOCKS_CONTENT_FTS_MIN_QUERY_LENGTH;
var compilePhraseContentSearchQuery = (query) => {
	const rankQuery = stripOuterQuotePair(query.trim());
	if (!isTrigramSearchable(rankQuery)) return null;
	return {
		matchQuery: quoteFtsPhrase(rankQuery),
		rankQuery
	};
};
/** Compile QuickFind user text into safe FTS5 trigram MATCH syntax.
*
*  Default words become required literal terms (`sync foo` →
*  `"sync" "foo"`), so multi-word searches match terms anywhere.
*  User quotes preserve contiguous phrase matching. Uppercase OR and
*  NOT / -term are the only exposed operators; other punctuation and
*  operator-looking words are quoted as user text so MATCH does not
*  surface parser errors in QuickFind.
*/
var compileBlocksContentSearchQuery = (query) => {
	const trimmed = query.trim();
	if (!isTrigramSearchable(trimmed)) return null;
	const tokens = tokenizeContentSearchQuery(trimmed);
	const hasPositiveFtsTerm = tokens.some((token) => token.kind === "term" && !token.excluded && isTrigramSearchable(token.text));
	const rankQuery = stripOuterQuotePair(trimmed);
	const clauses = [[]];
	const exclusions = [];
	let pendingOr = false;
	let pendingNot = false;
	let sawPositive = false;
	const currentClause = () => clauses[clauses.length - 1];
	const addPositive = (phrase) => {
		if (pendingOr && currentClause().length > 0) clauses.push([]);
		currentClause().push(phrase);
		sawPositive = true;
		pendingOr = false;
		pendingNot = false;
	};
	const addRequiredLiteral = (text) => {
		if (!isTrigramSearchable(text)) return false;
		addPositive(quoteFtsPhrase(text));
		return true;
	};
	for (const token of tokens) {
		if (token.kind === "operator") {
			if (token.op === "OR") {
				if (sawPositive) pendingOr = true;
				else if (!addRequiredLiteral(token.op)) return compilePhraseContentSearchQuery(trimmed);
				continue;
			}
			if (token.op === "NOT") {
				if (sawPositive || hasPositiveFtsTerm) pendingNot = true;
				else if (!addRequiredLiteral(token.op)) return compilePhraseContentSearchQuery(trimmed);
				continue;
			}
			if (!sawPositive && !addRequiredLiteral(token.op)) return compilePhraseContentSearchQuery(trimmed);
			continue;
		}
		if (token.excluded && !hasPositiveFtsTerm) {
			if (!addRequiredLiteral(`-${token.text}`)) return compilePhraseContentSearchQuery(trimmed);
			continue;
		}
		if (pendingNot) {
			if (isTrigramSearchable(token.text)) exclusions.push(quoteFtsPhrase(token.text));
			else return compilePhraseContentSearchQuery(trimmed);
			pendingNot = false;
			pendingOr = false;
			continue;
		}
		if (token.excluded && hasPositiveFtsTerm) {
			if (isTrigramSearchable(token.text)) exclusions.push(quoteFtsPhrase(token.text));
			else return compilePhraseContentSearchQuery(trimmed);
			pendingOr = false;
			continue;
		}
		if (!addRequiredLiteral(token.text)) return compilePhraseContentSearchQuery(trimmed);
	}
	const nonEmptyClauses = clauses.filter((clause) => clause.length > 0);
	if (nonEmptyClauses.length === 0 && isTrigramSearchable(rankQuery)) return compilePhraseContentSearchQuery(trimmed);
	if (nonEmptyClauses.length === 0) return null;
	const positiveExpr = nonEmptyClauses.length === 1 ? nonEmptyClauses[0].join(" ") : `(${nonEmptyClauses.map((clause) => clause.join(" ")).join(" OR ")})`;
	return {
		matchQuery: exclusions.length === 0 ? positiveExpr : `${positiveExpr} ${exclusions.map((phrase) => `NOT ${phrase}`).join(" ")}`,
		rankQuery
	};
};
/** Escape SQLite LIKE metacharacters (`%`, `_`) and the escape char
*  itself in a value that must be matched literally inside a LIKE
*  pattern. Pairs with an explicit `ESCAPE '\'` clause on the SQL side
*  (we use backslash as the escape char). Without this a user-typed
*  `_` or `%` acts as a wildcard — `a_b` would match `axb`, and a bare
*  `%` filter would match every row. Bound `?` params already block SQL
*  injection; this only fixes LIKE-pattern semantics. */
var escapeLikePattern = (value) => value.replace(/[\\%_]/g, (c) => `\\${c}`);
/** Content search — case-insensitive trigram FTS substring match. */
var SELECT_BLOCKS_BY_CONTENT_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql("b")}
  FROM blocks_fts
  JOIN blocks b
    ON b.id = blocks_fts.block_id
   AND b.workspace_id = blocks_fts.workspace_id
  WHERE blocks_fts.workspace_id = ?
    AND blocks_fts MATCH ?
    AND b.deleted = 0
    AND b.content != ''
  ORDER BY
    CASE
      WHEN LOWER(b.content) = LOWER(?) THEN 0
      WHEN LOWER(b.content) LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END,
    coalesce(b.user_updated_at, b.updated_at) DESC
  LIMIT ?
`;
/** Recent non-empty blocks in a workspace, used by empty-query pickers. */
var SELECT_RECENT_BLOCKS_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
  ORDER BY coalesce(user_updated_at, updated_at) DESC, id ASC
  LIMIT ?
`;
/** Distinct alias values in a workspace, optionally substring-filtered.
*  Reads `block_aliases` (the trigger-maintained side index in
*  clientSchema.ts) instead of scanning `json_each(properties_json,
*  '$.alias')` per query. The case-insensitive filter rides
*  `idx_block_aliases_ws_alias_lower`; the case-preserving GROUP BY
*  collapses duplicate aliases that appear on multiple blocks. The
*  `MIN(b.created_at)` ordering keeps the historical "oldest-first"
*  sort even though the index itself doesn't carry timestamps. */
var SELECT_ALIASES_IN_WORKSPACE_SQL = `
  SELECT ba.alias AS alias
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND b.deleted = 0
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
  GROUP BY ba.alias
  ORDER BY
    MIN(CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END),
    MIN(b.created_at),
    ba.alias
`;
/** Single-block lookup by exact alias (used by createOrRestore wrappers
*  and call-site alias jumps). Returns the oldest match (deterministic
*  tie-break on workspaces with two blocks accidentally claiming the
*  same alias). Lookups go through `idx_block_aliases_ws_alias`; the
*  blocks JOIN reads the row by primary key. */
var SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql("blocks")}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`;
/** Variant of `SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL` that ignores
*  one specific block. Same plan as above with an extra `blocks.id !=
*  ?` predicate. Used exclusively by the same-tx collision-detection
*  path: when a row writes its own alias inside the user's tx, the
*  trigger-maintained index already contains that row by the time the
*  processor runs, so a plain "oldest claimant of alias X" would
*  return the row itself when it happens to be the oldest claimant —
*  silently missing collisions where the actual conflicting claimant
*  is younger. Excluding the attempting row fixes that. */
var SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql("blocks")}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.id != ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`;
/** Fuzzy alias-match pre-filter SQL builder. Token-AND prefix-substring
*  filter on `alias_lower` — the caller passes one LIKE pattern per
*  query token (typically the first 3 chars of each token, see
*  `buildFilterPrefixes` in fuzzyRank.ts). Permissive on purpose: the
*  final rank/keep decision happens in JS, where we score per-token
*  word-start / substring / edit-distance-1 plus recency. Returns the
*  user-facing stamp (`coalesce(user_updated_at, updated_at)`) so the JS
*  ranker can boost recently-edited rows.
*
*  Orders exact whole-query matches first, then prefix matches, before
*  applying `LIMIT`: the prefix is only 3 chars, so a single trigram can
*  match far more aliases than the over-fetch budget. Without this an
*  unordered LIMIT could evict the very alias the user typed verbatim
*  before the JS ranker (which rewards exact matches) ever sees it. The
*  full lowered query is bound for the exact/prefix comparisons; pass `''`
*  for the empty-query "browse all aliases" path (everything ties as a
*  prefix match and falls through to the deterministic created_at order).
*
*  Falls back to a workspace-scoped scan when `tokenCount === 0` (empty
*  query) so the same query handle can also serve the "browse all
*  aliases" path. */
var buildFuzzyAliasMatchesSql = (tokenCount) => {
	return `
    SELECT
      ba.alias AS alias,
      b.id AS blockId,
      b.content AS content,
      coalesce(b.user_updated_at, b.updated_at) AS updatedAt
    FROM block_aliases ba
    JOIN blocks b ON b.id = ba.block_id
    WHERE ba.workspace_id = ?
      AND b.deleted = 0
      AND (${tokenCount > 0 ? Array(tokenCount).fill(`ba.alias_lower LIKE '%' || ? || '%' ESCAPE '\\'`).join(" AND ") : "1=1"})
    ORDER BY
      CASE
        WHEN ba.alias_lower = ? THEN 0
        WHEN ba.alias_lower LIKE ? || '%' ESCAPE '\\' THEN 1
        ELSE 2
      END,
      b.created_at,
      ba.alias
    LIMIT ?
  `;
};
/** Alias substring match used by alias-search surfaces; one row per
*  (alias, block) pair. Same index plan as the distinct-aliases query
*  above: filter on alias_lower, JOIN blocks for content + ordering. */
var SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL = `
  SELECT
    ba.alias AS alias,
    b.id AS blockId,
    b.content AS content
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND b.deleted = 0
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
  ORDER BY
    CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END,
    b.created_at,
    ba.alias
  LIMIT ?
`;
/** First child of `parentId` whose content matches exactly. Tree-shape:
*  joins on `blocks.parent_id`, ordered by `(order_key, id)` so the
*  "first" tie-breaks deterministically. */
var SELECT_FIRST_CHILD_BY_CONTENT_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql("child")}
  FROM blocks AS child
  WHERE child.parent_id = ?
    AND child.deleted = 0
    AND child.content = ?
  ORDER BY child.order_key, child.id
  LIMIT 1
`;
/** Local cast: `BlockRow` has typed fields; `QueryCtx.hydrateBlocks`
*  takes the looser `Record<string, unknown>` shape so the api module
*  doesn't depend on the row schema. The cast is safe — `hydrateBlocks`
*  flows directly into `parseBlockRow` which expects `BlockRow`. */
var asBlockRows = (rows) => rows;
var blockDataArraySchema = { parse: (input) => input };
var stringArraySchema = { parse: (input) => input };
var numberSchema = { parse: (input) => input };
var blockDataOrNullSchema = { parse: (input) => input };
/** Subtree rooted at `id`, includeRoot=true (spec §11). Returns
*  {@link SubtreeRow}s — each block plus its `depth` relative to the root —
*  in pre-order, siblings by `(order_key, id)`. Identity-stable via the
*  dispatcher's handle-store key. Dep declaration mirrors the legacy
*  `repo.subtree(id)` factory in `repo.ts`. */
var subtreeQuery = defineQuery({
	name: "core.subtree",
	argsSchema: object({ id: string() }),
	resultSchema: { parse: (input) => input },
	resolve: async ({ id }, ctx) => {
		ctx.depend({
			kind: "row",
			id
		});
		ctx.depend({
			kind: "parent-edge",
			parentId: id
		});
		const rows = await ctx.db.getAll(SUBTREE_SQL, [id]);
		const withDepth = ctx.hydrateBlocks(asBlockRows(rows)).map((data, i) => ({
			...data,
			depth: rows[i].depth
		}));
		for (const data of withDepth) ctx.depend({
			kind: "parent-edge",
			parentId: data.id
		});
		return withDepth;
	}
});
/** Ancestor chain (excludes `id` itself). */
var ancestorsQuery = defineQuery({
	name: "core.ancestors",
	argsSchema: object({ id: string() }),
	resultSchema: blockDataArraySchema,
	resolve: async ({ id }, ctx) => {
		ctx.depend({
			kind: "row",
			id
		});
		const rows = await ctx.db.getAll(ANCESTORS_SQL, [id, id]);
		return ctx.hydrateBlocks(asBlockRows(rows));
	}
});
/** Batched ancestor walk. Returns one entry per input id, in input
*  order, with the leaf-to-root chain (depth-ascending) — same
*  ordering as the single-id `core.ancestors` query.
*
*  Use over N `core.ancestors` calls when a UI needs ancestors for
*  many ids known up front (e.g. a backlinks panel rendering N
*  source blocks each with breadcrumbs). One round-trip vs. N gives
*  a meaningful cold-start win when the SQLite connection is
*  contended. Empty entries are returned for ids whose row doesn't
*  exist or is soft-deleted, so consumers can map 1:1 over the input
*  list without nullable lookups. */
var manyAncestorsQuery = defineQuery({
	name: "core.manyAncestors",
	argsSchema: object({ ids: array(string()).readonly() }),
	resultSchema: { parse: (input) => input },
	resolve: async ({ ids }, ctx) => {
		if (ids.length === 0) return [];
		for (const id of ids) ctx.depend({
			kind: "row",
			id
		});
		const rows = await ctx.db.getAll(manyAncestorsSql(ids.length), [...ids]);
		const rowsByStart = /* @__PURE__ */ new Map();
		for (const id of ids) rowsByStart.set(id, []);
		for (const row of rows) {
			const list = rowsByStart.get(row.chain_start_id);
			if (list) list.push(row);
		}
		return ids.map((startId) => ({
			startId,
			ancestors: ctx.hydrateBlocks(asBlockRows(rowsByStart.get(startId) ?? []))
		}));
	}
});
/** Direct children of `id`, ordered `(order_key, id)`. */
var childrenQuery = defineQuery({
	name: "core.children",
	argsSchema: object({ id: string() }),
	resultSchema: blockDataArraySchema,
	resolve: async ({ id }, ctx) => {
		ctx.depend({
			kind: "parent-edge",
			parentId: id
		});
		const rows = await ctx.db.getAll(CHILDREN_SQL, [id]);
		return ctx.hydrateBlocks(asBlockRows(rows));
	}
});
/** Child-id list of `id` (lean shape). With `hydrate: true`, also runs
*  the full row SELECT and primes the cache — the consumer-facing
*  variant the React hooks use to avoid N+1 row loads on mount. */
var childIdsQuery = defineQuery({
	name: "core.childIds",
	argsSchema: object({
		id: string(),
		hydrate: boolean().optional()
	}),
	resultSchema: array(string()),
	resolve: async ({ id, hydrate = false }, ctx) => {
		ctx.depend({
			kind: "parent-edge",
			parentId: id
		});
		if (!hydrate) return (await ctx.db.getAll(CHILDREN_IDS_SQL, [id])).map((r) => r.id);
		const rows = await ctx.db.getAll(CHILDREN_SQL, [id]);
		return ctx.hydrateBlocks(asBlockRows(rows), { declareRowDeps: false }).map((d) => d.id);
	}
});
/** Live blocks in `workspaceId` whose `type` property equals `type`.
*  Membership reactivity rides the `typedBlocks.type` channel — fired
*  by the kernel invalidation rule when a block's `block_types` row for
*  `(workspaceId, type)` is inserted/removed (creation, restore,
*  type-add/remove, soft-delete). Per-row deps from `hydrateBlocks`
*  cover edits to currently-matched rows. */
var byTypeQuery = defineQuery({
	name: "core.byType",
	argsSchema: object({
		workspaceId: string(),
		type: string()
	}),
	resultSchema: blockDataArraySchema,
	resolve: async ({ workspaceId, type }, ctx) => {
		if (!workspaceId) return [];
		ctx.depend({
			kind: "plugin",
			channel: TYPED_BLOCKS_TYPE_CHANNEL,
			key: typedBlocksTypeKey(workspaceId, type)
		});
		const rows = await ctx.db.getAll(SELECT_BLOCKS_BY_TYPE_SQL, [workspaceId, type]);
		return ctx.hydrateBlocks(asBlockRows(rows));
	}
});
var typedBlocksArgsSchema = object({
	workspaceId: string(),
	types: array(string()).optional(),
	where: record(string(), unknown()).optional(),
	referencedBy: referenceFilterSchema.optional(),
	match: array(blockPredicateSchema).optional(),
	exclude: array(blockPredicateSchema).optional(),
	order: _enum(["created-asc", "created-desc"]).optional()
});
/** SQL that materializes every (block_id, anc_id) pair the typed query
*  considers when an ancestor-scoped predicate is present. Returns the
*  full set of ancestor ids touched so the resolver can register row
*  deps on them — content / property / parent_id changes on any
*  ancestor can flip membership and we need to wake. Mirrors the
*  ancestor_chain CTE the compiler emits, but materializes only the
*  candidate seed (no per-predicate filtering) since we want every
*  potentially-relevant ancestor in the dep set. */
var ANCESTOR_DEP_NODES_SQL = (candidatesCte) => `
  WITH RECURSIVE
    ${candidatesCte},
    walk(anc_id, anc_parent_id, depth, path) AS (
      SELECT seed.id, seed.parent_id, 0, '!' || hex(seed.id) || '/'
      FROM candidates c
      JOIN blocks seed ON seed.id = c.id
      WHERE seed.deleted = 0
      UNION ALL
      SELECT
        parent.id,
        parent.parent_id,
        walk.depth + 1,
        walk.path || '!' || hex(parent.id) || '/'
      FROM walk
      JOIN blocks parent ON parent.id = walk.anc_parent_id
      WHERE parent.deleted = 0
        AND walk.depth < 100
        AND INSTR(walk.path, '!' || hex(parent.id) || '/') = 0
    )
  SELECT DISTINCT anc_id FROM walk
`;
/** Subscribe to the property channels relevant to a single `where`
*  map — every direct key, plus the inner keys reached through any
*  `target` traversal. The inner keys live on other rows (the ref
*  targets), so changes there have to wake this query just like
*  changes to the source row's outer property would.
*
*  Live-channel rule for `target`: if the inner predicate has no
*  selective key (empty `target: {}`, `target: { x: null }`,
*  `target: { x: { exists: false } }`, or any combination of unset-
*  matching predicates), a fresh target-row insert that matches
*  won't fire any property channel — the row never set the property
*  the predicate names. Without subscribing to the live channel in
*  that case, the subscriber stays stale until an unrelated write
*  fires invalidations. Mirrors the top-level "live channel only
*  when no positive axis" gate. */
var collectWhereDeps = (where, workspaceId, ctx) => {
	if (where === void 0) return;
	for (const [name, value] of Object.entries(where)) {
		ctx.depend({
			kind: "plugin",
			channel: TYPED_BLOCKS_PROPERTY_CHANNEL,
			key: typedBlocksPropertyKey(workspaceId, name)
		});
		if (value === null || typeof value !== "object" || value instanceof Date || Array.isArray(value)) continue;
		const entries = Object.entries(value);
		if (entries.length !== 1) continue;
		const [op, operand] = entries[0];
		if (op !== "target") continue;
		if (operand === null || typeof operand !== "object" || Array.isArray(operand)) continue;
		const inner = operand;
		if (!Object.values(inner).some(isSelectiveWhereValue)) ctx.depend({
			kind: "plugin",
			channel: TYPED_BLOCKS_LIVE_CHANNEL,
			key: typedBlocksLiveKey(workspaceId)
		});
		collectWhereDeps(inner, workspaceId, ctx);
	}
};
var collectPredicateDeps = (predicates, workspaceId, ctx) => {
	for (const predicate of predicates) {
		collectWhereDeps(predicate.where, workspaceId, ctx);
		if (predicate.referencedBy !== void 0) {
			const ref = predicate.referencedBy;
			if (ref.sourceField !== void 0) ctx.depend({
				kind: "plugin",
				channel: TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
				key: typedBlocksReferenceFieldKey(workspaceId, ref.id, ref.sourceField)
			});
			else ctx.depend({
				kind: "plugin",
				channel: TYPED_BLOCKS_REFERENCE_CHANNEL,
				key: typedBlocksReferenceKey(workspaceId, ref.id)
			});
		}
	}
};
var collectTypedBlockAxisDeps = (normalized, ctx) => {
	const workspaceId = normalized.workspaceId;
	const types = normalized.types ?? [];
	const referencedBy = normalized.referencedBy;
	const matchPredicates = normalized.match ?? [];
	const excludePredicates = normalized.exclude ?? [];
	for (const t of types) ctx.depend({
		kind: "plugin",
		channel: TYPED_BLOCKS_TYPE_CHANNEL,
		key: typedBlocksTypeKey(workspaceId, t)
	});
	collectWhereDeps(normalized.where, workspaceId, ctx);
	if (referencedBy !== void 0) if (referencedBy.sourceField !== void 0) ctx.depend({
		kind: "plugin",
		channel: TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
		key: typedBlocksReferenceFieldKey(workspaceId, referencedBy.id, referencedBy.sourceField)
	});
	else ctx.depend({
		kind: "plugin",
		channel: TYPED_BLOCKS_REFERENCE_CHANNEL,
		key: typedBlocksReferenceKey(workspaceId, referencedBy.id)
	});
	collectPredicateDeps(matchPredicates, workspaceId, ctx);
	collectPredicateDeps(excludePredicates, workspaceId, ctx);
	const hasSelectiveWhere = Object.values(normalized.where ?? {}).some(isSelectiveWhereValue);
	const hasMatchAxis = matchPredicates.some((p) => p.referencedBy !== void 0 || p.where !== void 0 && Object.values(p.where).some(isSelectiveWhereValue));
	if (!(types.length > 0 || referencedBy !== void 0 || hasSelectiveWhere || hasMatchAxis)) ctx.depend({
		kind: "plugin",
		channel: TYPED_BLOCKS_LIVE_CHANNEL,
		key: typedBlocksLiveKey(workspaceId)
	});
	return {
		workspaceId,
		types,
		referencedBy,
		matchPredicates,
		excludePredicates
	};
};
var typedBlockNeedsAncestorChain = (matchPredicates, excludePredicates) => matchPredicates.some((p) => p.scope === "ancestor") || excludePredicates.some((p) => p.scope === "ancestor");
var declareAncestorDeps = async (normalized, ctx, kind) => {
	assertAncestorWalkBounded(normalized);
	const candidatesCte = buildCandidatesCte(normalized, ctx.repo.propertySchemas);
	const ancestorRows = await ctx.db.getAll(ANCESTOR_DEP_NODES_SQL(candidatesCte.sql), candidatesCte.params);
	for (const row of ancestorRows) if (kind === "row") ctx.depend({
		kind: "row",
		id: row.anc_id
	});
	else ctx.depend({
		kind: "plugin",
		channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
		key: typedBlocksStructureKey(normalized.workspaceId, row.anc_id)
	});
};
/** Resolve a typed block query against the given context. Used both
*  by `typedBlocksQuery` and by thin wrappers like `backlinksForBlockQuery`
*  that compose typed-query semantics — sharing this resolver keeps
*  the dep declarations and SQL in one place. */
var resolveTypedBlocks = async (query, ctx) => {
	if (!query.workspaceId) return [];
	const normalized = normalizeTypedBlockQuery(query);
	const { workspaceId, types, referencedBy, matchPredicates, excludePredicates } = collectTypedBlockAxisDeps(normalized, ctx);
	if (typedBlockNeedsAncestorChain(matchPredicates, excludePredicates)) await declareAncestorDeps(normalized, ctx, "row");
	if (types.length === 1 && normalized.where === void 0 && referencedBy === void 0 && matchPredicates.length === 0 && excludePredicates.length === 0 && normalized.order !== "created-desc") {
		const rows = await ctx.db.getAll(SELECT_BLOCKS_BY_TYPE_SQL, [workspaceId, types[0]]);
		return ctx.hydrateBlocks(asBlockRows(rows));
	}
	const compiled = compileTypedBlockQuery(normalized, ctx.repo.propertySchemas);
	const rows = await ctx.db.getAll(compiled.sql, [...compiled.params]);
	return ctx.hydrateBlocks(asBlockRows(rows));
};
/** Id projection for typed queries. Same typed-query semantics and
*  membership invalidation as `resolveTypedBlocks`, but it intentionally
*  avoids hydrating result rows, so content-only edits to current
*  members do not invalidate collection consumers. */
var resolveTypedBlockIds = async (query, ctx) => {
	if (!query.workspaceId) return [];
	const normalized = normalizeTypedBlockQuery(query);
	const { matchPredicates, excludePredicates } = collectTypedBlockAxisDeps(normalized, ctx);
	if (typedBlockNeedsAncestorChain(matchPredicates, excludePredicates)) await declareAncestorDeps(normalized, ctx, "structure");
	const compiled = compileTypedBlockQuery(normalized, ctx.repo.propertySchemas, { projection: "ids" });
	return (await ctx.db.getAll(compiled.sql, [...compiled.params])).map((row) => row.id);
};
/** SQLite-backed typed block query. Repo.queryBlocks / subscribeBlocks
*  default workspaceId before dispatching here; direct query callers
*  should pass workspaceId explicitly.
*
*  Reactivity (spec §9.2 + §9.4): each filter dimension contributes its
*  own narrow dep so the handle re-resolves only when something that
*  could flip membership actually changes:
*
*    - per `type` in `types`     → `typedBlocks.type` channel
*    - per name in `where`        → `typedBlocks.property` channel
*    - `referencedBy.id` (no field) → `typedBlocks.reference` channel
*    - `referencedBy.id + sourceField` → `typedBlocks.referenceField` channel
*    - per name in any `match`/`exclude` predicate's `where` → `typedBlocks.property`
*    - per `referencedBy` in any `match`/`exclude` predicate → reference channels
*    - any ancestor-scope predicate → row deps on every walked ancestor id
*    - no filter at all           → `typedBlocks.live` channel
*
*  Per-row deps from `hydrateBlocks` cover edits to rows already in the
*  result. The old `{kind:'workspace', workspaceId}` dep was too coarse
*  — UiState focus writes (and unrelated content edits) re-fired it
*  needlessly. */
var typedBlocksQuery = defineQuery({
	name: "core.typedBlocks",
	argsSchema: typedBlocksArgsSchema,
	resultSchema: blockDataArraySchema,
	resolve: (query, ctx) => resolveTypedBlocks(query, ctx)
});
var typedBlockIdsQuery = defineQuery({
	name: "core.typedBlockIds",
	argsSchema: typedBlocksArgsSchema,
	resultSchema: stringArraySchema,
	resolve: (query, ctx) => resolveTypedBlockIds(query, ctx)
});
/** Count projection for typed queries. Same membership semantics and
*  invalidation as `resolveTypedBlockIds` — it shares `collectTypedBlockAxisDeps`
*  and the compiler's candidate set — but aggregates to a single integer in
*  SQLite instead of marshalling the id list. Used by per-block count badges
*  (e.g. inline backlink counts) where only the cardinality is needed. */
var resolveTypedBlockCount = async (query, ctx) => {
	if (!query.workspaceId) return 0;
	const normalized = normalizeTypedBlockQuery(query);
	const { matchPredicates, excludePredicates } = collectTypedBlockAxisDeps(normalized, ctx);
	if (typedBlockNeedsAncestorChain(matchPredicates, excludePredicates)) await declareAncestorDeps(normalized, ctx, "structure");
	const compiled = compileTypedBlockQuery(normalized, ctx.repo.propertySchemas, { projection: "count" });
	return (await ctx.db.get(compiled.sql, [...compiled.params]))?.count ?? 0;
};
var typedBlockCountQuery = defineQuery({
	name: "core.typedBlockCount",
	argsSchema: typedBlocksArgsSchema,
	resultSchema: numberSchema,
	resolve: (query, ctx) => resolveTypedBlockCount(query, ctx)
});
/** Substring-match content search. Empty `query` returns []. */
var searchByContentQuery = defineQuery({
	name: "core.searchByContent",
	argsSchema: object({
		workspaceId: string(),
		query: string(),
		limit: number().optional()
	}),
	resultSchema: blockDataArraySchema,
	resolve: async ({ workspaceId, query, limit = 50 }, ctx) => {
		const compiledQuery = compileBlocksContentSearchQuery(query);
		if (compiledQuery === null) return [];
		ctx.depend({
			kind: "plugin",
			channel: KERNEL_CONTENT_CHANNEL,
			key: kernelContentKey(workspaceId)
		});
		const rows = await ctx.db.getAll(SELECT_BLOCKS_BY_CONTENT_SQL, [
			workspaceId,
			compiledQuery.matchQuery,
			compiledQuery.rankQuery,
			escapeLikePattern(compiledQuery.rankQuery),
			limit
		]);
		return ctx.hydrateBlocks(asBlockRows(rows), { declareRowDeps: false });
	}
});
/** Recent non-empty block candidates. Empty workspaceId returns []. */
var recentBlocksQuery = defineQuery({
	name: "core.recentBlocks",
	argsSchema: object({
		workspaceId: string(),
		limit: number().optional()
	}),
	resultSchema: blockDataArraySchema,
	resolve: async ({ workspaceId, limit = 50 }, ctx) => {
		if (!workspaceId) return [];
		ctx.depend({
			kind: "plugin",
			channel: KERNEL_CONTENT_CHANNEL,
			key: kernelContentKey(workspaceId)
		});
		const rows = await ctx.db.getAll(SELECT_RECENT_BLOCKS_SQL, [workspaceId, limit]);
		return ctx.hydrateBlocks(asBlockRows(rows), { declareRowDeps: false });
	}
});
/** First child of `parentId` whose content matches exactly. */
var firstChildByContentQuery = defineQuery({
	name: "core.firstChildByContent",
	argsSchema: object({
		parentId: string(),
		content: string()
	}),
	resultSchema: blockDataOrNullSchema,
	resolve: async ({ parentId, content }, ctx) => {
		ctx.depend({
			kind: "parent-edge",
			parentId
		});
		const children = await ctx.db.getAll(CHILDREN_IDS_SQL, [parentId]);
		for (const child of children) ctx.depend({
			kind: "row",
			id: child.id
		});
		const row = await ctx.db.getOptional(SELECT_FIRST_CHILD_BY_CONTENT_SQL, [parentId, content]);
		if (row === null) return null;
		return ctx.hydrateBlocks(asBlockRows([row]), { declareRowDeps: false })[0] ?? null;
	}
});
/** Distinct alias values in a workspace, optionally substring-filtered. */
var aliasesInWorkspaceQuery = defineQuery({
	name: "core.aliasesInWorkspace",
	argsSchema: object({
		workspaceId: string(),
		filter: string().optional()
	}),
	resultSchema: array(string()),
	resolve: async ({ workspaceId, filter = "" }, ctx) => {
		if (!workspaceId) return [];
		ctx.depend({
			kind: "plugin",
			channel: KERNEL_ALIASES_CHANNEL,
			key: kernelAliasesKey(workspaceId)
		});
		const escaped = escapeLikePattern(filter);
		return (await ctx.db.getAll(SELECT_ALIASES_IN_WORKSPACE_SQL, [
			workspaceId,
			filter,
			escaped,
			filter,
			escaped
		])).map((r) => r.alias);
	}
});
/** Alias autocomplete: one row per `(alias, blockId)` pair. */
var aliasMatchesQuery = defineQuery({
	name: "core.aliasMatches",
	argsSchema: object({
		workspaceId: string(),
		filter: string(),
		limit: number().optional()
	}),
	resultSchema: array(object({
		alias: string(),
		blockId: string(),
		content: string()
	})),
	resolve: async ({ workspaceId, filter, limit = 50 }, ctx) => {
		if (!workspaceId) return [];
		ctx.depend({
			kind: "plugin",
			channel: KERNEL_ALIASES_CHANNEL,
			key: kernelAliasesKey(workspaceId)
		});
		const escaped = escapeLikePattern(filter);
		const rows = await ctx.db.getAll(SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL, [
			workspaceId,
			filter,
			escaped,
			filter,
			escaped,
			limit
		]);
		for (const row of rows) ctx.depend({
			kind: "row",
			id: row.blockId
		});
		return rows;
	}
});
/** Fuzzy alias autocomplete pre-filter — token-AND prefix-substring
*  match. Returns a wider candidate set (caller chooses `limit`); the
*  fuzzy ranker in `fuzzyRank.ts` does the final scoring + ordering.
*  Empty `prefixes` returns every (alias, block) pair in the workspace
*  up to `limit`, suitable for the "browse all" path. */
var aliasMatchesFuzzyQuery = defineQuery({
	name: "core.aliasMatchesFuzzy",
	argsSchema: object({
		workspaceId: string(),
		prefixes: array(string()),
		query: string().optional(),
		limit: number().optional()
	}),
	resultSchema: array(object({
		alias: string(),
		blockId: string(),
		content: string(),
		updatedAt: number()
	})),
	resolve: async ({ workspaceId, prefixes, query = "", limit = 100 }, ctx) => {
		if (!workspaceId) return [];
		ctx.depend({
			kind: "plugin",
			channel: KERNEL_ALIASES_CHANNEL,
			key: kernelAliasesKey(workspaceId)
		});
		const sql = buildFuzzyAliasMatchesSql(prefixes.length);
		const queryLower = query.toLowerCase();
		const params = [
			workspaceId,
			...prefixes.map(escapeLikePattern),
			queryLower,
			escapeLikePattern(queryLower),
			limit
		];
		const rows = await ctx.db.getAll(sql, params);
		for (const row of rows) ctx.depend({
			kind: "row",
			id: row.blockId
		});
		return rows;
	}
});
/** Single-block lookup by exact alias in a workspace. */
var aliasLookupQuery = defineQuery({
	name: "core.aliasLookup",
	argsSchema: object({
		workspaceId: string(),
		alias: string()
	}),
	resultSchema: blockDataOrNullSchema,
	resolve: async ({ workspaceId, alias }, ctx) => {
		if (!workspaceId || !alias) return null;
		ctx.depend({
			kind: "plugin",
			channel: KERNEL_ALIASES_CHANNEL,
			key: kernelAliasesKey(workspaceId)
		});
		const row = await ctx.db.getOptional(SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL, [workspaceId, alias]);
		if (row === null) return null;
		return ctx.hydrateBlocks(asBlockRows([row]))[0] ?? null;
	}
});
/** Workspace's `type: 'extension'` blocks (spec §8 Stage 2 — Phase 4
*  switches `dynamicExtensionsExtension` from the legacy `byType` call
*  to this dedicated query). Mechanically `byType('extension')`; lives
*  as its own kernel query so callers can register against a stable
*  name without depending on the convention.
*
*  No reactive dep: the only consumer (AppRuntimeProvider) calls
*  `.load()` once at FacetRuntime build time and feeds the result into
*  `resolveFacetRuntime`. Nothing observes the handle after that, so a
*  `workspace` dep would just churn the loader on every workspace write
*  without changing any observable behavior — installing or removing
*  an extension is picked up via the `refresh_extensions` command
*  (`Reload extensions` in the palette / `defaultShortcuts.ts`), which
*  re-runs `dynamicExtensionsExtension` and re-calls
*  `repo.setFacetRuntime`. */
var findExtensionBlocksQuery = defineQuery({
	name: "core.findExtensionBlocks",
	argsSchema: object({ workspaceId: string() }),
	resultSchema: blockDataArraySchema,
	resolve: async ({ workspaceId }, ctx) => {
		if (!workspaceId) return [];
		const rows = await ctx.db.getAll(SELECT_BLOCKS_BY_TYPE_SQL, [workspaceId, "extension"]);
		return ctx.hydrateBlocks(asBlockRows(rows));
	}
});
/** All kernel queries — contributed to the FacetRuntime via
*  `kernelDataExtension`, which the Repo installs at construction
*  (`installKernelRuntime`, default true) and every `setFacetRuntime`
*  swap re-merges. */
var KERNEL_QUERIES = [
	subtreeQuery,
	ancestorsQuery,
	manyAncestorsQuery,
	childrenQuery,
	childIdsQuery,
	byTypeQuery,
	typedBlocksQuery,
	typedBlockIdsQuery,
	typedBlockCountQuery,
	searchByContentQuery,
	recentBlocksQuery,
	firstChildByContentQuery,
	aliasesInWorkspaceQuery,
	aliasMatchesQuery,
	aliasMatchesFuzzyQuery,
	aliasLookupQuery,
	findExtensionBlocksQuery
];
//#endregion
export { KERNEL_QUERIES, SELECT_ALIASES_IN_WORKSPACE_SQL, SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL, SELECT_BLOCKS_BY_CONTENT_SQL, SELECT_BLOCKS_BY_TYPE_SQL, SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL, SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL, SELECT_BLOCK_BY_ID_SQL, SELECT_FIRST_CHILD_BY_CONTENT_SQL, SELECT_RECENT_BLOCKS_SQL, aliasLookupQuery, aliasMatchesFuzzyQuery, aliasMatchesQuery, aliasesInWorkspaceQuery, ancestorsQuery, buildFuzzyAliasMatchesSql, byTypeQuery, childIdsQuery, childrenQuery, compileBlocksContentSearchQuery, findExtensionBlocksQuery, firstChildByContentQuery, manyAncestorsQuery, recentBlocksQuery, resolveTypedBlockCount, resolveTypedBlockIds, resolveTypedBlocks, searchByContentQuery, subtreeQuery, typedBlockCountQuery, typedBlockIdsQuery, typedBlocksQuery };

//# sourceMappingURL=kernelQueries.js.map