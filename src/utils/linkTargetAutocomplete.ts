import type { BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties.js'
import {
  searchSourcesFacet,
  type SearchSourceArgs,
  type SearchSourceCandidate,
  type SearchSourceContribution,
} from '@/data/facets.js'
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
    query,
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

/** Core's own content search, expressed as the default `searchSourcesFacet`
 *  contribution (id `'core.content'`) — a thin wrapper over the kernel
 *  `searchByContent` query plus the pre-existing text-relevance score, so
 *  it slots into the merge point below exactly like a plugin-contributed
 *  source (e.g. a future semantic-search extension) would. Registered in
 *  `kernelDataExtension.ts` so it's present on every `Repo` (kernel-only
 *  or full app runtime), matching how the other kernel query/mutator
 *  defaults are wired. */
export const coreContentSearchSource: SearchSourceContribution = {
  id: 'core.content',
  search: async (repo, {workspaceId, query, limit, recentBlockIds}) => {
    // Over-fetch so the score below (which promotes exact/prefix/recent
    // hits over the SQL engine's own rank) has room to reorder before the
    // merge point's final slice to `limit`. Same multiplier/ceiling as the
    // alias fuzzy search above — one over-fetch policy for this file.
    // Floored at `limit` itself: a caller asking for more than the
    // ceiling must still get `limit` rows back, not silently truncated to
    // the ceiling (the ceiling is a headroom cap for the common case, not
    // a hard maximum on the result size).
    const fetchLimit = Math.max(limit, Math.min(limit * ALIAS_CANDIDATE_MULTIPLIER, ALIAS_CANDIDATE_CEILING))
    const rows = await repo.query.searchByContent({workspaceId, query, limit: fetchLimit}).load()
    return rows.map((block): SearchSourceCandidate => ({
      block,
      score: blockSearchTextScore(block.content, query) +
        blockSearchRecencyBoost(block.id, recentBlockIds),
    }))
  },
}

/** Of two candidates for the SAME block id, pick which one's `block`
 *  payload should survive the merge. Ranking always uses the max score
 *  across duplicates (see `searchBlocksAcrossSources`), but the payload
 *  itself can come from a stale index copy — e.g. a semantic-search
 *  source's own snapshot of the block lagging live data — so prefer
 *  whichever candidate's `block.userUpdatedAt` (the user-facing
 *  "last edited" timestamp, `src/data/api/blockData.ts`) is newest,
 *  falling back to the higher-scored candidate when timestamps tie or
 *  either is missing/non-numeric. */
const freshestCandidatePayload = (
  a: SearchSourceCandidate,
  b: SearchSourceCandidate,
): SearchSourceCandidate => {
  const aTime = a.block.userUpdatedAt
  const bTime = b.block.userUpdatedAt
  if (typeof aTime === 'number' && typeof bTime === 'number' && aTime !== bTime) {
    return aTime > bTime ? a : b
  }
  return a.score >= b.score ? a : b
}

/** Fan out `query` to every contributed `searchSourcesFacet` source (core's
 *  content search plus whatever plugins add), merge their candidates, and
 *  rank by `score` descending — the shared substrate behind link-target
 *  search below, and every other block-content search surface
 *  (block-ref insertion completion, the agent `search` command). With no
 *  extra sources contributed this degenerates to exactly
 *  `coreContentSearchSource`'s own ranking — same query, same score, same
 *  order as before this facet existed.
 *
 *  A source that throws is logged and dropped so one bad contribution
 *  can't fail every consumer's search — AS LONG AS at least one other
 *  source succeeds. If every contributed source throws (including the
 *  common single-source case, where core is the only contribution), the
 *  first error is rethrown instead of resolving to an empty result —
 *  matching the pre-facet behavior where a failed `searchByContent` call
 *  surfaced to the caller (agent `search` returned `{ok:false}`;
 *  quick-find's progressive-search fence threw). Ties (equal score) keep
 *  the order candidates were produced in — `Array.prototype.sort` is
 *  stable, and that order is source-registration order then
 *  within-source order — so a single-source call reproduces that
 *  source's own ordering exactly. Same block id from two sources
 *  survives once, ranked at the MAX score across the duplicates; its
 *  `block` payload is picked by `freshestCandidatePayload` (newest
 *  `userUpdatedAt` wins, falling back to the higher-scored candidate on
 *  a tie/missing timestamp) so a stale index copy can't shadow live
 *  data just because it scored higher.
 *
 *  A `repo` with no `FacetRuntime` wired (a hand-built test double, or a
 *  `Repo` read before its first `setFacetRuntime`) still gets core
 *  content search — the facet is an ADDITIVE seam on top of "search
 *  works", not a hard prerequisite for it. */
export const searchBlocksAcrossSources = async (
  repo: Repo,
  args: SearchSourceArgs,
): Promise<BlockData[]> => {
  if (args.limit <= 0) return []

  const sources = repo.facetRuntime?.read(searchSourcesFacet)
  const contributions = sources && sources.size > 0
    ? [...sources.values()]
    : [coreContentSearchSource]

  const failures: {index: number; error: unknown}[] = []
  const candidateLists = await Promise.all(
    contributions.map(async (source, index) => {
      try {
        return await source.search(repo, args)
      } catch (error) {
        console.error(`[searchBlocksAcrossSources] source "${source.id}" threw`, error)
        failures.push({index, error})
        return []
      }
    }),
  )

  // Every source failed (including the single-source case) — there is
  // nothing to rank, and silently returning [] would hide the failure
  // from every consumer. Rethrow deterministically by contribution
  // order, not settle order.
  if (failures.length === contributions.length) {
    failures.sort((a, b) => a.index - b.index)
    throw failures[0].error
  }

  const merged = candidateLists.flat()

  const byId = new Map<string, SearchSourceCandidate>()
  for (const candidate of merged) {
    const existing = byId.get(candidate.block.id)
    if (!existing) {
      byId.set(candidate.block.id, candidate)
      continue
    }
    const payload = freshestCandidatePayload(existing, candidate)
    byId.set(candidate.block.id, {
      block: payload.block,
      score: Math.max(existing.score, candidate.score),
    })
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, args.limit)
    .map(candidate => candidate.block)
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
  // Routed through the shared multi-source merge point (not a direct
  // `searchByContent` call) so a contributed `searchSourcesFacet` source
  // participates here too. `searchBlocksAcrossSources` internally
  // over-fetches and reorders (MRU / raw-text wins promoted) before its
  // own slice to `limit` — see `coreContentSearchSource`. It only
  // rejects when EVERY contributed source failed; the ok/error fence
  // below turns that rejection into the `throw` further down, so a
  // total search failure still surfaces to this call's caller (not a
  // silently empty result) — same as calling `searchByContent` directly
  // did before this facet existed.
  const blockRowsPromise = trimmed.length >= MIN_CONTENT_SEARCH_LEN
    ? searchBlocksAcrossSources(repo, {
        workspaceId,
        query: trimmed,
        limit,
        recentBlockIds,
      }).then(
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

  const blocks = blockMatchesFromRows(blockRows.rows, seenBlockIds)
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
