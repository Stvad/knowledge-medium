import {
  isRefCodec,
  isRefListCodec,
  type AnyPropertySchema,
  type CodecShape,
  type ResolvedTypedBlockQuery,
} from '@/data/api'
import { buildQualifiedBlockColumnsSql } from '@/data/blockSchema'

const SCALAR_WHERE_SHAPES: ReadonlySet<CodecShape> = new Set(['string', 'number', 'boolean', 'date'])

export interface CompiledTypedBlockQuery {
  readonly sql: string
  readonly params: readonly unknown[]
}

const jsonPathForProperty = (name: string): string =>
  `$."${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`

const normalizeSqlValue = (value: unknown): string | number | null => {
  if (value === null) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string' || typeof value === 'number') return value
  throw new Error(
    `[queryBlocks] where values must encode to a scalar JSON value; got ${JSON.stringify(value)}`,
  )
}

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
  if (!SCALAR_WHERE_SHAPES.has(schema.codec.shape) || isRefCodec(schema.codec) || isRefListCodec(schema.codec)) {
    throw new Error(
      `[queryBlocks] where.${name} uses non-scalar or reference codec ${JSON.stringify(schema.codec.shape)}; ` +
      'use referencedBy for refs or add a dedicated query for collection/object filters',
    )
  }

  const path = jsonPathForProperty(name)
  const encoded = value === null ? null : schema.codec.encode(value)
  const sqlValue = normalizeSqlValue(encoded)
  if (sqlValue === null) {
    return {
      sql: 'json_extract(b.properties_json, ?) IS NULL',
      params: [path],
    }
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
