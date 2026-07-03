import { isRefCodec, isRefListCodec } from "../api/codecs.js";
import "../api/index.js";
import { buildQualifiedBlockColumnsSql } from "../blockSchema.js";
//#region src/data/internals/typedBlockQuery.ts
var jsonPathForProperty = (name) => `$."${name.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
/** Inline a JSON path as a SQL string literal — needed so SQLite's
*  query planner can match expression indexes. SQLite only treats
*  `json_extract(col, '$.foo')` and `idx ON (json_extract(col, '$.foo'))`
*  as the same indexable expression when the path appears literally;
*  if the path is bound via `?` the planner sees `json_extract(col, ?)`
*  and falls back to a table scan. Property names are registered via
*  trusted facets, but the literal still gets standard `''`-escaping
*  defensively so a name containing a single quote can't break the
*  surrounding SQL. */
var inlineJsonPath = (name) => {
	return `'${jsonPathForProperty(name).replaceAll("'", "''")}'`;
};
var ALL_OPERATORS = new Set([
	...new Set([
		"eq",
		"lt",
		"lte",
		"gt",
		"gte"
	]),
	"between",
	"exists",
	"target"
]);
var COMPARATOR_SQL = {
	eq: "=",
	lt: "<",
	lte: "<=",
	gt: ">",
	gte: ">="
};
var isPlainOperatorObject = (value) => typeof value === "object" && value !== null && !(value instanceof Date) && !Array.isArray(value);
/** Normalize a `where[name]` value to the discriminated `ParsedWhere`
*  shape. Throws on malformed inputs (multiple operator keys, unknown
*  operator, `between` not a 2-tuple, `exists` not a boolean). */
var parseWhereValue = (name, value) => {
	if (value === null) return { kind: "unset" };
	if (!isPlainOperatorObject(value)) return {
		kind: "comparator",
		op: "eq",
		operand: value
	};
	const entries = Object.entries(value).filter(([k]) => k !== void 0);
	if (entries.length !== 1) throw new Error(`[queryBlocks] where.${name} operator object must have exactly one key; got ${entries.length} (combine via separate match/exclude predicates instead)`);
	const [op, operand] = entries[0];
	if (!ALL_OPERATORS.has(op)) throw new Error(`[queryBlocks] where.${name} unknown operator ${JSON.stringify(op)}; supported: ${[...ALL_OPERATORS].join(", ")}`);
	if (op === "exists") {
		if (typeof operand !== "boolean") throw new Error(`[queryBlocks] where.${name}.exists must be a boolean; got ${typeof operand}`);
		return operand ? { kind: "set" } : { kind: "unset" };
	}
	if (op === "between") {
		if (!Array.isArray(operand) || operand.length !== 2) throw new Error(`[queryBlocks] where.${name}.between must be a [lo, hi] tuple`);
		return {
			kind: "between",
			lo: operand[0],
			hi: operand[1]
		};
	}
	if (op === "target") {
		if (!isPlainOperatorObject(operand)) throw new Error(`[queryBlocks] where.${name}.target must be a where-map object`);
		return {
			kind: "target",
			inner: operand
		};
	}
	return {
		kind: "comparator",
		op,
		operand
	};
};
var encodeForWhere = (name, schema, value) => {
	if (!schema.codec.where) throw new Error(`[queryBlocks] where.${name} is not where-queryable; codec type ${JSON.stringify(schema.codec.type)} doesn't support comparison predicates (use referencedBy for refs, or add a dedicated query for collection/object filters)`);
	try {
		return schema.codec.where.encode(value);
	} catch (err) {
		throw new Error(`[queryBlocks] where.${name} value is not a valid ${schema.codec.type}: ${err.message}`, { cause: err });
	}
};
var compileTargetTraversal = (name, inner, schema, jsonExpr, propertySchemas, aliasCounter) => {
	const isRef = isRefCodec(schema.codec);
	const isRefList = isRefListCodec(schema.codec);
	if (!isRef && !isRefList) throw new Error(`[queryBlocks] where.${name}.target is only valid on ref / refList properties; ${JSON.stringify(name)} has codec type ${JSON.stringify(schema.codec.type)}`);
	const alias = `d${aliasCounter.n++}`;
	const refExtract = `json_extract(${jsonExpr}, ${inlineJsonPath(name)})`;
	const innerEntries = Object.entries(inner).sort(([a], [b]) => a.localeCompare(b));
	const innerClauses = [];
	const innerParams = [];
	for (const [innerName, innerValue] of innerEntries) {
		const compiled = compileWhereClause(innerName, innerValue, propertySchemas.get(innerName), `${alias}.properties_json`, propertySchemas, aliasCounter);
		innerClauses.push(compiled.sql);
		innerParams.push(...compiled.params);
	}
	const inWhere = innerClauses.length === 0 ? "" : ` AND ${innerClauses.join(" AND ")}`;
	if (isRef) return {
		sql: `EXISTS (SELECT 1 FROM blocks ${alias} WHERE ${alias}.id = ${refExtract} AND ${alias}.deleted = 0${inWhere})`,
		params: innerParams
	};
	return {
		sql: `EXISTS (SELECT 1 FROM json_each(${refExtract}) AS je JOIN blocks ${alias} ON ${alias}.id = je.value WHERE ${alias}.deleted = 0${inWhere})`,
		params: innerParams
	};
};
var compileWhereClause = (name, value, schema, jsonExpr, propertySchemas, aliasCounter = { n: 0 }) => {
	if (value === void 0) throw new Error(`[queryBlocks] where.${name} is undefined; pass null to match unset values`);
	if (schema === void 0) throw new Error(`[queryBlocks] where.${name} has no registered PropertySchema`);
	const extract = `json_extract(${jsonExpr}, ${inlineJsonPath(name)})`;
	const parsed = parseWhereValue(name, value);
	if (parsed.kind === "unset") return {
		sql: `${extract} IS NULL`,
		params: []
	};
	if (parsed.kind === "set") return {
		sql: `${extract} IS NOT NULL`,
		params: []
	};
	if (parsed.kind === "target") return compileTargetTraversal(name, parsed.inner, schema, jsonExpr, propertySchemas, aliasCounter);
	if (parsed.kind === "between") {
		const lo = encodeForWhere(name, schema, parsed.lo);
		const hi = encodeForWhere(name, schema, parsed.hi);
		return {
			sql: `${extract} BETWEEN ? AND ?`,
			params: [lo, hi]
		};
	}
	const operand = encodeForWhere(name, schema, parsed.operand);
	return {
		sql: `${extract} ${COMPARATOR_SQL[parsed.op]} ?`,
		params: [operand]
	};
};
var compileReferencedByExists = (ref, sourceIdExpr) => {
	const refClauses = [`br.source_id = ${sourceIdExpr}`, "br.target_id = ?"];
	const params = [ref.id];
	if (ref.sourceField !== void 0) {
		refClauses.push("br.source_field = ?");
		params.push(ref.sourceField);
	}
	return {
		sql: `EXISTS (SELECT 1 FROM block_references br WHERE ${refClauses.join(" AND ")})`,
		params
	};
};
var compilePredicateAgainstRow = (predicate, rowAlias, propertySchemas) => {
	const clauses = [];
	const params = [];
	const propsExpr = `${rowAlias}.properties_json`;
	if (predicate.id !== void 0) {
		clauses.push(`${rowAlias}.id = ?`);
		params.push(predicate.id);
	}
	if (predicate.where !== void 0) for (const [name, value] of Object.entries(predicate.where).sort(([a], [b]) => a.localeCompare(b))) {
		const compiled = compileWhereClause(name, value, propertySchemas.get(name), propsExpr, propertySchemas);
		clauses.push(compiled.sql);
		params.push(...compiled.params);
	}
	if (predicate.referencedBy !== void 0) {
		const compiled = compileReferencedByExists(predicate.referencedBy, `${rowAlias}.id`);
		clauses.push(compiled.sql);
		params.push(...compiled.params);
	}
	return {
		sql: clauses.length === 0 ? "1" : clauses.join(" AND "),
		params
	};
};
/** Compile a predicate against the result block `b` directly (self
*  scope) or as an EXISTS over the ancestor_chain CTE rows that share
*  `block_id = b.id` (ancestor scope, includes b itself).
*
*  Page-as-tag: in ancestor scope, a `referencedBy:{id:X}` sub-clause
*  also matches when the root ancestor's own id IS X — Roam treats a
*  page as an implicit reference target for every block it contains.
*  Filtering by a page name should match blocks living on that page
*  even when no ancestor sources an explicit reference. Pre-unification
*  SQL encoded this by UNIONing the root ancestor's id into the
*  context set; `sourceField` predicates target a specific reference
*  channel and stay strict (the page-is-itself case has no channel). */
var compileScopedPredicate = (predicate, propertySchemas) => {
	if ((predicate.scope ?? "self") === "self") return compilePredicateAgainstRow(predicate, "b", propertySchemas);
	const clauses = [];
	const params = [];
	if (predicate.id !== void 0) {
		clauses.push("anc.id = ?");
		params.push(predicate.id);
	}
	if (predicate.where !== void 0) for (const [name, value] of Object.entries(predicate.where).sort(([a], [b]) => a.localeCompare(b))) {
		const compiled = compileWhereClause(name, value, propertySchemas.get(name), "anc.properties_json", propertySchemas);
		clauses.push(compiled.sql);
		params.push(...compiled.params);
	}
	if (predicate.referencedBy !== void 0) {
		const refExists = compileReferencedByExists(predicate.referencedBy, "anc.id");
		if (predicate.referencedBy.sourceField === void 0) {
			clauses.push(`(${refExists.sql} OR (ac.anc_parent_id IS NULL AND anc.id = ?))`);
			params.push(...refExists.params, predicate.referencedBy.id);
		} else {
			clauses.push(refExists.sql);
			params.push(...refExists.params);
		}
	}
	return {
		sql: `EXISTS (
      SELECT 1 FROM ancestor_chain ac
      JOIN blocks anc ON anc.id = ac.anc_id
      WHERE ac.block_id = b.id AND ${clauses.length === 0 ? "1" : clauses.join(" AND ")}
    )`,
		params
	};
};
var dedupePredicates = (predicates) => {
	if (!predicates) return [];
	return predicates.filter((p) => {
		const hasWhere = p.where !== void 0 && Object.keys(p.where).length > 0;
		const hasRef = p.referencedBy !== void 0;
		const hasId = p.id !== void 0;
		return hasWhere || hasRef || hasId;
	});
};
var normalizeTypedBlockQuery = (query) => ({
	workspaceId: query.workspaceId,
	types: query.types === void 0 ? void 0 : Array.from(new Set(query.types.map((type) => type.trim()).filter(Boolean))).sort(),
	where: query.where,
	referencedBy: query.referencedBy,
	match: dedupePredicates(query.match),
	exclude: dedupePredicates(query.exclude),
	order: query.order
});
var hasAncestorScope = (predicates) => predicates.some((p) => p.scope === "ancestor");
var isSelfScope = (predicate) => (predicate.scope ?? "self") === "self";
/** Does this `where[name]` value narrow the candidate set, or does
*  it only match rows lacking the property? `null` and the operator
*  form `{exists: false}` are semantic duplicates — both compile to
*  `IS NULL` — so both have to be classified as non-selective; if
*  only one were, ancestor-gate and dep-wiring decisions would drift
*  based on which shorthand the caller happened to use. */
var isSelectiveWhereValue = (value) => {
	if (value === null) return false;
	if (typeof value !== "object" || value instanceof Date || Array.isArray(value)) return true;
	const entries = Object.entries(value);
	if (entries.length !== 1) return true;
	const [op, operand] = entries[0];
	return !(op === "exists" && operand === false);
};
var hasNonNullWhere = (where) => where !== void 0 && Object.values(where).some(isSelectiveWhereValue);
/** Does this self-scope predicate actually bound the candidate set
*  (vs. just match-anything)? Used by the ancestor-walk safety gate
*  — a predicate that matches every row provides no candidate
*  bounding even though it's "set". */
var selfPredicateNarrows = (predicate) => predicate.id !== void 0 || predicate.referencedBy !== void 0 || hasNonNullWhere(predicate.where);
/** Ancestor-scope predicates require at least one candidate-bounding
*  filter; otherwise the recursive walk seeds from every live block
*  in the workspace. Throw before the walk runs — callers that
*  pre-fetch ancestor dep nodes (e.g. `resolveTypedBlocks`) call this
*  before issuing the dep SQL so an invalid query doesn't trigger
*  exactly the expensive walk the gate is meant to prevent. */
var assertAncestorWalkBounded = (query) => {
	const matchPredicates = query.match ?? [];
	const excludePredicates = query.exclude ?? [];
	if (!(hasAncestorScope(matchPredicates) || hasAncestorScope(excludePredicates))) return;
	const types = query.types ?? [];
	if (!(query.referencedBy !== void 0 || types.length > 0 || hasNonNullWhere(query.where) || matchPredicates.some((p) => isSelfScope(p) && selfPredicateNarrows(p)))) throw new Error("[queryBlocks] ancestor-scoped predicates require at least one candidate filter (types, referencedBy, or a non-null self where / match predicate) to bound the recursive walk");
};
/** Build the `candidates AS (...)` CTE body that selects the
*  fully self-filtered result set for a typed-block query. Shared
*  between the main SQL compiler and the ancestor-dep seed walk in
*  `resolveTypedBlocks` so both observe the SAME candidate set —
*  the row-dep declarations stay scoped to rows that actually feed
*  into the result. */
var buildCandidatesCte = (query, propertySchemas) => {
	const normalized = normalizeTypedBlockQuery(query);
	const types = normalized.types ?? [];
	const matchPredicates = normalized.match ?? [];
	const excludePredicates = normalized.exclude ?? [];
	const params = [];
	const clauses = [];
	let from;
	if (normalized.referencedBy !== void 0) {
		from = `
      FROM block_references br
      JOIN blocks b ON b.id = br.source_id
    `.trim();
		clauses.push("br.workspace_id = ?", "br.target_id = ?", "b.deleted = 0");
		params.push(normalized.workspaceId, normalized.referencedBy.id);
		if (normalized.referencedBy.sourceField !== void 0) {
			clauses.push("br.source_field = ?");
			params.push(normalized.referencedBy.sourceField);
		}
	} else {
		from = "FROM blocks b";
		clauses.push("b.workspace_id = ?", "b.deleted = 0");
		params.push(normalized.workspaceId);
	}
	if (types.length > 0) {
		clauses.push(`
      EXISTS (
        SELECT 1
        FROM block_types bt
        WHERE bt.block_id = b.id
          AND bt.workspace_id = b.workspace_id
          AND bt.type IN (${types.map(() => "?").join(", ")})
      )
    `.trim());
		params.push(...types);
	}
	if (normalized.where !== void 0) for (const [name, value] of Object.entries(normalized.where).sort(([a], [b]) => a.localeCompare(b))) {
		const compiled = compileWhereClause(name, value, propertySchemas.get(name), "b.properties_json", propertySchemas);
		clauses.push(compiled.sql);
		params.push(...compiled.params);
	}
	for (const predicate of matchPredicates) {
		if (!isSelfScope(predicate)) continue;
		const compiled = compilePredicateAgainstRow(predicate, "b", propertySchemas);
		clauses.push(compiled.sql);
		params.push(...compiled.params);
	}
	for (const predicate of excludePredicates) {
		if (!isSelfScope(predicate)) continue;
		const compiled = compilePredicateAgainstRow(predicate, "b", propertySchemas);
		clauses.push(`(${compiled.sql}) IS NOT TRUE`);
		params.push(...compiled.params);
	}
	return {
		sql: `candidates AS (
      SELECT DISTINCT b.id
      ${from}
      WHERE ${clauses.join("\n        AND ")}
    )`,
		params
	};
};
/** Recursive ancestor-chain CTE keyed off `candidates`. One row per
*  (candidate id, ancestor id), with depth and a path guard against
*  cycles. Hard depth cap of 100 mirrors the existing backlinks SQL. */
var ANCESTOR_CHAIN_CTE_SQL = `
  ancestor_chain(block_id, anc_id, anc_parent_id, depth, path) AS (
    SELECT c.id, seed.id, seed.parent_id, 0, '!' || hex(seed.id) || '/'
    FROM candidates c
    JOIN blocks seed ON seed.id = c.id
    WHERE seed.deleted = 0
    UNION ALL
    SELECT
      ancestor_chain.block_id,
      parent.id,
      parent.parent_id,
      ancestor_chain.depth + 1,
      ancestor_chain.path || '!' || hex(parent.id) || '/'
    FROM ancestor_chain
    JOIN blocks parent ON parent.id = ancestor_chain.anc_parent_id
    WHERE parent.deleted = 0
      AND ancestor_chain.depth < 100
      AND INSTR(ancestor_chain.path, '!' || hex(parent.id) || '/') = 0
  )
`.trim();
var compileTypedBlockQuery = (query, propertySchemas, opts = {}) => {
	const normalized = normalizeTypedBlockQuery(query);
	const matchPredicates = normalized.match ?? [];
	const excludePredicates = normalized.exclude ?? [];
	const needsAncestorChain = hasAncestorScope(matchPredicates) || hasAncestorScope(excludePredicates);
	assertAncestorWalkBounded(normalized);
	const candidatesCte = buildCandidatesCte(normalized, propertySchemas);
	const params = [...candidatesCte.params];
	const filterClauses = [];
	for (const predicate of matchPredicates) {
		if (isSelfScope(predicate)) continue;
		const compiled = compileScopedPredicate(predicate, propertySchemas);
		filterClauses.push(compiled.sql);
		params.push(...compiled.params);
	}
	for (const predicate of excludePredicates) {
		if (isSelfScope(predicate)) continue;
		const compiled = compileScopedPredicate(predicate, propertySchemas);
		filterClauses.push(`(${compiled.sql}) IS NOT TRUE`);
		params.push(...compiled.params);
	}
	const ctes = needsAncestorChain ? `WITH RECURSIVE ${candidatesCte.sql}, ${ANCESTOR_CHAIN_CTE_SQL}` : `WITH ${candidatesCte.sql}`;
	const isCount = opts.projection === "count";
	const selectClause = isCount ? "COUNT(*) AS count" : opts.projection === "ids" ? "b.id AS id" : buildQualifiedBlockColumnsSql("b");
	const orderClause = isCount ? "" : normalized.order === "created-desc" ? "ORDER BY b.created_at DESC, b.id" : "ORDER BY b.created_at ASC, b.id ASC";
	return {
		sql: `
    ${ctes}
    SELECT ${selectClause}
    FROM candidates c
    JOIN blocks b ON b.id = c.id
    ${filterClauses.length > 0 ? `WHERE ${filterClauses.join("\n      AND ")}` : ""}
    ${orderClause}
  `,
		params
	};
};
//#endregion
export { assertAncestorWalkBounded, buildCandidatesCte, compileTypedBlockQuery, hasAncestorScope, isSelectiveWhereValue, jsonPathForProperty, normalizeTypedBlockQuery };

//# sourceMappingURL=typedBlockQuery.js.map