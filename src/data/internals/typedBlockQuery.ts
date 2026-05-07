import {
  type AnyPropertySchema,
  type ResolvedTypedBlockQuery,
} from '@/data/api'
import { buildQualifiedBlockColumnsSql } from '@/data/blockSchema'

export interface CompiledTypedBlockQuery {
  readonly sql: string
  readonly params: readonly unknown[]
}

const jsonPathForProperty = (name: string): string =>
  `$."${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

const compileWhereFilter = (
  name: string,
  value: unknown,
  schema: AnyPropertySchema | undefined,
): {sql: string; params: unknown[]} => {
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
      sql: 'json_extract(b.properties_json, ?) IS NULL',
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
    )
  }
  return {
    sql: 'json_extract(b.properties_json, ?) = ?',
    params: [path, sqlValue],
  }
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
})

export const compileTypedBlockQuery = (
  query: ResolvedTypedBlockQuery,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): CompiledTypedBlockQuery => {
  const normalized = normalizeTypedBlockQuery(query)
  const clauses = ['b.workspace_id = ?', 'b.deleted = 0']
  const params: unknown[] = [normalized.workspaceId]

  const types = normalized.types ?? []
  if (types.length > 0) {
    clauses.push(`
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

  for (const [name, value] of Object.entries(normalized.where ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const compiled = compileWhereFilter(name, value, propertySchemas.get(name))
    clauses.push(compiled.sql)
    params.push(...compiled.params)
  }

  if (normalized.referencedBy !== undefined) {
    const refClauses = [
      'br.source_id = b.id',
      'br.workspace_id = b.workspace_id',
      'br.target_id = ?',
    ]
    params.push(normalized.referencedBy.id)
    if (normalized.referencedBy.sourceField !== undefined) {
      refClauses.push('br.source_field = ?')
      params.push(normalized.referencedBy.sourceField)
    }
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM block_references br
        WHERE ${refClauses.join('\n          AND ')}
      )
    `.trim())
  }

  return {
    sql: `
      SELECT ${buildQualifiedBlockColumnsSql('b')}
      FROM blocks b
      WHERE ${clauses.join('\n        AND ')}
      ORDER BY b.created_at ASC, b.id ASC
    `,
    params,
  }
}
