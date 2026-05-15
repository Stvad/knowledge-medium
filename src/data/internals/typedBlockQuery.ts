import {
  type AnyPropertySchema,
  type BlockPredicate,
  type ResolvedTypedBlockQuery,
  type TypedBlockQueryReferenceFilter,
} from '@/data/api'
import { buildQualifiedBlockColumnsSql } from '@/data/blockSchema'

export interface CompiledTypedBlockQuery {
  readonly sql: string
  readonly params: readonly unknown[]
}

export const jsonPathForProperty = (name: string): string =>
  `$."${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

interface CompiledClause {
  readonly sql: string
  readonly params: readonly unknown[]
}

const compileWhereClause = (
  name: string,
  value: unknown,
  schema: AnyPropertySchema | undefined,
  jsonExpr: string,
): CompiledClause => {
  if (value === undefined) {
    throw new Error(`[queryBlocks] where.${name} is undefined; pass null to match unset values`)
  }
  if (schema === undefined) {
    throw new Error(`[queryBlocks] where.${name} has no registered PropertySchema`)
  }
  const path = jsonPathForProperty(name)

  // `null` is the typed-query "match unset / explicitly-null" sentinel;
  // SQLite `=` against NULL never matches, so compile to `IS NULL` and
  // skip `where.encode` entirely (it would reject null).
  if (value === null) {
    return {
      sql: `json_extract(${jsonExpr}, ?) IS NULL`,
      params: [path],
    }
  }

  if (!schema.codec.where) {
    throw new Error(
      `[queryBlocks] where.${name} is not where-queryable; ` +
      `codec type ${JSON.stringify(schema.codec.type)} doesn't support equality predicates ` +
      '(use referencedBy for refs, or add a dedicated query for collection/object filters)',
    )
  }

  let sqlValue: string | number
  try {
    sqlValue = schema.codec.where.encode(value)
  } catch (err) {
    throw new Error(
      `[queryBlocks] where.${name} value is not a valid ${schema.codec.type}: ${(err as Error).message}`,
      {cause: err},
    )
  }
  return {
    sql: `json_extract(${jsonExpr}, ?) = ?`,
    params: [path, sqlValue],
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
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): CompiledClause => {
  const clauses: string[] = []
  const params: unknown[] = []
  const propsExpr = `${rowAlias}.properties_json`

  if (predicate.id !== undefined) {
    clauses.push(`${rowAlias}.id = ?`)
    params.push(predicate.id)
  }

  if (predicate.where !== undefined) {
    for (const [name, value] of Object.entries(predicate.where).sort(([a], [b]) => a.localeCompare(b))) {
      const compiled = compileWhereClause(name, value, propertySchemas.get(name), propsExpr)
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
 *  `block_id = b.id` (ancestor scope, includes b itself). */
const compileScopedPredicate = (
  predicate: BlockPredicate,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): CompiledClause => {
  const scope = predicate.scope ?? 'self'
  if (scope === 'self') {
    return compilePredicateAgainstRow(predicate, 'b', propertySchemas)
  }
  const inner = compilePredicateAgainstRow(predicate, 'anc', propertySchemas)
  return {
    sql: `EXISTS (
      SELECT 1 FROM ancestor_chain ac
      JOIN blocks anc ON anc.id = ac.anc_id
      WHERE ac.block_id = b.id AND ${inner.sql}
    )`,
    params: inner.params,
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
  types: query.types === undefined
    ? undefined
    : Array.from(new Set(query.types.map(type => type.trim()).filter(Boolean))).sort(),
  where: query.where,
  referencedBy: query.referencedBy,
  match: dedupePredicates(query.match),
  exclude: dedupePredicates(query.exclude),
  order: query.order,
})

const hasAncestorScope = (predicates: readonly BlockPredicate[]): boolean =>
  predicates.some(p => p.scope === 'ancestor')

/** Recursive ancestor-chain CTE keyed off `candidates`. One row per
 *  (candidate id, ancestor id), with depth and a path guard against
 *  cycles. Hard depth cap of 100 mirrors the existing backlinks SQL. */
const ANCESTOR_CHAIN_CTE_SQL = `
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
`.trim()

export const compileTypedBlockQuery = (
  query: ResolvedTypedBlockQuery,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): CompiledTypedBlockQuery => {
  const normalized = normalizeTypedBlockQuery(query)
  const types = normalized.types ?? []
  const matchPredicates = normalized.match ?? []
  const excludePredicates = normalized.exclude ?? []
  const needsAncestorChain =
    hasAncestorScope(matchPredicates) || hasAncestorScope(excludePredicates)

  if (needsAncestorChain) {
    // Selectivity gate: ancestor walks without a candidate filter
    // would chain-walk every block in the workspace. Require at least
    // one filter that narrows the candidate set first.
    const hasGate =
      normalized.referencedBy !== undefined ||
      types.length > 0 ||
      (normalized.where !== undefined && Object.values(normalized.where).some(v => v !== null))
    if (!hasGate) {
      throw new Error(
        '[queryBlocks] ancestor-scoped predicates require at least one candidate filter ' +
        '(types, referencedBy, or a non-null self where) to bound the recursive walk',
      )
    }
  }

  const params: unknown[] = []

  // Candidate-set CTE. Driven by the most selective filter:
  //   1. `referencedBy` shorthand → indexed lookup on block_references
  //   2. else → workspace's live blocks
  // Other filters (types, where, additional match/exclude predicates)
  // apply later as WHERE clauses against b.
  const candidateClauses: string[] = []
  let candidateFrom: string
  if (normalized.referencedBy !== undefined) {
    candidateFrom = `
      FROM block_references br
      JOIN blocks b ON b.id = br.source_id
    `.trim()
    candidateClauses.push('br.workspace_id = ?', 'br.target_id = ?', 'b.deleted = 0')
    params.push(normalized.workspaceId, normalized.referencedBy.id)
    if (normalized.referencedBy.sourceField !== undefined) {
      candidateClauses.push('br.source_field = ?')
      params.push(normalized.referencedBy.sourceField)
    }
  } else {
    candidateFrom = 'FROM blocks b'
    candidateClauses.push('b.workspace_id = ?', 'b.deleted = 0')
    params.push(normalized.workspaceId)
  }

  if (types.length > 0) {
    candidateClauses.push(`
      EXISTS (
        SELECT 1
        FROM block_types bt
        WHERE bt.block_id = b.id
          AND bt.workspace_id = b.workspace_id
          AND bt.type IN (${types.map(() => '?').join(', ')})
      )
    `.trim())
    params.push(...types)
  }

  const candidatesCte = `
    candidates AS (
      SELECT DISTINCT b.id
      ${candidateFrom}
      WHERE ${candidateClauses.join('\n        AND ')}
    )
  `.trim()

  // Final WHERE clauses against the result row b (joined to candidates).
  const filterClauses: string[] = []

  if (normalized.where !== undefined) {
    for (const [name, value] of Object.entries(normalized.where).sort(([a], [b]) => a.localeCompare(b))) {
      const compiled = compileWhereClause(name, value, propertySchemas.get(name), 'b.properties_json')
      filterClauses.push(compiled.sql)
      params.push(...compiled.params)
    }
  }

  for (const predicate of matchPredicates) {
    const compiled = compileScopedPredicate(predicate, propertySchemas)
    filterClauses.push(compiled.sql)
    params.push(...compiled.params)
  }

  for (const predicate of excludePredicates) {
    const compiled = compileScopedPredicate(predicate, propertySchemas)
    filterClauses.push(`NOT (${compiled.sql})`)
    params.push(...compiled.params)
  }

  const ctes = needsAncestorChain
    ? `WITH RECURSIVE ${candidatesCte}, ${ANCESTOR_CHAIN_CTE_SQL}`
    : `WITH ${candidatesCte}`

  const orderClause = normalized.order === 'created-desc'
    ? 'ORDER BY b.created_at DESC, b.id'
    : 'ORDER BY b.created_at ASC, b.id ASC'

  const sql = `
    ${ctes}
    SELECT ${buildQualifiedBlockColumnsSql('b')}
    FROM candidates c
    JOIN blocks b ON b.id = c.id
    ${filterClauses.length > 0 ? `WHERE ${filterClauses.join('\n      AND ')}` : ''}
    ${orderClause}
  `

  return {sql, params}
}
