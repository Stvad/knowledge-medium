import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { isActiveSearchFilter, type BlockSearchFilter } from '@/data/searchFilter'
import { AGENT_VIEW_DEFAULTS } from '@knowledge-medium/agent-cli/protocol'
import { readTypeIds, searchBlocksAcrossSources } from '@/utils/linkTargetAutocomplete.js'
import { loadCrumbs } from './context.ts'
import { createPropertyRenderer, type PropertyLine } from './properties.ts'
import { resolveBlockRef, shortIds as loadShortIds } from './resolveRef.ts'
import { clampInt, crumbLine } from './shared.ts'
import { formatCount, oneLine, snippet } from './text.ts'

export interface SearchParams {
  query: string
  limit?: number
  offset?: number
  types?: string[]
  under?: string
  includeExtensions?: boolean
}

export interface SearchHit {
  id: string
  shortId: string
  breadcrumb: string[]
  snippet: string
  types: string[]
  properties: PropertyLine[]
  /** Other blocks with the same text, folded into this hit. */
  duplicateIds: string[]
  duplicateShortIds: string[]
}

export interface SearchView {
  query: string
  filter: {types: string[], under: string | null, includeExtensions: boolean}
  offset: number
  hits: SearchHit[]
  /** Where the next page starts, or null when this is the last. */
  nextOffset: number | null
}

const MAX_RESULTS = 200
/** Fetched up front and deduped as a whole, so consecutive pages slice ONE
 *  ranking: a window that grew per page could reorder its top and repeat or
 *  skip a hit across pages. */
const SEARCH_WINDOW = 100

/** A filter type is a type id or a type's label (`todo`, a user type's
 *  name), matched case-insensitively. An unknown one is kept as an id so the
 *  filter matches nothing rather than silently widening. */
const resolveTypeIds = (repo: Repo, types: readonly string[]): string[] => {
  const ids = new Set<string>()
  for (const wanted of types) {
    if (repo.types.has(wanted)) {
      ids.add(wanted)
      continue
    }
    const lower = wanted.trim().toLowerCase()
    const matches = [...repo.types.values()].filter(type => type.label?.trim().toLowerCase() === lower)
    if (matches.length === 0) ids.add(wanted)
    for (const type of matches) ids.add(type.id)
  }
  return [...ids]
}

const dedupeKey = (block: BlockData): string => oneLine(block.content).toLowerCase()

const extensionBlockCount = async (repo: Repo, workspaceId: string): Promise<number> => {
  const [row] = await repo.db.getAll<{n: number}>(
    'SELECT count(*) AS n FROM block_types WHERE workspace_id = ? AND type = ?',
    [workspaceId, EXTENSION_TYPE],
  )
  return row?.n ?? 0
}

export const buildSearchView = async (
  repo: Repo,
  workspaceId: string,
  params: SearchParams,
): Promise<SearchView> => {
  const limit = clampInt(params.limit, AGENT_VIEW_DEFAULTS.searchLimit, MAX_RESULTS)
  const offset = params.offset ?? 0
  const includeExtensions = params.includeExtensions === true
  const underId = params.under === undefined
    ? undefined
    : (await resolveBlockRef(repo, params.under, {workspaceId})).id
  const scope: BlockSearchFilter = {
    ...(params.types?.length ? {types: resolveTypeIds(repo, params.types)} : {}),
    ...(underId !== undefined ? {underId} : {}),
  }
  // Extension source is dropped AFTER the fan-out when nothing else filters:
  // an active filter limits the search to sources that can apply it, and
  // excluding extensions must not cost a default search its contributed
  // sources. Fetching that many extra rows keeps the page exact.
  const scoped = isActiveSearchFilter(scope)
  const filter = scoped && !includeExtensions ? {...scope, excludeTypes: [EXTENSION_TYPE]} : scope
  const extensionSlack = includeExtensions || scoped ? 0 : await extensionBlockCount(repo, workspaceId)

  const window = Math.max(SEARCH_WINDOW, offset + limit + 1)
  const fetched = await searchBlocksAcrossSources(repo, {
    workspaceId,
    query: params.query,
    limit: window + extensionSlack,
    filter,
  })
  const found = includeExtensions
    ? fetched
    : fetched.filter(block => !readTypeIds(block).includes(EXTENSION_TYPE))

  const groups: BlockData[][] = []
  const groupByKey = new Map<string, BlockData[]>()
  for (const block of found) {
    const key = dedupeKey(block)
    const group = groupByKey.get(key)
    if (group) group.push(block)
    else {
      const created = [block]
      groupByKey.set(key, created)
      groups.push(created)
    }
  }

  const page = groups.slice(offset, offset + limit)
  const shown = page.map(group => group[0])
  const duplicateIds = page.flatMap(group => group.slice(1).map(block => block.id))
  const [renderer, shortIds, crumbs] = await Promise.all([
    createPropertyRenderer(repo, shown),
    loadShortIds(repo, [...shown.map(block => block.id), ...duplicateIds]),
    loadCrumbs(repo, shown.map(block => block.id), workspaceId),
  ])
  const end = offset + page.length
  // A window that came back full may have cut off matches past it.
  const more = end < groups.length || (fetched.length >= window + extensionSlack && page.length === limit)

  return {
    query: params.query,
    filter: {types: params.types ?? [], under: underId ?? null, includeExtensions},
    offset,
    hits: page.map(group => {
      const [block, ...duplicates] = group
      return {
        id: block.id,
        shortId: shortIds.get(block.id) ?? block.id,
        breadcrumb: crumbs.get(block.id) ?? [],
        snippet: snippet(block.content, params.query),
        types: renderer.typeLabels(block),
        properties: renderer.view(block, 'brief').visible,
        duplicateIds: duplicates.map(duplicate => duplicate.id),
        duplicateShortIds: duplicates.map(duplicate => shortIds.get(duplicate.id) ?? duplicate.id),
      }
    }),
    nextOffset: more ? end : null,
  }
}

export const renderSearchView = (view: SearchView): string => {
  const filters = [
    view.filter.types.length > 0 ? `types: ${view.filter.types.join(', ')}` : null,
    view.filter.under ? 'under the given block' : null,
    view.filter.includeExtensions ? 'incl. extension source' : null,
  ].filter(Boolean)
  const filterNote = filters.length > 0 ? ` (${filters.join('; ')})` : ''
  if (view.hits.length === 0) {
    return `search "${view.query}"${filterNote}: no ${view.offset > 0 ? 'more ' : ''}matches`
  }
  const range = `${formatCount(view.offset + 1)}–${formatCount(view.offset + view.hits.length)}`
  const next = view.nextOffset === null ? '' : ` (more: offset=${view.nextOffset})`
  const lines = [`search "${view.query}"${filterNote}: results ${range}${next}`]
  view.hits.forEach((hit, index) => {
    const meta = [
      hit.types.length > 0 ? `type:: ${hit.types.join(', ')}` : null,
      ...hit.properties.slice(0, 2).map(property => `${property.name}:: ${property.value}`),
    ].filter(Boolean).join('  ')
    const duplicates = hit.duplicateShortIds.length > 0
      ? `  (+${hit.duplicateShortIds.length} identical: ${hit.duplicateShortIds.map(id => `^${id}`).join(', ')})`
      : ''
    lines.push(`${view.offset + index + 1}. ^${hit.shortId}  ${crumbLine(hit.breadcrumb)}${duplicates}`)
    lines.push(`   ${hit.snippet}${meta ? `  ${meta}` : ''}`)
  })
  return lines.join('\n')
}
