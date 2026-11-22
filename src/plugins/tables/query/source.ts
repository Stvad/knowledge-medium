/** A table's query as the grid reads it: the host's query property, unwrapped
 *  from its code fence and parsed against this workspace's names. */
import { useMemo } from 'react'
import type { TypeContribution } from '@/data/api'
import type { Block } from '@/data/block'
import { queryableFieldsFacet } from '@/data/facets'
import type { PropertyDefinitionRegistrySnapshot } from '@/data/propertyDefinitionRegistry'
import type { Repo } from '@/data/repo'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { useHandle, useHandles, useStableJson } from '@/hooks/block'
import { useTypes } from '@/hooks/typeRegistry'
import { usePropertyDefinitions } from '@/plugins/property-rows/fieldRow'
import { parseOutermostReferences } from '@/plugins/references/referenceParser'
import { queryProp } from '../schema'
import { parseQuery, type ParsedQuery, type QueryProperty, type QueryResolver } from './parse'

const FENCE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]*\1[`~]*[ \t]*)?\s*$/

/** The text inside the value's code fence. A value with no fence is the query itself. */
export const queryTextOf = (value: string): string => FENCE.exec(value)?.[2] ?? value

/** The value a query property holds for `text`. */
export const fencedQuery = (text: string): string => `\`\`\`query\n${text}\n\`\`\``

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
): QueryResolver => {
  const fields = repo.facetRuntime?.read(queryableFieldsFacet, workspaceId)
  return {
    propertyByName: name => propertyOf(definitions, definitions?.definitionsByName.get(name)?.[0]?.fieldId),
    propertyById: fieldId => propertyOf(definitions, fieldId),
    typeByLabel: label => {
      const wanted = label.toLowerCase()
      for (const type of types.values()) if (labelOf(type).toLowerCase() === wanted) return {id: type.id, label: labelOf(type)}
      return undefined
    },
    typeById: id => {
      const type = types.get(id)
      return type && {id: type.id, label: labelOf(type)}
    },
    isField: name => fields?.has(name) === true,
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
}

/** The host's parsed query; null when the host has none (its rows are its
 *  children), undefined while names are still resolving. */
export const useTableQuery = (host: Block, workspaceId: string): TableQuery | null | undefined => {
  const value = useHandle(host, {selector: data => data ? safeDecodeRowProperty(data, queryProp) : ''})
  const text = queryTextOf(value ?? '')
  const aliases = useMemo(() => [...new Set(parseOutermostReferences(text).map(ref => ref.alias))].sort(), [text])
  const aliasIds = useAliasIds(host.repo, workspaceId, aliases)
  const definitions = usePropertyDefinitions(host.repo)
  const types = useTypes()
  return useMemo(() => {
    if (!text.trim()) return null
    if (!aliasIds) return undefined
    const resolver = queryResolver(host.repo, workspaceId, definitions, types, aliasIds)
    return {text, parsed: parseQuery(text, resolver, {selfId: host.id})}
  }, [aliasIds, definitions, host.id, host.repo, text, types, workspaceId])
}
