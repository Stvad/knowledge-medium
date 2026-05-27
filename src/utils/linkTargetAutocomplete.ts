import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties.js'
import { buildFilterPrefixes, rankCandidates } from '@/utils/fuzzyRank.js'

/** How many candidate rows to pull from SQL before JS ranking. The pre-
 *  filter is permissive (token-prefix LIKE), so over-fetching gives the
 *  ranker enough material to find typo / out-of-order matches even when
 *  the display limit is small. */
const ALIAS_CANDIDATE_MULTIPLIER = 4
const ALIAS_CANDIDATE_CEILING = 200

/** Minimum trimmed query length before the content substring scan runs.
 *  Shorter prefixes match a huge fraction of any non-trivial workspace
 *  and produce no useful ranking signal, while the underlying LIKE scan
 *  is O(total content bytes) regardless of result count. Aliases are
 *  index-backed and meaningful at any length, so they still fire below
 *  this threshold. */
const MIN_CONTENT_SEARCH_LEN = 3

export interface LinkTargetAliasMatch {
  alias: string
  blockId: string
  content: string
}

export interface LinkTargetBlockMatch {
  blockId: string
  content: string
  label: string
}

export interface LinkTargetSearchResult {
  aliases: LinkTargetAliasMatch[]
  blocks: LinkTargetBlockMatch[]
}

export interface ProgressiveLinkTargetSearchCallbacks {
  onAliases?: (aliases: LinkTargetAliasMatch[]) => void
  onBlocks?: (blocks: LinkTargetBlockMatch[], result: LinkTargetSearchResult) => void
}

export interface LinkTargetIdCandidate {
  id: string
  label: string
  detail: string
}

export interface LinkTargetValueCandidate {
  key: string
  value: string
  label: string
  detail: string
}

export const labelForBlockData = (
  data: BlockData | null | undefined,
  fallback: string,
): string => {
  const aliases = data?.properties[aliasesProp.name]
  if (Array.isArray(aliases)) {
    const alias = aliases.find((value): value is string => typeof value === 'string' && value.trim() !== '')
    if (alias) return alias
  }
  const content = data?.content?.trim()
  return content || fallback
}

const stringSet = (values?: Iterable<string>): Set<string> =>
  new Set(values ?? [])

const aliasMatchesFromRows = (
  rows: LinkTargetAliasMatch[],
  seenBlockIds: Set<string>,
): LinkTargetAliasMatch[] => {
  const aliases: LinkTargetAliasMatch[] = []
  for (const row of rows) {
    if (seenBlockIds.has(row.blockId)) continue
    seenBlockIds.add(row.blockId)
    aliases.push({
      alias: row.alias,
      blockId: row.blockId,
      content: row.content,
    })
  }
  return aliases
}

const blockMatchesFromRows = (
  rows: BlockData[],
  seenBlockIds: Set<string>,
): LinkTargetBlockMatch[] => {
  const blocks: LinkTargetBlockMatch[] = []
  for (const block of rows) {
    if (seenBlockIds.has(block.id)) continue
    seenBlockIds.add(block.id)
    blocks.push({
      blockId: block.id,
      content: block.content,
      label: labelForBlockData(block, block.id),
    })
  }
  return blocks
}

export const searchAliasLabels = async (
  repo: Repo,
  {
    workspaceId,
    query,
    recentBlockIds,
    limit = 50,
  }: {
    workspaceId: string
    query: string
    recentBlockIds?: ReadonlyArray<string>
    limit?: number
  },
): Promise<string[]> => {
  if (!workspaceId) return []
  const trimmed = query.trim()
  // Empty query falls back to the legacy distinct-alias list (oldest-
  // first) — there is no per-row recency signal to rank against, and
  // the existing surfaces (RefPropertyEditor "browse all") expect a
  // deterministic alphabet-ish order.
  if (!trimmed) {
    return repo.query.aliasesInWorkspace({workspaceId, filter: ''}).load()
  }

  const rows = await runFuzzyAliasSearch(repo, {
    workspaceId,
    query: trimmed,
    recentBlockIds,
    limit,
  })

  const seen = new Set<string>()
  const labels: string[] = []
  for (const row of rows) {
    if (seen.has(row.alias)) continue
    seen.add(row.alias)
    labels.push(row.alias)
  }
  return labels
}

interface FuzzyAliasRow {
  alias: string
  blockId: string
  content: string
}

const runFuzzyAliasSearch = async (
  repo: Repo,
  {
    workspaceId,
    query,
    recentBlockIds,
    limit,
  }: {
    workspaceId: string
    query: string
    recentBlockIds?: ReadonlyArray<string>
    limit: number
  },
): Promise<FuzzyAliasRow[]> => {
  const prefixes = buildFilterPrefixes(query)
  const fetchLimit = Math.min(limit * ALIAS_CANDIDATE_MULTIPLIER, ALIAS_CANDIDATE_CEILING)
  const candidates = await repo.query.aliasMatchesFuzzy({
    workspaceId,
    prefixes,
    limit: fetchLimit,
  }).load()

  const ranked = rankCandidates({
    candidates: candidates.map(row => ({
      blockId: row.blockId,
      label: row.alias,
      updatedAt: row.updatedAt,
      content: row.content,
    })),
    query,
    recentBlockIds,
  })

  return ranked
    .slice(0, limit)
    .map(item => ({
      alias: item.candidate.label,
      blockId: item.candidate.blockId,
      content: (item.candidate as {content: string}).content,
    }))
}

export const searchAliasMatches = async (
  repo: Repo,
  args: {
    workspaceId: string
    query: string
    recentBlockIds?: ReadonlyArray<string>
    limit: number
  },
): Promise<LinkTargetAliasMatch[]> => {
  if (!args.workspaceId) return []
  const trimmed = args.query.trim()
  if (!trimmed) return []
  const rows = await runFuzzyAliasSearch(repo, {
    workspaceId: args.workspaceId,
    query: trimmed,
    recentBlockIds: args.recentBlockIds,
    limit: args.limit,
  })
  return rows.map(row => ({
    alias: row.alias,
    blockId: row.blockId,
    content: row.content,
  }))
}

export const searchLinkTargets = async (
  repo: Repo,
  {
    workspaceId,
    query,
    limit,
    excludeBlockIds,
    recentBlockIds,
  }: {
    workspaceId: string
    query: string
    limit: number
    excludeBlockIds?: Iterable<string>
    recentBlockIds?: ReadonlyArray<string>
  },
): Promise<LinkTargetSearchResult> => {
  const trimmed = query.trim()
  if (!workspaceId || !trimmed) return {aliases: [], blocks: []}

  return searchLinkTargetsProgressively(repo, {
    workspaceId,
    query: trimmed,
    limit,
    excludeBlockIds,
    recentBlockIds,
  })
}

const SCORE_BLOCK_FULL_EXACT = 300
const SCORE_BLOCK_FULL_PREFIX = 200
const SCORE_BLOCK_FULL_SUBSTRING = 100
const SCORE_BLOCK_RECENT_MRU_HEAD = 80
const SCORE_BLOCK_RECENT_MRU_STEP = 6

const blockSearchRecencyBoost = (
  blockId: string,
  recentBlockIds: ReadonlyArray<string> | undefined,
): number => {
  if (!recentBlockIds) return 0
  const idx = recentBlockIds.indexOf(blockId)
  if (idx === -1) return 0
  return Math.max(SCORE_BLOCK_RECENT_MRU_HEAD - idx * SCORE_BLOCK_RECENT_MRU_STEP, 0)
}

const blockSearchTextScore = (content: string, query: string): number => {
  const lowerContent = content.toLowerCase()
  const lowerQuery = query.toLowerCase().trim()
  if (!lowerQuery) return 0
  if (lowerContent === lowerQuery) return SCORE_BLOCK_FULL_EXACT
  if (lowerContent.startsWith(lowerQuery)) return SCORE_BLOCK_FULL_PREFIX
  const idx = lowerContent.indexOf(lowerQuery)
  if (idx === -1) return 0
  return SCORE_BLOCK_FULL_SUBSTRING - Math.min(idx, SCORE_BLOCK_FULL_SUBSTRING)
}

const orderBlockSearchRows = (
  rows: BlockData[],
  query: string,
  recentBlockIds: ReadonlyArray<string> | undefined,
  limit: number,
): BlockData[] => {
  const scored = rows.map((row, index) => ({
    row,
    index,
    score: blockSearchTextScore(row.content, query) +
      blockSearchRecencyBoost(row.id, recentBlockIds),
  }))
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.index - b.index
  })
  return scored.slice(0, limit).map(item => item.row)
}

export const searchLinkTargetsProgressively = async (
  repo: Repo,
  {
    workspaceId,
    query,
    limit,
    excludeBlockIds,
    recentBlockIds,
  }: {
    workspaceId: string
    query: string
    limit: number
    excludeBlockIds?: Iterable<string>
    recentBlockIds?: ReadonlyArray<string>
  },
  callbacks: ProgressiveLinkTargetSearchCallbacks = {},
): Promise<LinkTargetSearchResult> => {
  const trimmed = query.trim()
  if (!workspaceId || !trimmed) return {aliases: [], blocks: []}

  const aliasRowsPromise = searchAliasMatches(repo, {
    workspaceId,
    query: trimmed,
    limit,
    recentBlockIds,
  })
  // Over-fetch content matches so the block orderer has room to promote
  // MRU / raw-text wins before the final display limit is applied.
  const fetchLimit = Math.min(limit * ALIAS_CANDIDATE_MULTIPLIER, ALIAS_CANDIDATE_CEILING)
  const blockRowsPromise = trimmed.length >= MIN_CONTENT_SEARCH_LEN
    ? repo.query.searchByContent({
        workspaceId,
        query: trimmed,
        limit: fetchLimit,
      }).load().then(
        rows => ({ok: true as const, rows}),
        error => ({ok: false as const, error}),
      )
    : null

  const seenBlockIds = stringSet(excludeBlockIds)
  const aliases = aliasMatchesFromRows(await aliasRowsPromise, seenBlockIds)
  callbacks.onAliases?.(aliases)

  if (blockRowsPromise === null) {
    const result = {aliases, blocks: []}
    callbacks.onBlocks?.(result.blocks, result)
    return result
  }

  const blockRows = await blockRowsPromise
  if (!blockRows.ok) throw blockRows.error

  const orderedBlockRows = orderBlockSearchRows(blockRows.rows, trimmed, recentBlockIds, limit)
  const blocks = blockMatchesFromRows(orderedBlockRows, seenBlockIds)
  const result = {aliases, blocks}
  callbacks.onBlocks?.(blocks, result)
  return result
}

export const searchLinkTargetIdCandidates = async (
  repo: Repo,
  args: {
    workspaceId: string
    query: string
    limit: number
    excludeIds?: Iterable<string>
  },
): Promise<LinkTargetIdCandidate[]> => {
  const matches = await searchLinkTargets(repo, {
    workspaceId: args.workspaceId,
    query: args.query,
    limit: args.limit,
    excludeBlockIds: args.excludeIds,
  })

  return [
    ...matches.aliases.map((row): LinkTargetIdCandidate => ({
      id: row.blockId,
      label: row.alias,
      detail: row.content,
    })),
    ...matches.blocks.map((block): LinkTargetIdCandidate => ({
      id: block.blockId,
      label: block.label,
      detail: block.content,
    })),
  ].slice(0, args.limit)
}

export const searchLinkTargetValueCandidates = async (
  repo: Repo,
  args: {
    workspaceId: string
    query: string
    limit: number
    excludeValues?: Iterable<string>
  },
): Promise<LinkTargetValueCandidate[]> => {
  const matches = await searchLinkTargets(repo, {
    workspaceId: args.workspaceId,
    query: args.query,
    limit: args.limit,
  })
  const seenValues = stringSet(args.excludeValues)
  const candidates: LinkTargetValueCandidate[] = []

  const pushCandidate = (candidate: LinkTargetValueCandidate) => {
    const value = candidate.value.trim()
    if (!value || seenValues.has(value)) return
    seenValues.add(value)
    candidates.push({...candidate, value})
  }

  for (const row of matches.aliases) {
    pushCandidate({
      key: `alias:${row.blockId}:${row.alias}`,
      value: row.alias,
      label: row.alias,
      detail: row.content,
    })
  }
  for (const block of matches.blocks) {
    pushCandidate({
      key: `block:${block.blockId}`,
      value: block.label,
      label: block.label,
      detail: block.content,
    })
  }

  return candidates.slice(0, args.limit)
}
