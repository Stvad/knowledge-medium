/** A table's query as the grid reads it: the host's query property, parsed
 *  against this workspace's names. */
import { useMemo, useState } from 'react'
import type { TypeContribution } from '@/data/api'
import type { Block } from '@/data/block'
import { KERNEL_QUERYABLE_FIELDS } from '@/data/facets'
import type { PropertyDefinitionRegistrySnapshot } from '@/data/propertyDefinitionRegistry'
import type { Repo } from '@/data/repo'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { useHandle, useHandles, useStableJson } from '@/hooks/block'
import { useTypes } from '@/hooks/typeRegistry'
import { usePropertyDefinitions } from '@/plugins/property-rows/fieldRow'
import { parseOutermostReferences } from '@/plugins/references/referenceParser'
import { queryFieldIdOf, queryProp } from '../schema'
import { parseQuery, type ParsedQuery, type QueryClauses, type QueryProperty, type QueryResolver } from './parse'
import { readTableQueryFacets, refValueTarget, type TableQueryFacets } from './registrations'

const propertyOf = (definitions: PropertyDefinitionRegistrySnapshot | null, fieldId: string | undefined): QueryProperty | undefined => {
  if (!definitions || fieldId === undefined) return undefined
  const name = definitions.definitionsByFieldId.get(fieldId)?.name
  const schema = definitions.schemasByFieldId.get(fieldId)
  return name !== undefined && schema ? {name, fieldId, schema} : undefined
}

const labelOf = (type: TypeContribution) => type.label ?? type.id

export const queryResolver = (
  repo: Repo, workspaceId: string, definitions: PropertyDefinitionRegistrySnapshot | null,
  types: ReadonlyMap<string, TypeContribution>, aliases: ReadonlyMap<string, string>,
  facets: TableQueryFacets = readTableQueryFacets(repo.facetRuntime, workspaceId),
): QueryResolver => {
  const properties = repo.propertySchemasFor(workspaceId)
  return {
    propertyByName: name => propertyOf(definitions, definitions?.definitionsByName.get(name)?.[0]?.fieldId),
    propertyById: fieldId => propertyOf(definitions, fieldId),
    refValueTarget: schema => refValueTarget(schema, properties, facets),
    typeByLabel: label => {
      const wanted = label.toLowerCase()
      for (const type of types.values()) if (labelOf(type).toLowerCase() === wanted) return {id: type.id, label: labelOf(type)}
      return undefined
    },
    typeById: id => {
      const type = types.get(id)
      return type && {id: type.id, label: labelOf(type)}
    },
    field: name => {
      const field = facets.fields?.get(name)
      if (!field) return undefined
      // The kernel's timestamps take instants, and a date names a local day; any
      // other field's own encoder decides its operand.
      return KERNEL_QUERYABLE_FIELDS.some(kernel => kernel.encode === field.encode)
        ? {kind: 'instant'}
        : {kind: 'value', encode: field.encode}
    },
    blockIdByAlias: alias => aliases.get(alias),
  }
}

/** Every `[[alias]]` the query names, resolved to its block id and kept live
 *  as pages are created or renamed. Undefined until every lookup has answered. */
const useAliasIds = (repo: Repo, workspaceId: string, aliases: readonly string[]): ReadonlyMap<string, string> | undefined => {
  const names = useStableJson(aliases)
  const handles = useMemo(() => names.map(alias => repo.query.aliasLookup({workspaceId, alias})), [names, repo, workspaceId])
  const blocks = useHandles(handles)
  return useMemo(() => {
    if (blocks.some(block => block === undefined)) return undefined
    return new Map(blocks.flatMap((block, index) => block ? [[names[index]!, block.id] as const] : []))
  }, [blocks, names])
}

export interface TableQuery {
  readonly text: string
  readonly parsed: ParsedQuery
  /** What the rows are selected by. A query none of whose terms compiled
   *  selects nothing, beside its errors: no clauses would select everything. */
  readonly clauses: QueryClauses
}

const SELECTS_NOTHING: QueryClauses = {anyOf: []}

/** The query property's definition id in this workspace (`queryFieldIdOf`). */
export const useQueryFieldId = (repo: Repo): string | undefined => queryFieldIdOf(usePropertyDefinitions(repo))

/** The host's parsed query; null when the host has none (its rows are its
 *  children), undefined until its names first resolve. */
export const useTableQuery = (host: Block, workspaceId: string, facets: TableQueryFacets): TableQuery | null | undefined => {
  const value = useHandle(host, {selector: data => data ? safeDecodeRowProperty(data, queryProp) : ''})
  const text = value ?? ''
  const aliases = useMemo(() => [...new Set(parseOutermostReferences(text).map(ref => ref.alias))].sort(), [text])
  const aliasIds = useAliasIds(host.repo, workspaceId, aliases)
  const definitions = usePropertyDefinitions(host.repo)
  const types = useTypes()
  const resolved = useMemo(() => {
    if (!text.trim()) return null
    if (!aliasIds) return undefined
    const resolver = queryResolver(host.repo, workspaceId, definitions, types, aliasIds, facets)
    const parsed = parseQuery(text, resolver, {selfId: host.id})
    return {text, parsed, clauses: parsed.terms.length > 0 ? parsed.query : SELECTS_NOTHING}
  }, [aliasIds, definitions, facets, host.id, host.repo, text, types, workspaceId])
  // While an edited query's new aliases resolve, the last query stands: going
  // back to loading would unmount the grid, and the rows made in it with it.
  const [last, setLast] = useState(resolved)
  if (resolved !== undefined && resolved !== last) setLast(resolved)
  return resolved === undefined ? last : resolved
}
