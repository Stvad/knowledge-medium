import {
  isRefCodec,
  isRefListCodec,
  type AnyPropertySchema,
  type BlockPredicate,
  type ResolvedTypedBlockQuery,
  type TypedBlockQueryReferenceFilter,
  type WhereStorage,
  type WhereValue,
} from '@/data/api'
import type { QueryableField } from '@/data/facets'
import { buildQualifiedBlockColumnsSql } from '@/data/blockSchema'

import { recognizedFieldRowSql, NO_REGISTRY_RECOGNITION_PARAMS, type RecognitionParams } from './treeQueries'

/** The `'none'` view's clause: a recognized field row, or a value row — a
 *  DIRECT child of one. A block nested under a value row is ordinary content
 *  and stays, where `core.subtree`'s `'none'` prunes the whole branch: that
 *  one answers what an outline draws, this one what counts as note text.
 *  Binds {@link RecognitionParams} twice. */
export const NOT_PROPERTY_ROW_SQL = `
    NOT (${recognizedFieldRowSql('b')})
    AND NOT EXISTS (
      SELECT 1 FROM blocks field_row
       WHERE field_row.id = b.parent_id
         AND field_row.workspace_id = b.workspace_id
         AND (${recognizedFieldRowSql('field_row')})
    )
`

type Fields = ReadonlyMap<string, QueryableField>
export interface WhereContext {
  readonly properties: ReadonlyMap<string, AnyPropertySchema>
  readonly fields?: Fields
}

export interface CompiledTypedBlockQuery {
  readonly sql: string
  readonly params: readonly unknown[]
}

export type TypedBlockQueryProjection = 'rows' | 'ids' | 'count'

declare const jsonPathBrand: unique symbol

/** A JSON path built by {@link jsonPathForProperty}. Branded so it cannot be
 *  passed back in where a property NAME belongs — see the parameter type
 *  below. */
export type JsonPath = string & { readonly [jsonPathBrand]: 'json-path' }

/** A property name: any plain string, but NOT an already-derived {@link
 *  JsonPath}. The optional `never`-typed brand is what expresses that — a plain
 *  string has no such property and satisfies it, while a `JsonPath` carries one
 *  typed `'json-path'`, which is not assignable to `never`.
 *
 *  Costs nothing at a declaration site and catches the one mistake these two
 *  types invite: double-encoding. A path passed where a name belongs derives
 *  `$."$.\"foo\""`, which addresses a property nothing writes — so the query
 *  is valid, returns no rows, and the feature reads as empty rather than
 *  broken. */
export type PropertyName = string & { readonly [jsonPathBrand]?: never }

export const jsonPathForProperty = (name: PropertyName): JsonPath =>
  `$."${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` as JsonPath

/** Inline a JSON path as a SQL string literal — needed so SQLite's
 *  query planner can match expression indexes. SQLite only treats
 *  `json_extract(col, '$.foo')` and `idx ON (json_extract(col, '$.foo'))`
 *  as the same indexable expression when the path appears literally;
 *  if the path is bound via `?` the planner sees `json_extract(col, ?)`
 *  and falls back to a table scan. Property names are registered via
 *  trusted facets, but the literal still gets standard `''`-escaping
 *  defensively so a name containing a single quote can't break the
 *  surrounding SQL. */
export const inlineJsonPath = (name: string): string => {
  const path = jsonPathForProperty(name)
  return `'${path.replaceAll("'", "''")}'`
}

/** `json_each` over the refList cell `name` of `rowAlias`, one row per member
 *  in `value`. A cell that is not a JSON array names no targets, as in
 *  `decodeRefListIds` — a `ref` → `refList` re-type leaves plain strings behind
 *  (an accepted residual of `propertyDefinitionChangeProcessor`), and a bare
 *  `json_each` over one throws `malformed JSON` for the whole query. */
export const listMembersSql = (rowAlias: string, name: string): string => {
  const cell = `${rowAlias}.properties_json, ${inlineJsonPath(name)}`
  return `json_each(CASE WHEN json_type(${cell}) = 'array' THEN json_extract(${cell}) END)`
}

interface CompiledClause {
  readonly sql: string
  readonly params: readonly unknown[]
}

/** Operator names recognised inside `where[name]` object values.
 *  Mirrors `WhereOperator` in `src/data/api/typedBlockQuery.ts`. */
const COMPARATOR_OPERATORS = new Set(['eq', 'lt', 'lte', 'gt', 'gte'])
const ALL_OPERATORS = new Set([...COMPARATOR_OPERATORS, 'between', 'exists', 'target', 'contains'])

/** A scalar `where` value goes through `codec.where.encode` and lands
 *  in one of the comparator operators below; an object becomes an
 *  operator dispatch; a `null` short-circuits to `IS NULL`. */
type ParsedWhere =
  | { readonly kind: 'unset' }              // legacy null shorthand
  | { readonly kind: 'set' }                // exists: true
  | { readonly kind: 'comparator'; readonly op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'; readonly operand: unknown }
  | { readonly kind: 'contains'; readonly operand: unknown }
  | { readonly kind: 'between'; readonly lo: unknown; readonly hi: unknown }
  | { readonly kind: 'target'; readonly inner: Readonly<Record<string, unknown>> }

const COMPARATOR_SQL: Readonly<Record<'eq' | 'lt' | 'lte' | 'gt' | 'gte', string>> = {
  eq: '=', lt: '<', lte: '<=', gt: '>', gte: '>=',
}

const isPlainOperatorObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !(value instanceof Date) && !Array.isArray(value)

/** Normalize a `where[name]` value to the discriminated `ParsedWhere`
 *  shape. Throws on malformed inputs (multiple operator keys, unknown
 *  operator, `between` not a 2-tuple, `exists` not a boolean). */
const parseWhereValue = (name: string, value: unknown): ParsedWhere => {
  if (value === null) return {kind: 'unset'}
  if (!isPlainOperatorObject(value)) {
    return {kind: 'comparator', op: 'eq', operand: value}
  }
  const entries = Object.entries(value).filter(([k]) => k !== undefined)
  if (entries.length !== 1) {
    throw new Error(
      `[queryBlocks] where.${name} operator object must have exactly one key; got ${entries.length} ` +
      `(combine via separate match/exclude predicates instead)`,
    )
  }
  const [op, operand] = entries[0]!
  if (!ALL_OPERATORS.has(op)) {
    throw new Error(
      `[queryBlocks] where.${name} unknown operator ${JSON.stringify(op)}; ` +
      `supported: ${[...ALL_OPERATORS].join(', ')}`,
    )
  }
  if (op === 'contains') return {kind: 'contains', operand}
  if (op === 'exists') {
    if (typeof operand !== 'boolean') {
      throw new Error(`[queryBlocks] where.${name}.exists must be a boolean; got ${typeof operand}`)
    }
    return operand ? {kind: 'set'} : {kind: 'unset'}
  }
  if (op === 'between') {
    if (!Array.isArray(operand) || operand.length !== 2) {
      throw new Error(`[queryBlocks] where.${name}.between must be a [lo, hi] tuple`)
    }
    return {kind: 'between', lo: operand[0], hi: operand[1]}
  }
  if (op === 'target') {
    if (!isPlainOperatorObject(operand)) {
      throw new Error(`[queryBlocks] where.${name}.target must be a where-map object`)
    }
    return {kind: 'target', inner: operand}
  }
  return {kind: 'comparator', op: op as 'eq' | 'lt' | 'lte' | 'gt' | 'gte', operand}
}

const ISO_DATE_GLOB =
  "'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'"

/** SQL that holds only for a cell of `storage`'s shape, given the cell's
 *  `properties_json, path` argument pair. A comparator ANDs it onto the
 *  comparison, which on its own orders a cell of any shape against the
 *  operand — see `WhereStorage`. */
const STORAGE_TEST: Readonly<Record<WhereStorage, (cell: string) => string>> = {
  text: cell => `json_type(${cell}) = 'text'`,
  number: cell => `json_type(${cell}) IN ('integer', 'real')`,
  boolean: cell => `json_type(${cell}) IN ('true', 'false')`,
  // No `json_type` needed: anything but a JSON string extracts as a number or
  // as JSON text opening with `[` / `{`, and none of those fit the pattern.
  // The byte length because GLOB stops at an embedded NUL, so
  // `…000Z\u0000junk` fits on its prefix while `<` / `>` read the bytes past it.
  'iso-date': cell =>
    `json_extract(${cell}) GLOB ${ISO_DATE_GLOB} AND length(CAST(json_extract(${cell}) AS BLOB)) = 24`,
}

interface Comparable {
  /** {@link STORAGE_TEST} for this cell. */
  readonly test: string
  readonly encode: (value: unknown) => WhereValue
}

const comparableCell = (name: string, schema: AnyPropertySchema, cell: string): Comparable => {
  const where = schema.codec.where
  if (!where) {
    throw new Error(
      `[queryBlocks] where.${name} is not where-queryable; ` +
      `codec type ${JSON.stringify(schema.codec.type)} doesn't support comparison predicates ` +
      '(use referencedBy for refs, or add a dedicated query for collection/object filters)',
    )
  }
  // A codec from a DB-stored extension is never type-checked against `WhereStorage`.
  if (!Object.hasOwn(STORAGE_TEST, where.storage)) {
    throw new Error(
      `[queryBlocks] where.${name}: codec type ${JSON.stringify(schema.codec.type)} declares ` +
      `where.storage ${JSON.stringify(where.storage)}; expected one of ${Object.keys(STORAGE_TEST).join(', ')}`,
    )
  }
  return {
    test: STORAGE_TEST[where.storage](cell),
    encode: value => {
      try {
        return where.encode(value)
      } catch (err) {
        throw new Error(
          `[queryBlocks] where.${name} value is not a valid ${schema.codec.type}: ${(err as Error).message}`,
          {cause: err},
        )
      }
    },
  }
}

/** Mutable counter for nested `target` traversals so each level gets
 *  its own SQL alias (`d0`, `d1`, …) and inner joins don't collide
 *  with outer ones. The top-level call always passes `{n: 0}`. */
interface AliasCounter { n: number }

const compileTargetTraversal = (
  name: string,
  inner: Readonly<Record<string, unknown>>,
  schema: AnyPropertySchema,
  rowAlias: string,
  context: WhereContext,
  aliasCounter: AliasCounter,
): CompiledClause => {
  const isRef = isRefCodec(schema.codec)
  const isRefList = isRefListCodec(schema.codec)
  if (!isRef && !isRefList) {
    throw new Error(
      `[queryBlocks] where.${name}.target is only valid on ref / refList properties; ` +
      `${JSON.stringify(name)} has codec type ${JSON.stringify(schema.codec.type)}`,
    )
  }
  const alias = `d${aliasCounter.n++}`
  const innerEntries = Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))
  const innerClauses: string[] = []
  const innerParams: unknown[] = []
  for (const [innerName, innerValue] of innerEntries) {
    const compiled = compileWhereClause(
      innerName, innerValue, alias, context, aliasCounter,
    )
    innerClauses.push(compiled.sql)
    innerParams.push(...compiled.params)
  }
  const inWhere = innerClauses.length === 0 ? '' : ` AND ${innerClauses.join(' AND ')}`
  // A target outside the source row's workspace is not a live target here:
  // reference resolution is workspace-scoped, and so are the deps that wake a
  // handle when a target is created or deleted (`typedBlocksStructureKey`).
  const visible = `${alias}.deleted = 0 AND ${alias}.workspace_id = ${rowAlias}.workspace_id`
  if (isRef) {
    // The source row's `properties_json[name]` holds the target id
    // (string, stored as JSON). `json_extract` unwraps the JSON
    // quoting and gives us the bare id for the equality join.
    return {
      sql:
        `EXISTS (SELECT 1 FROM blocks ${alias} ` +
        `WHERE ${alias}.id = json_extract(${rowAlias}.properties_json, ${inlineJsonPath(name)}) ` +
        `AND ${visible}${inWhere})`,
      params: innerParams,
    }
  }
  return {
    sql:
      `EXISTS (SELECT 1 FROM ${listMembersSql(rowAlias, name)} AS je ` +
      `JOIN blocks ${alias} ON ${alias}.id = je.value ` +
      `WHERE ${visible}${inWhere})`,
    params: innerParams,
  }
}

const virtualOperator = (field: QueryableField, value: unknown): readonly [string, unknown] => {
  const entries = isPlainOperatorObject(value) ? Object.entries(value) : [['eq', value] as const]
  const entry = entries[0]
  if (entries.length !== 1 || !entry || !Object.hasOwn(field.operators, entry[0])) {
    throw new Error(`[queryBlocks] where.${field.name} requires one of: ${Object.keys(field.operators).join(', ')}`)
  }
  return entry
}

const compileWhereClause = (
  name: string,
  value: unknown,
  rowAlias: string,
  context: WhereContext,
  aliasCounter: AliasCounter = {n: 0},
): CompiledClause => {
  if (value === undefined) {
    throw new Error(`[queryBlocks] where.${name} is undefined; pass null to match unset values`)
  }
  const schema = context.properties.get(name)
  if (schema === undefined) {
    const field = context.fields?.get(name)
    if (field) {
      const [operator, operand] = virtualOperator(field, value)
      const compiled = field.operators[operator]!(rowAlias, operand)
      return {sql: `(${compiled.sql})`, params: compiled.params}
    }
    throw new Error(`[queryBlocks] where.${name} has no registered PropertySchema`)
  }
  const cell = `${rowAlias}.properties_json, ${inlineJsonPath(name)}`
  const extract = `json_extract(${cell})`
  const parsed = parseWhereValue(name, value)

  // `IS NULL` / `IS NOT NULL` skip `codec.where.encode` entirely —
  // they're orthogonal to the codec's encoding contract (and
  // codec.where.encode rejects null/undefined by design).
  if (parsed.kind === 'unset') {
    return {sql: `${extract} IS NULL`, params: []}
  }
  if (parsed.kind === 'set') {
    return {sql: `${extract} IS NOT NULL`, params: []}
  }
  if (parsed.kind === 'target') {
    return compileTargetTraversal(name, parsed.inner, schema, rowAlias, context, aliasCounter)
  }
  if (parsed.kind === 'contains') {
    const member = schema.codec.contains
    if (!member || !Object.hasOwn(STORAGE_TEST, member.storage)) {
      throw new Error(`[queryBlocks] where.${name}.contains requires a codec with a contains capability`)
    }
    // json_each.type distinguishes JSON true from the number 1 without reparsing a string member.
    const memberTypes = {text: "'text'", number: "'integer','real'", boolean: "'true','false'", 'iso-date': "'text'"} as const
    return {
      sql: `EXISTS (SELECT 1 FROM ${listMembersSql(rowAlias, name)} item WHERE item.type IN (${memberTypes[member.storage]}) AND item.value = ?)`,
      params: [member.encode(parsed.operand)],
    }
  }
  // The comparison stays its own AND term, in the indexed `json_extract`
  // spelling, so an expression index on the property still serves it.
  const comparable = comparableCell(name, schema, cell)
  if (parsed.kind === 'between') {
    return {
      sql: `(${comparable.test} AND ${extract} BETWEEN ? AND ?)`,
      params: [comparable.encode(parsed.lo), comparable.encode(parsed.hi)],
    }
  }
  return {
    sql: `(${comparable.test} AND ${extract} ${COMPARATOR_SQL[parsed.op]} ?)`,
    params: [comparable.encode(parsed.operand)],
  }
}

const compileReferencedByExists = (
  ref: TypedBlockQueryReferenceFilter,
  sourceIdExpr: string,
): CompiledClause => {
  const refClauses = [
    `br.source_id = ${sourceIdExpr}`,
    'br.target_id = ?',
  ]
  const params: unknown[] = [ref.id]
  if (ref.sourceField !== undefined) {
    refClauses.push('br.source_field = ?')
    params.push(ref.sourceField)
  }
  return {
    sql: `EXISTS (SELECT 1 FROM block_references br WHERE ${refClauses.join(' AND ')})`,
    params,
  }
}

const compilePredicateAgainstRow = (
  predicate: BlockPredicate,
  rowAlias: string,
  context: WhereContext,
): CompiledClause => {
  const clauses: string[] = []
  const params: unknown[] = []

  if (predicate.id !== undefined) {
    clauses.push(`${rowAlias}.id = ?`)
    params.push(predicate.id)
  }

  if (predicate.where !== undefined) {
    for (const [name, value] of Object.entries(predicate.where).sort(([a], [b]) => a.localeCompare(b))) {
      const compiled = compileWhereClause(name, value, rowAlias, context)
      clauses.push(compiled.sql)
      params.push(...compiled.params)
    }
  }

  if (predicate.referencedBy !== undefined) {
    const compiled = compileReferencedByExists(predicate.referencedBy, `${rowAlias}.id`)
    clauses.push(compiled.sql)
    params.push(...compiled.params)
  }

  return {
    sql: clauses.length === 0 ? '1' : clauses.join(' AND '),
    params,
  }
}

/** Compile a predicate against the result block `b` directly (self
 *  scope) or as an EXISTS over the ancestor_chain CTE rows that share
 *  `block_id = b.id` (ancestor scope, includes b itself).
 *
 *  Ancestor-as-tag: in ancestor scope, a `referencedBy:{id:X}` sub-clause
 *  also matches when any ancestor's own id IS X — Roam treats a parent
 *  block/page as an implicit reference target for everything it contains.
 *  Filtering by a parent name should match blocks living under that parent
 *  even when no ancestor sources an explicit reference. `sourceField`
 *  predicates target a specific reference channel and stay strict (the
 *  ancestor-is-itself case has no channel). */
const compileScopedPredicate = (
  predicate: BlockPredicate,
  context: WhereContext,
): CompiledClause => {
  const scope = predicate.scope ?? 'self'
  if (scope === 'self') {
    return compilePredicateAgainstRow(predicate, 'b', context)
  }

  const clauses: string[] = []
  const params: unknown[] = []

  if (predicate.id !== undefined) {
    clauses.push('anc.id = ?')
    params.push(predicate.id)
  }

  if (predicate.where !== undefined) {
    for (const [name, value] of Object.entries(predicate.where).sort(([a], [b]) => a.localeCompare(b))) {
      const compiled = compileWhereClause(name, value, 'anc', context)
      clauses.push(compiled.sql)
      params.push(...compiled.params)
    }
  }

  if (predicate.referencedBy !== undefined) {
    const refExists = compileReferencedByExists(predicate.referencedBy, 'anc.id')
    if (predicate.referencedBy.sourceField === undefined) {
      clauses.push(`(${refExists.sql} OR anc.id = ?)`)
      params.push(...refExists.params, predicate.referencedBy.id)
    } else {
      clauses.push(refExists.sql)
      params.push(...refExists.params)
    }
  }

  const inner = clauses.length === 0 ? '1' : clauses.join(' AND ')
  return {
    sql: `EXISTS (
      SELECT 1 FROM ancestor_chain ac
      JOIN blocks anc ON anc.id = ac.anc_id
      WHERE ac.block_id = b.id AND ${inner}
    )`,
    params,
  }
}

const compileAlternatives = (predicates: readonly BlockPredicate[], context: WhereContext): CompiledClause => {
  const alternatives = predicates.map(predicate => compileScopedPredicate(predicate, context))
  return {
    sql: alternatives.length ? `(${alternatives.map(clause => `(${clause.sql})`).join(' OR ')})` : '0',
    params: alternatives.flatMap(clause => clause.params),
  }
}

const dedupePredicates = (predicates: readonly BlockPredicate[] | undefined): BlockPredicate[] => {
  if (!predicates) return []
  return predicates.filter(p => {
    const hasWhere = p.where !== undefined && Object.keys(p.where).length > 0
    const hasRef = p.referencedBy !== undefined
    const hasId = p.id !== undefined
    return hasWhere || hasRef || hasId
  })
}

export const normalizeTypedBlockQuery = (
  query: ResolvedTypedBlockQuery,
): ResolvedTypedBlockQuery => ({
  workspaceId: query.workspaceId,
  parentId: query.parentId,
  propertyChildren: query.propertyChildren,
  types: query.types === undefined
    ? undefined
    : Array.from(new Set(query.types.map(type => type.trim()).filter(Boolean))).sort(),
  where: query.where,
  referencedBy: query.referencedBy,
  match: dedupePredicates(query.match),
  exclude: dedupePredicates(query.exclude),
  anyOf: query.anyOf === undefined ? undefined : dedupePredicates(query.anyOf),
  order: query.order,
})

export const hasAncestorScope = (predicates: readonly BlockPredicate[]): boolean =>
  predicates.some(p => p.scope === 'ancestor')

export const needsAncestorChain = (query: ResolvedTypedBlockQuery): boolean =>
  [query.match, query.exclude, query.anyOf].some(group => group !== undefined && hasAncestorScope(group))

const isSelfScope = (predicate: BlockPredicate): boolean =>
  (predicate.scope ?? 'self') === 'self'

/** Does this `where[name]` value narrow the candidate set, or does
 *  it only match rows lacking the property? `null` and the operator
 *  form `{exists: false}` are semantic duplicates — both compile to
 *  `IS NULL` — so both have to be classified as non-selective; if
 *  only one were, ancestor-gate and dep-wiring decisions would drift
 *  based on which shorthand the caller happened to use. */
export const isSelectiveWhereValue = (value: unknown): boolean => {
  if (value === null) return false
  if (typeof value !== 'object' || value instanceof Date || Array.isArray(value)) return true
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length !== 1) return true
  const [op, operand] = entries[0]!
  return !(op === 'exists' && operand === false)
}

export const hasSelectiveProperty = (
  where: Readonly<Record<string, unknown>> | undefined, context: WhereContext,
): boolean => Object.entries(where ?? {}).some(([name, value]) =>
  context.properties.has(name) && isSelectiveWhereValue(value),
)

const boundsByWhere = (where: BlockPredicate['where'], context: WhereContext): boolean =>
  hasSelectiveProperty(where, context) || Object.entries(where ?? {}).some(([name, value]) => {
    if (context.properties.has(name)) return false
    const field = context.fields?.get(name)
    return field?.boundingOperators?.includes(virtualOperator(field, value)[0]) === true
  })

/** Does this self-scope predicate actually bound the candidate set
 *  (vs. just match-anything)? Used by the ancestor-walk safety gate
 *  — a predicate that matches every row provides no candidate
 *  bounding even though it's "set". */
const selfPredicateNarrows = (predicate: BlockPredicate, context: WhereContext): boolean =>
  predicate.id !== undefined ||
  predicate.referencedBy !== undefined ||
  boundsByWhere(predicate.where, context)

/** Ancestor-scope predicates require at least one candidate-bounding
 *  filter; otherwise the recursive walk seeds from every live block
 *  in the workspace. Throw before the walk runs — callers that
 *  pre-fetch ancestor dep nodes (e.g. `resolveTypedBlocks`) call this
 *  before issuing the dep SQL so an invalid query doesn't trigger
 *  exactly the expensive walk the gate is meant to prevent. */
export const assertAncestorWalkBounded = (query: ResolvedTypedBlockQuery, context: WhereContext): void => {
  const matchPredicates = query.match ?? []
  if (!needsAncestorChain(query)) return

  const types = query.types ?? []
  const hasGate =
    query.parentId !== undefined ||
    query.referencedBy !== undefined ||
    types.length > 0 ||
    boundsByWhere(query.where, context) ||
    matchPredicates.some(p => isSelfScope(p) && selfPredicateNarrows(p, context)) ||
    (!!query.anyOf?.length && query.anyOf.every(p => isSelfScope(p) && selfPredicateNarrows(p, context)))
  if (!hasGate) {
    throw new Error(
      '[queryBlocks] ancestor-scoped predicates require at least one candidate filter ' +
      '(parentId, types, referencedBy, or a non-null self where / match predicate) to bound the recursive walk',
    )
  }
}

/** Shared WHERE and joins for result projections and ancestor dependency discovery. */
const candidateSource = (
  normalized: ResolvedTypedBlockQuery,
  context: WhereContext,
  recognition: RecognitionParams,
): {sql: string; params: unknown[]} => {
  const types = normalized.types ?? []
  const matchPredicates = normalized.match ?? []
  const excludePredicates = normalized.exclude ?? []
  const params: unknown[] = []
  const clauses: string[] = []
  let from: string

  // A JOIN rather than a correlated `EXISTS (SELECT 1 FROM block_types …)`:
  // SQLite cannot hoist a correlated subquery into the outer loop, so the
  // EXISTS form scanned every live block in the workspace, probing
  // `block_types` per row; as a join the planner can drive from
  // `idx_block_types_type_workspace`, whose leading `type` column is the
  // selective one.
  //
  // NOT strictly faster — when a type covers most of the workspace AND a
  // `where` term is the selective one AND `sqlite_stat1` is absent, the
  // planner can drive from bt and pay a per-row `blocks` PK lookup the
  // EXISTS form deferred. Bounded, and it evaporates once ANALYZE has run,
  // which `runAnalyzeIfStale` keeps true.
  //
  // `bt.workspace_id = b.workspace_id` is redundant for correctness (the
  // `(block_id, type)` PK already pins the row) but load-bearing for hitting
  // the composite index via transitive-equality propagation from
  // `b.workspace_id = ?`. In the referencedBy branch there is no
  // `b.workspace_id = ?` to propagate from — scoping comes via
  // `br.workspace_id = ?` — and the planner uses the PK autoindex instead.
  const typeJoin = types.length > 0
    ? `
      JOIN block_types bt
        ON bt.block_id = b.id
       AND bt.workspace_id = b.workspace_id
       AND bt.type IN (${types.map(() => '?').join(', ')})`
    : ''

  // Param order is statement order, and the join's placeholders sit in the FROM
  // clause — ahead of every WHERE placeholder — so the type params go first.
  // `params` is still empty here, so one push before the branch covers both.
  params.push(...types)

  if (normalized.referencedBy !== undefined) {
    from = `
      FROM block_references br
      JOIN blocks b ON b.id = br.source_id${typeJoin}
    `.trim()
    clauses.push('br.workspace_id = ?', 'br.target_id = ?', 'b.deleted = 0')
    params.push(normalized.workspaceId, normalized.referencedBy.id)
    if (normalized.referencedBy.sourceField !== undefined) {
      clauses.push('br.source_field = ?')
      params.push(normalized.referencedBy.sourceField)
    }
  } else {
    let index = ''
    if (normalized.parentId !== undefined) {
      // Without stats SQLite may sort all workspace rows to select one parent's children.
      index = ' INDEXED BY idx_blocks_parent_order'
    } else if (typeof normalized.order === 'object' && !types.length &&
      !normalized.where && !matchPredicates.length && !excludePredicates.length && normalized.anyOf === undefined) {
      // Arbitrary property sorts visit the workspace's live rows. Keep foreign workspaces off that path.
      index = ' INDEXED BY idx_blocks_workspace_active'
    }
    from = `FROM blocks b${index}${typeJoin}`
    clauses.push('b.workspace_id = ?', 'b.deleted = 0')
    params.push(normalized.workspaceId)
  }

  if (normalized.parentId !== undefined) {
    clauses.push('b.parent_id = ?')
    params.push(normalized.parentId)
  }
  if (normalized.propertyChildren === 'none') {
    clauses.push(NOT_PROPERTY_ROW_SQL)
    params.push(...recognition, ...recognition)
  }

  if (normalized.where !== undefined) {
    for (const [name, value] of Object.entries(normalized.where).sort(([a], [b]) => a.localeCompare(b))) {
      const compiled = compileWhereClause(name, value, 'b', context)
      clauses.push(compiled.sql)
      params.push(...compiled.params)
    }
  }

  if (normalized.anyOf !== undefined && !hasAncestorScope(normalized.anyOf)) {
    const group = compileAlternatives(normalized.anyOf, context)
    clauses.push(group.sql)
    params.push(...group.params)
  }
  for (const predicate of matchPredicates) {
    if (!isSelfScope(predicate)) continue
    const compiled = compilePredicateAgainstRow(predicate, 'b', context)
    clauses.push(compiled.sql)
    params.push(...compiled.params)
  }
  for (const predicate of excludePredicates) {
    if (!isSelfScope(predicate)) continue
    const compiled = compilePredicateAgainstRow(predicate, 'b', context)
    // `IS NOT TRUE` (not bare `NOT`): exclude a row only when the
    // predicate is *definitely* true. A scalar `where` over an unset
    // property is NULL, since `json_extract` / `json_type` of a missing
    // path are; `NOT (NULL)` is NULL — not TRUE — so a
    // bare `NOT` would drop every row that never set the property. The
    // documented contract is NOR ("exclude iff a predicate matches"),
    // and an unknown does not match, so unset rows must survive.
    clauses.push(`(${compiled.sql}) IS NOT TRUE`)
    params.push(...compiled.params)
  }

  return {sql: `${from} WHERE ${clauses.join(' AND ')}`, params}
}

export const buildCandidatesCte = (
  query: ResolvedTypedBlockQuery,
  context: WhereContext,
  recognition: RecognitionParams = NO_REGISTRY_RECOGNITION_PARAMS,
): CompiledTypedBlockQuery => {
  const source = candidateSource(query, context, recognition)
  return {sql: `candidates AS (SELECT DISTINCT b.id ${source.sql})`, params: source.params}
}

/** Recursive ancestor-chain CTE keyed off `candidates`. One row per
 *  (candidate id, ancestor id), with depth and a path guard against
 *  cycles. Hard depth cap of 100 mirrors the existing backlinks SQL.
 *  The ancestor-dep walk (`kernelQueries.ts`) reuses it.
 *
 *  CROSS JOIN pins the seed's join ORDER (results are identical): left to
 *  choose, the planner scans every live block and probes an automatic index
 *  over the candidates — `typedBlockQueryJoinOrder.test.ts`. */
export const ANCESTOR_CHAIN_CTE_SQL = `
  ancestor_chain(block_id, anc_id, anc_parent_id, depth, path, workspace_id) AS (
    SELECT c.id, seed.id, seed.parent_id, 0, '!' || hex(seed.id) || '/', seed.workspace_id
    FROM candidates c
    CROSS JOIN blocks seed ON seed.id = c.id
    WHERE seed.deleted = 0
    UNION ALL
    SELECT
      ancestor_chain.block_id,
      parent.id,
      parent.parent_id,
      ancestor_chain.depth + 1,
      ancestor_chain.path || '!' || hex(parent.id) || '/',
      ancestor_chain.workspace_id
    FROM ancestor_chain
    JOIN blocks parent ON parent.id = ancestor_chain.anc_parent_id
    WHERE parent.deleted = 0
      AND parent.workspace_id = ancestor_chain.workspace_id
      AND ancestor_chain.depth < 100
      AND INSTR(ancestor_chain.path, '!' || hex(parent.id) || '/') = 0
  )
`.trim()

const resultOrderSql = (
  query: ResolvedTypedBlockQuery,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
): string => {
  const order = query.order
  if (order === 'outline') {
    if (query.parentId === undefined) throw new Error('[queryBlocks] outline order requires parentId')
    return 'b.order_key, b.id'
  }
  if (typeof order === 'object') {
    const schema = schemas.get(order.property)
    if (!schema?.codec.where || schema.codec.member || isRefCodec(schema.codec)) {
      throw new Error(`[queryBlocks] order requires a registered scalar property; got ${JSON.stringify(order.property)}`)
    }
    const cell = `b.properties_json, ${inlineJsonPath(order.property)}`
    const {test} = comparableCell(order.property, schema, cell)
    const direction = order.direction === 'desc' ? 'DESC' : 'ASC'
    return `CASE WHEN ${test} THEN json_extract(${cell}) END ${direction} NULLS LAST, b.id`
  }
  return `b.created_at ${order === 'created-desc' ? 'DESC' : 'ASC'}, b.id ASC`
}

export const compileTypedBlockQuery = (
  query: ResolvedTypedBlockQuery,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
  opts: {projection?: TypedBlockQueryProjection; limit?: number; recognition?: RecognitionParams; fields?: Fields} = {},
): CompiledTypedBlockQuery => {
  const normalized = normalizeTypedBlockQuery(query)
  const matchPredicates = normalized.match ?? []
  const excludePredicates = normalized.exclude ?? []

  const context = {properties: propertySchemas, fields: opts.fields}
  assertAncestorWalkBounded(normalized, context)

  const source = candidateSource(normalized, context, opts.recognition ?? NO_REGISTRY_RECOGNITION_PARAMS)
  const params = source.params
  const order = resultOrderSql(normalized, propertySchemas)
  const isCount = opts.projection === 'count'
  const select = opts.projection === 'ids' ? 'b.id AS id' : buildQualifiedBlockColumnsSql('b')
  const suffix = isCount ? '' : `ORDER BY ${order}${opts.limit === undefined ? '' : ' LIMIT ?'}`
  if (!needsAncestorChain(normalized)) {
    const duplicates = (normalized.types?.length ?? 0) > 1 || normalized.referencedBy !== undefined
    const projection = isCount
      ? `COUNT(${duplicates ? 'DISTINCT b.id' : '*'}) AS count`
      : `${duplicates ? 'DISTINCT ' : ''}${select}`
    if (!isCount && opts.limit !== undefined) params.push(opts.limit)
    return {sql: `SELECT ${projection} ${source.sql} ${suffix}`, params}
  }

  // Outer WHERE — ancestor-scope predicates only.
  const filterClauses: string[] = []

  if (normalized.anyOf && hasAncestorScope(normalized.anyOf)) {
    const group = compileAlternatives(normalized.anyOf, context)
    filterClauses.push(group.sql)
    params.push(...group.params)
  }
  for (const predicate of matchPredicates) {
    if (isSelfScope(predicate)) continue
    const compiled = compileScopedPredicate(predicate, context)
    filterClauses.push(compiled.sql)
    params.push(...compiled.params)
  }

  for (const predicate of excludePredicates) {
    if (isSelfScope(predicate)) continue
    const compiled = compileScopedPredicate(predicate, context)
    // `IS NOT TRUE` for the same NULL-safety reason as the self-scope
    // exclude above. The ancestor predicate compiles to `EXISTS(...)`
    // (always 0/1, so `IS NOT TRUE` == `NOT` here), but keeping both
    // exclude sites identical avoids a latent trap if the shape ever
    // changes.
    filterClauses.push(`(${compiled.sql}) IS NOT TRUE`)
    params.push(...compiled.params)
  }

  if (!isCount && opts.limit !== undefined) params.push(opts.limit)
  const sql = `
    WITH RECURSIVE candidates AS (SELECT DISTINCT b.id ${source.sql}), ${ANCESTOR_CHAIN_CTE_SQL}
    SELECT ${isCount ? 'COUNT(*) AS count' : select}
    FROM candidates c
    CROSS JOIN blocks b ON b.id = c.id
    WHERE ${filterClauses.join(' AND ')}
    ${suffix}
  `
  return {sql, params}
}
