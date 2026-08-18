import type { BlockData, TypeContribution } from '@/data/api'
import type { Repo } from '@/data/repo'
import { aliasesProp, typesProp } from '@/data/properties.js'
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
  /** The named block's type ids. Unlike the block rows, alias rows come
   *  from an index join with no properties on it, so these arrive on the
   *  SECOND callback (`onBlocks`, which re-delivers the aliases) and are
   *  `[]` on the first. That keeps the alias paint — the fast half of the
   *  progressive search — exactly as quick as it was.
   *
   *  These describe the block the row OPENS. The `[[` dropdown withholds
   *  a type hint for a contested alias because inserting the text resolves
   *  to the oldest claimant rather than the ranked winner; a quick-find
   *  Pages row carries `blockId` and navigates straight to it, so the same
   *  hazard does not apply. */
  typeIds: readonly string[]
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
  /** Raw type ids, for a consumer that wants to show what KIND of thing
   *  the row is alongside where it lives. Free here — these rows are
   *  whole `BlockData`, so unlike the ancestor chain (a second batched
   *  query) this costs no round trip and lands with the first paint.
   *  Ids rather than resolved labels: the registry that names them is a
   *  UI-time concern, same split as {@link AliasCompletionCandidate}.
   *  Filter with {@link displayableTypes} before rendering. */
  typeIds: readonly string[]
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

export interface DisplayableType {
  typeId: string
  type: TypeContribution
  /** Non-empty and already trimmed — the filter drops anything without
   *  one, so a renderer never has to fall back to the id. */
  label: string
}

/** The types worth showing beside a block on a SUMMARY row — a `[[`
 *  completion candidate, a quick-find result — where the block's own
 *  renderer is not present.
 *
 *  Reuses the `hideFromBlockDisplay` rule rather than inventing a second
 *  one: a type whose chip is suppressed on the block itself is plumbing
 *  (`page` sits on every page, so annotating every row with it is pure
 *  noise), and the same judgement applies here. Note this is a genuine
 *  trade, not a free win — the flag means "redundant given how the block
 *  renders itself" (`todo`'s checkbox conveys todo-ness, so its chip is
 *  duplication), and a summary row shows none of that rendering, so
 *  `#todo` is suppressed here where it would actually have been
 *  informative. Deliberate: one visibility rule the user can reason
 *  about beats a second, surface-specific one they have to discover.
 *
 *  Unknown ids are skipped too — `TypeChipsDecorator` keeps them visible
 *  so a tag never silently disappears from a block the user is looking
 *  at, but here there is no label to render and a raw uuid is worse than
 *  no hint. Deduped: a raw properties-bag write can repeat an id, and
 *  the same chip twice reads as two tags. */
export const displayableTypes = (
  typeIds: readonly string[],
  registry: ReadonlyMap<string, TypeContribution>,
): readonly DisplayableType[] => {
  const seen = new Set<string>()
  const displayable: DisplayableType[] = []
  for (const typeId of typeIds) {
    if (seen.has(typeId)) continue
    seen.add(typeId)
    const type = registry.get(typeId)
    if (!type || type.hideFromBlockDisplay === true) continue
    const label = type.label?.trim()
    if (label) displayable.push({typeId, type, label})
  }
  return displayable
}

/** The type name shown beside a `[[` completion candidate, or
 *  `undefined` when the row has nothing worth saying. First surviving
 *  type wins; the dropdown row has space for one. */
export const completionTypeHint = (
  typeIds: readonly string[],
  registry: ReadonlyMap<string, TypeContribution>,
): string | undefined => displayableTypes(typeIds, registry)[0]?.label

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
export const readTypeIds = (data: BlockData): readonly string[] => {
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
      typeIds: [],
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
      typeIds: readTypeIds(block),
    })
  }
  return blocks
}

/** `core.blockTypesByIds` validates `blockIds` at 200 entries, and a zod
 *  failure REJECTS — a caller asking for 201 rows would lose the whole
 *  search rather than some types. Both of today's display callers are far
 *  under it, but the alias fetch deliberately honours limits above its own
 *  ceiling (`Math.max(limit, …)`), so the ids reaching here are only ever
 *  as bounded as the caller. Chunk instead of trusting that. */
const BLOCK_TYPES_QUERY_MAX_IDS = 200

/** Types for a bounded set of already-chosen blocks, as a lookup keyed
 *  by block id. One `block_types` read per 200 results: the index is
 *  keyed `(block_id, type)`, so this is `ids.length` seeks and stays flat
 *  as the workspace grows — unlike folding the types into the fuzzy
 *  pre-filter, which would pay per *scanned* row rather than per
 *  *displayed* one. */
const loadTypeIdsByBlock = async (
  repo: Repo,
  workspaceId: string,
  blockIds: string[],
): Promise<Map<string, string[]>> => {
  const byBlock = new Map<string, string[]>()
  if (blockIds.length === 0) return byBlock
  const chunks: string[][] = []
  for (let start = 0; start < blockIds.length; start += BLOCK_TYPES_QUERY_MAX_IDS) {
    chunks.push(blockIds.slice(start, start + BLOCK_TYPES_QUERY_MAX_IDS))
  }
  // Concurrent: the chunks are independent reads, and the single-connection
  // VFS serialises them anyway — awaiting in sequence would only add
  // round-trip latency for the same work.
  const results = await Promise.all(
    chunks.map(chunk => repo.query.blockTypesByIds({workspaceId, blockIds: chunk}).load()),
  )
  for (const rows of results) {
    for (const row of rows) {
      const existing = byBlock.get(row.blockId)
      if (existing) existing.push(row.type)
      else byBlock.set(row.blockId, [row.type])
    }
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
  // Types are attached later, by `searchLinkTargets`, once the surviving
  // slice is known — see `LinkTargetAliasMatch.typeIds`.
  return rows.map(row => ({
    alias: row.alias,
    blockId: row.blockId,
    content: row.content,
    typeIds: [],
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

/** Of every candidate contributed for the SAME block id, pick which one's
 *  `block` payload the user sees. Ranking is separate and unaffected: the
 *  merged row is always scored at the MAX across the group, so nothing
 *  here changes which blocks appear or in what order — only WHICH COPY of
 *  a block's content is displayed.
 *
 *  The rule, over the whole group at once:
 *   1. Candidates carrying a finite `userUpdatedAt` outrank every
 *      candidate that doesn't. Newest wins; a timestamp tie falls back to
 *      higher score; a full tie keeps the earliest-encountered candidate
 *      (group order is registration-then-within-source, see
 *      `searchBlocksAcrossSources`).
 *   2. Only when NO candidate in the group carries one does score decide.
 *
 *  Why timestamp-less candidates lose rather than sending the whole group
 *  to score (the reading this replaced): `BlockData.userUpdatedAt` is a
 *  REQUIRED number (`src/data/api/blockData.ts`), so a candidate without
 *  one is a source contract violation, not a legitimate competitor —
 *  `searchBlocksAcrossSources` warns about it. Under the old reading one
 *  malformed candidate disabled the anti-staleness guarantee for every
 *  well-formed candidate beside it: given a live core copy and a stale
 *  index copy that scored higher, adding a third source that forgot the
 *  field displayed the STALE copy. That is the same failure the file
 *  already refuses for a source that throws — one bad source degrades
 *  itself, never its neighbours.
 *
 *  FINITE, not `typeof === 'number'`: `NaN` passes typeof and then loses
 *  every comparison including `NaN !== NaN`, so it would resolve to
 *  whichever candidate a fold happened to hold — order-dependent, the
 *  exact defect this function exists to remove (#450). `Infinity` is
 *  order-independent but wins unconditionally, no better a claim for a
 *  corrupt row. Both count as absent.
 *
 *  Evaluated over the raw group, never as a pairwise running fold: once
 *  two candidates are folded, the survivor's `score` is the running max
 *  across both, so a later comparison pairs one candidate's timestamp
 *  with a score that may belong to a different, already-eliminated one.
 *  That decoupling is what made payload selection order-dependent in
 *  #450. Here only real candidates' own (timestamp, score) pairs are ever
 *  compared. */
const freshestCandidatePayload = (
  candidates: readonly SearchSourceCandidate[],
): SearchSourceCandidate => {
  const timed = candidates.filter(c => Number.isFinite(c.block.userUpdatedAt))
  if (timed.length === 0) {
    return candidates.reduce((best, candidate) => candidate.score > best.score ? candidate : best)
  }
  return timed.reduce((best, candidate) => {
    const bestTime = best.block.userUpdatedAt
    const time = candidate.block.userUpdatedAt
    if (time !== bestTime) return time > bestTime ? candidate : best
    return candidate.score > best.score ? candidate : best
  })
}

/** Sources already reported for contributing a candidate whose
 *  `userUpdatedAt` isn't a finite number. Deduped by source because search
 *  runs on every keystroke — an unguarded warning would bury the one line
 *  the plugin author needs under thousands of copies. Module-scoped, so
 *  it's once per session, not once per search. */
const offContractSourcesWarned = new Set<string>()

/** `BlockData.userUpdatedAt` is a required number, so a candidate without a
 *  finite one is a bug in the source that produced it — and an invisible
 *  one, since the merge point can still rank and even display the block.
 *  Name the source once so it's fixable; `freshestCandidatePayload` handles
 *  the consequence (such a candidate keeps its score but loses the payload
 *  to any well-formed duplicate). */
const warnOnOffContractCandidate = (
  sourceId: string,
  candidates: readonly SearchSourceCandidate[],
): void => {
  if (offContractSourcesWarned.has(sourceId)) return
  const offender = candidates.find(c => !Number.isFinite(c.block.userUpdatedAt))
  if (!offender) return
  offContractSourcesWarned.add(sourceId)
  console.warn(
    `[searchBlocksAcrossSources] source "${sourceId}" returned block ${offender.block.id} ` +
      `with a non-finite userUpdatedAt (${String(offender.block.userUpdatedAt)}). ` +
      `BlockData.userUpdatedAt is required; this candidate still counts toward ranking, ` +
      `but its copy of the block will not be displayed over a well-formed duplicate.`,
  )
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
 *  source's own ordering exactly. Same block id contributed by two or
 *  more sources survives once, ranked at the MAX score across the whole
 *  duplicate group; its `block` payload is picked by
 *  `freshestCandidatePayload` per the contract on `SearchSourceContribution`
 *  (`src/data/facets.ts`), evaluated over the WHOLE group at once
 *  (order-independent — see that function's docblock and issue #450 for
 *  why a pairwise fold over 3+ duplicates isn't).
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
        const candidates = await source.search(repo, args)
        warnOnOffContractCandidate(source.id, candidates)
        return candidates
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

  // Group first, fold second: `freshestCandidatePayload` needs the whole
  // duplicate-id group's raw candidates at once to stay order-independent
  // (see its docblock) — a single-pass running fold over the flat list
  // would re-decouple payload selection from the real per-candidate
  // (timestamp, score) pairs, same as the bug it replaces.
  const groups = new Map<string, SearchSourceCandidate[]>()
  for (const candidate of merged) {
    const bucket = groups.get(candidate.block.id)
    if (bucket) bucket.push(candidate)
    else groups.set(candidate.block.id, [candidate])
  }

  const byId = [...groups.values()].map((group): SearchSourceCandidate => ({
    block: freshestCandidatePayload(group).block,
    score: group.reduce((max, c) => Math.max(max, c.score), -Infinity),
  }))

  return byId
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

  // Only the surviving aliases, and only once they are known — so this
  // starts AFTER the alias paint above and runs alongside the content
  // search already in flight, costing the second paint no extra wait.
  const aliasTypesPromise = loadTypeIdsByBlock(
    repo,
    workspaceId,
    aliases.map(alias => alias.blockId),
  )
  const withTypes = async (): Promise<LinkTargetAliasMatch[]> => {
    const typeIdsByBlock = await aliasTypesPromise
    return aliases.map(alias => ({
      ...alias,
      typeIds: typeIdsByBlock.get(alias.blockId) ?? [],
    }))
  }

  if (blockRowsPromise === null) {
    const result = {aliases: await withTypes(), blocks: []}
    callbacks.onBlocks?.(result.blocks, result)
    return result
  }

  const [blockRows, typedAliases] = await Promise.all([blockRowsPromise, withTypes()])
  if (!blockRows.ok) throw blockRows.error

  const blocks = blockMatchesFromRows(blockRows.rows, blockSeenIds).slice(0, limit)
  const result = {aliases: typedAliases, blocks}
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
