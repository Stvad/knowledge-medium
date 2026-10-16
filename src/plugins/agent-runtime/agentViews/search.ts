import type { Repo } from '@/data/repo'
import type { BlockData } from '@/data/api'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import type { BlockSearchFilter } from '@/data/searchFilter'
import { AGENT_VIEW_DEFAULTS } from '@knowledge-medium/agent-cli/protocol'
import { searchBlocksAcrossSources } from '@/utils/linkTargetAutocomplete.js'
import { loadBlocks, loadCrumbs } from './context.ts'
import { createPropertyRenderer, formatPropertyPairs, type PropertyLine } from './properties.ts'
import { displayIds } from './displayIds.ts'
import { clampInt, crumbLine, joinDisplayLines, loadRoot } from './shared.ts'
import { formatCount, snippet } from './text.ts'

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
  omittedProperties: number
  /** The first few other blocks with the same text, folded into this hit;
   *  `duplicateCount` is all of them within the fetched window (complete only
   *  when the view's `duplicateCountsComplete` is set). */
  duplicateIds: string[]
  duplicateShortIds: string[]
  duplicateCount: number
}

export interface SearchView {
  query: string
  filter: {types: string[], under: string | null, includeExtensions: boolean}
  offset: number
  hits: SearchHit[]
  /** Where the next page starts, or null when this is the last. */
  nextOffset: number | null
  /** Set when matches may continue past the deepest window a search fetches,
   *  so an offset cannot reach them: narrow the query instead. */
  windowCap: number | null
  /** Whether each hit's `duplicateCount` counts every identical block: only
   *  once the sources ran dry, since identical blocks ranked past the
   *  fetched window are not seen. Otherwise a count is a lower bound. */
  duplicateCountsComplete: boolean
}

const MAX_RESULTS = 200
/** Fetched up front and deduped as a whole, so pages within it slice ONE
 *  ranking. A page past it fetches a larger window, which sources may rank
 *  differently, so a hit can repeat or be skipped there — accepted over
 *  fetching the maximum window for every search. */
const SEARCH_WINDOW = 100
const MAX_DUPLICATES_SHOWN = 5
const MAX_WINDOW = 2000

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


/** Blocks with the same text, in rank order, each group led by its best. */
const groupIdentical = (blocks: readonly BlockData[]): BlockData[][] => {
  const groups: BlockData[][] = []
  const byKey = new Map<string, BlockData[]>()
  for (const block of blocks) {
    // Exactly identical stored text only: case or spacing can carry meaning (code).
    const key = block.content
    const group = byKey.get(key)
    if (group) group.push(block)
    else {
      const created = [block]
      byKey.set(key, created)
      groups.push(created)
    }
  }
  return groups
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
    : (await loadRoot(repo, params.under, workspaceId, async id => (await loadBlocks(repo, [id]))[0])).root.id
  const filter: BlockSearchFilter = {
    ...(params.types?.length ? {types: resolveTypeIds(repo, params.types)} : {}),
    ...(includeExtensions ? {} : {excludeTypes: [EXTENSION_TYPE]}),
    ...(underId !== undefined ? {underId} : {}),
  }

  // Candidates are whole rows: every search source answers with blocks, and
  // folding compares their content. The window, not row size, is the bound.
  const fetchWindow = async (window: number) => {
    const fetched = await searchBlocksAcrossSources(repo, {workspaceId, query: params.query, limit: window, filter})
    // A contributed source can answer with a block that has left the
    // workspace; its values would decode with this workspace's registries.
    const inWorkspace = fetched.filter(block => block.workspaceId === workspaceId)
    return {groups: groupIdentical(inWorkspace), exhausted: fetched.length < window}
  }

  // Folding identical blocks shrinks the window, so it grows until it holds
  // one distinct hit past this page — or the sources run dry, or the cap.
  const wanted = offset + limit + 1
  let window = Math.min(Math.max(SEARCH_WINDOW, wanted), MAX_WINDOW)
  let {groups, exhausted} = await fetchWindow(window)
  while (groups.length < wanted && !exhausted && window < MAX_WINDOW) {
    window = Math.min(window * 4, MAX_WINDOW)
    ;({groups, exhausted} = await fetchWindow(window))
  }

  const page = groups.slice(offset, offset + limit)
  const shown = page.map(group => group[0])
  const duplicateIds = page.flatMap(group => group.slice(1, 1 + MAX_DUPLICATES_SHOWN).map(block => block.id))
  const [renderer, shortIds, crumbs] = await Promise.all([
    createPropertyRenderer(repo, shown, 'brief'),
    displayIds(repo, [...shown.map(block => block.id), ...duplicateIds]),
    loadCrumbs(repo, shown.map(block => block.id), workspaceId),
  ])
  const end = offset + page.length
  // The listing ends where the window does: no offset reaches past a capped
  // window, which `windowCap` reports instead.
  const more = end < groups.length

  return {
    query: params.query,
    filter: {types: params.types ?? [], under: underId ?? null, includeExtensions},
    offset,
    hits: page.map(group => {
      const [block] = group
      const duplicates = group.slice(1, 1 + MAX_DUPLICATES_SHOWN)
      const properties = renderer.view(block)
      return {
        id: block.id,
        shortId: shortIds.get(block.id) ?? block.id,
        breadcrumb: crumbs.get(block.id) ?? [],
        snippet: snippet(block.content, params.query),
        types: renderer.typeLabels(block),
        properties: properties.visible,
        omittedProperties: properties.omitted,
        duplicateIds: duplicates.map(duplicate => duplicate.id),
        duplicateShortIds: duplicates.map(duplicate => shortIds.get(duplicate.id) ?? duplicate.id),
        duplicateCount: group.length - 1,
      }
    }),
    nextOffset: more ? end : null,
    windowCap: !exhausted && window === MAX_WINDOW ? MAX_WINDOW : null,
    duplicateCountsComplete: exhausted,
  }
}

export const renderSearchView = (view: SearchView): string => {
  const filters = [
    view.filter.types.length > 0 ? `types: ${view.filter.types.join(', ')}` : null,
    view.filter.under ? 'under the given block' : null,
    view.filter.includeExtensions ? 'incl. extension source' : null,
  ].filter(Boolean)
  const filterNote = filters.length > 0 ? ` (${filters.join('; ')})` : ''
  const capNote = view.windowCap === null
    ? null
    : `(matches past #${formatCount(view.windowCap)} are not reachable by offset; narrow the query: more words, types, under)`
  if (view.hits.length === 0) {
    return joinDisplayLines([
      `search "${view.query}"${filterNote}: no ${view.offset > 0 ? 'more ' : ''}matches`,
      ...(capNote ? [capNote] : []),
    ])
  }
  const range = `${formatCount(view.offset + 1)}–${formatCount(view.offset + view.hits.length)}`
  const next = view.nextOffset === null ? '' : ` (more: offset=${view.nextOffset})`
  const lines = [`search "${view.query}"${filterNote}: results ${range}${next}`]
  view.hits.forEach((hit, index) => {
    const meta = [
      hit.types.length > 0 ? `type:: ${hit.types.join(', ')}` : null,
      hit.properties.length + hit.omittedProperties > 0
        ? formatPropertyPairs(hit.properties, hit.omittedProperties)
        : null,
    ].filter(Boolean).join('  ')
    const unlisted = hit.duplicateCount - hit.duplicateShortIds.length
    const duplicates = hit.duplicateCount > 0
      ? `  (+${formatCount(hit.duplicateCount)}${view.duplicateCountsComplete ? '' : ' or more'} identical: ${hit.duplicateShortIds.map(id => `^${id}`).join(', ')}${unlisted > 0 ? `, …+${formatCount(unlisted)} more` : ''})`
      : ''
    lines.push(`${view.offset + index + 1}. ^${hit.shortId}  ${crumbLine(hit.breadcrumb)}${duplicates}`)
    lines.push(`   ${hit.snippet}${meta ? `  ${meta}` : ''}`)
  })
  if (capNote) lines.push(capNote)
  return joinDisplayLines(lines)
}
