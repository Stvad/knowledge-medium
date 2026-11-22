/** A table's query as the grid reads it: the host's query property, unwrapped
 *  from its code fence and parsed against this workspace's names. */
import { useMemo, useState } from 'react'
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
import { parseQuery, type ParsedQuery, type QueryClauses, type QueryProperty, type QueryResolver } from './parse'

const FENCE_LINE = /^[ \t]*(`{3,}|~{3,})/

/** The text inside the value's code fence: the lines between an opening fence
 *  line and the last line that closes it (the same character, at least as
 *  many). An unclosed fence runs to the end. A value with no fence is the query
 *  itself. */
export const queryTextOf = (value: string): string => {
  const lines = value.trimEnd().split('\n')
  const open = FENCE_LINE.exec(lines[0] ?? '')
  if (!open) return value
  const fence = open[1]!
  const closes = (line: string) => {
    const close = /^[ \t]*(`+|~+)[ \t]*$/.exec(line)
    return close !== null && close[1]![0] === fence[0] && close[1]!.length >= fence.length
  }
  const end = lines.length > 1 && closes(lines[lines.length - 1]!) ? lines.length - 1 : lines.length
  return lines.slice(1, end).join('\n')
}

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
  /** What the rows are selected by. A query none of whose terms compiled
   *  selects nothing, beside its errors: no clauses would select everything. */
  readonly clauses: QueryClauses
}

const SELECTS_NOTHING: QueryClauses = {anyOf: []}

/** The query property's definition id in this workspace, once its seed is materialized. */
export const useQueryFieldId = (repo: Repo): string | undefined =>
  usePropertyDefinitions(repo)?.definitionsByName.get(queryProp.name)?.[0]?.fieldId

/** The host's parsed query; null when the host has none (its rows are its
 *  children), undefined until its names first resolve. */
export const useTableQuery = (host: Block, workspaceId: string): TableQuery | null | undefined => {
  const value = useHandle(host, {selector: data => data ? safeDecodeRowProperty(data, queryProp) : ''})
  const text = queryTextOf(value ?? '')
  const aliases = useMemo(() => [...new Set(parseOutermostReferences(text).map(ref => ref.alias))].sort(), [text])
  const aliasIds = useAliasIds(host.repo, workspaceId, aliases)
  const definitions = usePropertyDefinitions(host.repo)
  const types = useTypes()
  const resolved = useMemo(() => {
    if (!text.trim()) return null
    if (!aliasIds) return undefined
    const resolver = queryResolver(host.repo, workspaceId, definitions, types, aliasIds)
    const parsed = parseQuery(text, resolver, {selfId: host.id})
    return {text, parsed, clauses: parsed.terms.length > 0 ? parsed.query : SELECTS_NOTHING}
  }, [aliasIds, definitions, host.id, host.repo, text, types, workspaceId])
  // While an edited query's new aliases resolve, the last query stands: going
  // back to loading would unmount the grid, and the rows made in it with it.
  const [last, setLast] = useState(resolved)
  if (resolved !== undefined && resolved !== last) setLast(resolved)
  return resolved === undefined ? last : resolved
}
