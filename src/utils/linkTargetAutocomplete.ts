import type { BlockData, TypeContribution } from '@/data/api'
import type { Repo } from '@/data/repo'
import { aliasesProp, hasOpaqueContent, typesProp } from '@/data/properties.js'
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
const EMPTY_OPAQUE_TYPES: ReadonlySet<string> = new Set()

const ALIAS_CANDIDATE_MULTIPLIER = 4
const ALIAS_CANDIDATE_CEILING = 200

/** Upper bound on the extra rows fetched to make room for
 *  `excludeBlockIds` — see `searchLinkTargetsProgressively`. Generous
 *  relative to any display limit (which is 25 in every caller today), so
 *  the shortfall it guards against only reappears for exclusion sets in
 *  the hundreds. */
const EXCLUSION_HEADROOM_CEILING = 200

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

/** One row of the `[[` completion dropdown: the alias to insert plus the
 *  block's type ids, which the wiring turns into the muted hint shown
 *  beside it (see {@link completionTypeHint}). Type ids rather than a
 *  resolved string so this stays a pure data read — the registry that
 *  names them is a UI-time concern. */
export interface AliasCompletionCandidate {
  label: string
  typeIds: readonly string[]
}

export interface LinkTargetBlockMatch {
  blockId: string
  content: string
  label: string
  /** The block's own parent edge. Carried so a consumer showing the
   *  block's ancestry can tell "this block has no parent" from "its
   *  parent was excluded from the ancestor walk" — an empty ancestor
   *  chain looks identical either way (see `crumbsFromAncestors`). */
  parentId: string | null
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

/** The type name shown beside a `[[` completion candidate, or
 *  `undefined` when the row has nothing worth saying.
 *
 *  Reuses the `hideFromBlockDisplay` rule rather than inventing a second
 *  one: a type whose chip is suppressed on the block itself is plumbing
 *  (`page` sits on every page, so annotating every row with it is pure
 *  noise), and the same judgement applies in the dropdown. Unknown ids
 *  are skipped too — `TypeChipsDecorator` keeps them visible so a tag
 *  never silently disappears from a block the user is looking at, but
 *  here there is no label to render and a raw uuid is worse than no
 *  hint. First surviving type wins; the dropdown row has space for one. */
export const completionTypeHint = (
  typeIds: readonly string[],
  registry: ReadonlyMap<string, TypeContribution>,
): string | undefined => {
  for (const typeId of typeIds) {
    const type = registry.get(typeId)
    if (!type || type.hideFromBlockDisplay === true) continue
    const label = type.label?.trim()
    if (label) return label
  }
  return undefined
}

/** The block's type ids, tolerant of a malformed stored value.
 *
 *  Deliberately NOT `getBlockTypes` (`@/data/properties`), which runs
 *  the string-list codec and THROWS a `CodecError` on a non-array or a
 *  non-string entry. A raw properties-bag write — the agent-runtime
 *  `updateBlock` verb, an importer, a sync-applied row — can land
 *  either, and a throw here rejects out through `getAliases` with no
 *  try/catch above it, emptying the whole `[[` dropdown (relative-date
 *  completions included) rather than just dropping one hint.
 *
 *  Nor would a try/catch around `getBlockTypes` be right: it is
 *  all-or-nothing, so `['page', null, 'person']` would yield NO types,
 *  while the `block_types` trigger backing the other path keeps
 *  `page` and `person`. Filtering per entry is what makes the two
 *  paths agree — same rule as the trigger's
 *  `WHERE typeof(je.value) = 'text'` (`clientSchema.ts`) and the
 *  invalidation rule's `Array.isArray` + `typeof` filter
 *  (`kernelInvalidation.ts`). */
const readTypeIds = (data: BlockData): readonly string[] => {
  const raw = data.properties[typesProp.name]
  if (!Array.isArray(raw)) return []
  return raw.filter((typeId): typeId is string => typeof typeId === 'string')
}

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
      parentId: block.parentId,
    })
  }
  return blocks
}

/** Types for a bounded set of already-chosen blocks, as a lookup keyed
 *  by block id. One `block_types` read for the whole page of results:
 *  the index is keyed `(block_id, type)`, so this is `ids.length` seeks
 *  and stays flat as the workspace grows — unlike folding the types into
 *  the fuzzy pre-filter, which would pay per *scanned* row rather than
 *  per *displayed* one. */
const loadTypeIdsByBlock = async (
  repo: Repo,
  workspaceId: string,
  blockIds: string[],
): Promise<Map<string, string[]>> => {
  const byBlock = new Map<string, string[]>()
  if (blockIds.length === 0) return byBlock
  const rows = await repo.query.blockTypesByIds({workspaceId, blockIds}).load()
  for (const row of rows) {
    const existing = byBlock.get(row.blockId)
    if (existing) existing.push(row.type)
    else byBlock.set(row.blockId, [row.type])
  }
  return byBlock
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
): Promise<AliasCompletionCandidate[]> => {
  if (!workspaceId) return []
  const trimmed = query.trim()
  // Bare `[[` is a suggestion surface, not "browse all aliases". Loading
  // every workspace alias here made the first request dominate completion
  // latency, and CodeMirror doesn't start the superseding `[[query` request
  // until this one settles. The navigation MRU is already bounded (10 ids),
  // usually cache-hot, and is the useful zero-input ordering anyway.
  if (!trimmed) {
    const blocks = await Promise.all(
      (recentBlockIds ?? []).map(blockId => repo.block(blockId).load()),
    )
    const seen = new Set<string>()
    const candidates: AliasCompletionCandidate[] = []
    for (const block of blocks) {
      if (!block || block.workspaceId !== workspaceId) continue
      const aliases = block.properties[aliasesProp.name]
      if (!Array.isArray(aliases)) continue
      // These rows are whole blocks already (the MRU path loads them to
      // read aliases), so their types come along for free — no
      // `block_types` round trip on the zero-input path.
      const typeIds = readTypeIds(block)
      for (const alias of aliases) {
        if (typeof alias !== 'string' || alias.trim() === '' || seen.has(alias)) continue
        seen.add(alias)
        candidates.push({label: alias, typeIds})
        if (candidates.length === limit) return candidates
      }
    }
    return candidates
  }

  const rows = await runFuzzyAliasSearch(repo, {
    workspaceId,
    query: trimmed,
    recentBlockIds,
    limit,
  })

  // One row per alias STRING, since that string is what gets inserted.
  const firstByAlias = new Map<string, FuzzyAliasRow>()
  for (const row of rows) {
    if (!firstByAlias.has(row.alias)) firstByAlias.set(row.alias, row)
  }
  const surviving = [...firstByAlias.values()]

  // Claimant counts come from `block_aliases`, NOT from `rows`. `rows`
  // has already been ranked and sliced to the display limit, so a second
  // claimant that fell below the cutoff would be invisible here and the
  // alias would look uncontested — showing the truncated winner's type
  // for a link that resolves elsewhere. Runs alongside the type read
  // rather than after it, so the extra lookup costs no round trip.
  const [typeIdsByBlock, claimantCounts] = await Promise.all([
    loadTypeIdsByBlock(repo, workspaceId, [...new Set(surviving.map(row => row.blockId))]),
    repo.query.aliasClaimantCounts({
      workspaceId,
      aliases: surviving.map(row => row.alias),
    }).load(),
  ])
  const contested = new Set(
    claimantCounts.filter(row => row.claimants > 1).map(row => row.alias),
  )
  return surviving.map(row => ({
    label: row.alias,
    // A contested alias gets NO hint. Accepting the completion inserts
    // the alias text, which `core.aliasLookup` resolves to the OLDEST
    // claimant — not necessarily the row ranking put on top. Showing the
    // top row's type would then describe a different block than the link
    // actually goes to, and co-claims are a documented latent state (the
    // alias-uniqueness trigger is skipped for sync-applied rows). Saying
    // nothing is the only answer that can't be wrong.
    typeIds: contested.has(row.alias) ? [] : typeIdsByBlock.get(row.blockId) ?? [],
  }))
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
/** Second-pass window when opaque rows crowded out the first. Headroom
 *  RELATIVE to what was just fetched, never a fixed ceiling: `fetchLimit`
 *  floors at `limit`, so for any `limit >= ALIAS_CANDIDATE_CEILING` (the
 *  agent search command forwards an unbounded one) a ceiling-valued window
 *  is no bigger than the fetch that just came up short — the recovery would
 *  be dead exactly where the window is largest. Exported because that is an
 *  arithmetic property, testable without seeding 200 rows. */
export const widenedFetchLimit = (fetchLimit: number): number =>
  Math.max(ALIAS_CANDIDATE_CEILING, fetchLimit * 2)

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
    // An installed extension's stored source is not prose to search. This
    // powers quick-find, block-ref completion and the agent search command,
    // so without it a bundle surfaces as an ordinary linkable result and a
    // user can pick it as a reference target. Filtered here rather than in
    // `core.searchByContent` because that kernel query is also how you'd
    // legitimately go LOOKING for an extension by its source.
    const opaqueTypes = repo.opaqueContentTypes
    const eligible = (rows: readonly BlockData[]): SearchSourceCandidate[] => rows
      .filter(block => !hasOpaqueContent(block, opaqueTypes))
      .map((block): SearchSourceCandidate => ({
        block,
        score: blockSearchTextScore(block.content, query) +
          blockSearchRecencyBoost(block.id, recentBlockIds),
      }))

    const rows = await repo.query.searchByContent({workspaceId, query, limit: fetchLimit}).load()
    let candidates = eligible(rows)
    // The filter runs after the SQL limit, so opaque rows consume the
    // over-fetch window — enough of them ranked above a prose match and the
    // caller sees no content result at all, with no way to page past them.
    // Widen once to the ceiling when the window came back short AND was
    // actually full (a short read means the corpus is exhausted, not crowded).
    const widenedLimit = widenedFetchLimit(fetchLimit)
    if (candidates.length < limit && rows.length >= fetchLimit && widenedLimit > fetchLimit) {
      const widened = await repo.query
        .searchByContent({workspaceId, query, limit: widenedLimit}).load()
      candidates = eligible(widened)
    }
    return candidates
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

  // Ask every source for HEADROOM, not for `limit`. The opaque filter below
  // runs after each source has already applied its own limit, so a source
  // that honours `limit: 1` and whose top hit is opaque hands back nothing
  // recoverable — core's widening only covers core's own window. Sources
  // are documented as free to return more than asked; this makes the
  // request itself generous instead of relying on that.
  const sourceArgs: SearchSourceArgs = {
    ...args,
    limit: Math.max(args.limit, Math.min(args.limit * ALIAS_CANDIDATE_MULTIPLIER, ALIAS_CANDIDATE_CEILING)),
  }
  const failures: {index: number; error: unknown}[] = []
  const candidateLists = await Promise.all(
    contributions.map(async (source, index) => {
      try {
        return await source.search(repo, sourceArgs)
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

  // Enforced HERE, not per-source, so the guarantee holds for every
  // contribution — a semantic-search plugin has no reason to know that some
  // blocks' content is not prose, and a contract that requires each source
  // to remember is a contract that gets forgotten. The core source filters
  // too, but only to decide whether its own window needs widening; this is
  // the authoritative pass.
  //
  // Against LIVE types, not the candidate's own `properties`: a source may
  // legitimately return a stale index snapshot (that is exactly why
  // `freshestCandidatePayload` exists), and a payload from before the block
  // gained an opaque type would sail through a check of its own bag. One
  // batched `block_types` read for the whole merged set — the same index
  // `loadTypeIdsByBlock` uses, so it is `ids.length` seeks, not a scan.
  // `?? EMPTY` because callers stub `Repo` (this helper only needs `query`
  // and the facet runtime); a stub without the getter means "nothing is
  // opaque", not a crash inside search.
  const opaqueTypes = repo.opaqueContentTypes ?? EMPTY_OPAQUE_TYPES
  const flat = candidateLists.flat()
  const liveTypes = opaqueTypes.size === 0
    ? new Map<string, string[]>()
    : await loadTypeIdsByBlock(
      repo,
      args.workspaceId,
      [...new Set(flat.map(candidate => candidate.block.id))],
    )
  const merged = opaqueTypes.size === 0 ? flat : flat.filter(candidate =>
    !(liveTypes.get(candidate.block.id) ?? []).some(type => opaqueTypes.has(type)))

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

  const seenBlockIds = stringSet(excludeBlockIds)
  // Every source slices to its own `limit` BEFORE `excludeBlockIds` is
  // applied (below, once the rows are back), so the exclusions come out
  // of the display budget rather than out of the rows behind it. Fine for
  // the one-id exclusions most callers pass; not fine for a set — the
  // move picker excludes an entire subtree, and a big subtree whose
  // blocks match the query can fill all `limit` slots and answer "No
  // results" while real targets sat just past the cut. Fetch headroom
  // equal to the exclusion set and slice back to `limit` after filtering,
  // so the budget always buys `limit` *survivors*.
  // Floored at `limit` itself so a caller asking for more than the
  // ceiling still gets its own limit back rather than a silent truncation
  // (same shape as `coreContentSearchSource`'s fetch limit).
  const fetchLimit = Math.max(
    limit,
    Math.min(limit + seenBlockIds.size, EXCLUSION_HEADROOM_CEILING),
  )

  const aliasRowsPromise = searchAliasMatches(repo, {
    workspaceId,
    query: trimmed,
    limit: fetchLimit,
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
        limit: fetchLimit,
        recentBlockIds,
      }).then(
        rows => ({ok: true as const, rows}),
        error => ({ok: false as const, error}),
      )
    : null

  // `aliasMatchesFromRows` doesn't just READ the set, it RECORDS every
  // match it keeps — which is how a block that matched by alias avoids
  // appearing again in the Blocks group. That only works if the set it
  // records into holds the aliases that actually SURVIVE the slice: the
  // headroom above means it now sees candidates that are fetched and then
  // dropped, and recording those would suppress their blocks from the
  // Blocks group too. A block with the 26th-best alias and the best
  // content match would then appear in neither. So the alias pass gets a
  // throwaway copy, and the Blocks pass dedupes against the exclusions
  // plus the aliases that are really on screen.
  const aliases = aliasMatchesFromRows(await aliasRowsPromise, new Set(seenBlockIds))
    .slice(0, limit)
  callbacks.onAliases?.(aliases)

  const blockSeenIds = new Set(seenBlockIds)
  for (const alias of aliases) blockSeenIds.add(alias.blockId)

  if (blockRowsPromise === null) {
    const result = {aliases, blocks: []}
    callbacks.onBlocks?.(result.blocks, result)
    return result
  }

  const blockRows = await blockRowsPromise
  if (!blockRows.ok) throw blockRows.error

  const blocks = blockMatchesFromRows(blockRows.rows, blockSeenIds).slice(0, limit)
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
