/**
 * Kernel queries — raw SQL constants + `defineQuery` facet contributions
 * for outside-tx reads (UI hooks, search, alias lookup, type
 * filters, tree walks).
 *
 * Surface: SQL constants up top (used by tests, kept stable for plugin
 * authors who want the same queries without going through the facet),
 * then `KERNEL_QUERIES` (Phase 4 chunk B) — the bundle that the kernel
 * data extension and the Repo's construction-time registration consume.
 * Each `defineQuery` wraps a SQL constant and re-declares the same
 * dependencies the legacy `repo.X(id)` factories on `Repo` did.
 *
 * Property-shape note: the new `BlockData.properties` is flat
 * `{name: encodedValue}`, NOT the legacy `{name: {name, type, value}}`
 * record. So `json_extract(properties_json, '$.alias')` returns the
 * encoded value directly (string[] for alias, string for type, etc.).
 * The legacy `'$.alias.value'` paths don't exist anymore.
 */

import { z } from 'zod'
import {
  defineQuery,
  blockPredicateSchema,
  referenceFilterSchema,
  type AnyQuery,
  type BlockData,
  type BlockPredicate,
  type QueryCtx,
  type ResolvedTypedBlockQuery,
  type Schema,
  type SubtreeRow,
  type TypedBlockQueryReferenceFilter,
  type AnyPropertySchema,
} from '@/data/api'
import { SELECT_BLOCK_COLUMNS_SQL, buildQualifiedBlockColumnsSql, type BlockRow } from '@/data/blockSchema'
import { SYSTEM_BLOCK_TYPES, USER_TYPE } from '@/data/blockTypes'
import { userStateRootBlockIds } from '@/data/derivedIds'
import { seedKeyProp } from '@/data/properties'
import { propertyDefinitionBlockId } from '@/data/definitionSeeds'
import type { Repo } from '@/data/repo'
import { refCodecKind } from './refProjection'
import {
  ANCESTORS_SQL,
  CHILDREN_IDS_SQL,
  CHILDREN_SQL,
  manyAncestorsSql,
  SUBTREE_SQL,
  VISIBLE_CHILDREN_IDS_SQL,
  VISIBLE_CHILDREN_SQL,
  VISIBLE_SUBTREE_SQL,
} from './treeQueries'
import {
  assertAncestorWalkBounded,
  buildCandidatesCte,
  compileTypedBlockQuery,
  isSelectiveWhereValue,
  normalizeTypedBlockQuery,
  inlineJsonPath,
} from './typedBlockQuery'
import {
  KERNEL_ALIASES_CHANNEL,
  KERNEL_CONTENT_CHANNEL,
  TYPED_BLOCKS_LIVE_CHANNEL,
  TYPED_BLOCKS_PROPERTY_CHANNEL,
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  TYPED_BLOCKS_TYPE_CHANNEL,
  kernelAliasesKey,
  kernelContentKey,
  typedBlocksLiveKey,
  typedBlocksPropertyKey,
  typedBlocksReferenceFieldKey,
  typedBlocksReferenceKey,
  typedBlocksStructureKey,
  typedBlocksTypeKey,
} from '@/data/invalidation.js'

export const SELECT_BLOCK_BY_ID_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`

/** Type filter — array membership via the trigger-maintained block_types index. */
export const SELECT_BLOCKS_BY_TYPE_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('b')}
  FROM blocks b
  JOIN block_types bt
    ON bt.block_id = b.id
   AND bt.workspace_id = b.workspace_id
  WHERE b.workspace_id = ?
    AND b.deleted = 0
    AND bt.type = ?
  ORDER BY b.created_at ASC, b.id ASC
`

const BLOCKS_CONTENT_FTS_MIN_QUERY_LENGTH = 3

export interface BlocksContentSearchQuery {
  matchQuery: string
  rankQuery: string
}

type ContentSearchToken =
  | {kind: 'term'; text: string; excluded: boolean}
  | {kind: 'operator'; op: 'AND' | 'OR' | 'NOT'}

const quoteFtsPhrase = (text: string): string =>
  `"${text.replace(/"/g, '""')}"`

const stripOuterQuotePair = (query: string): string => {
  const trimmed = query.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
}

const tokenizeContentSearchQuery = (query: string): ContentSearchToken[] => {
  const tokens: ContentSearchToken[] = []
  let i = 0

  const pushTerm = (text: string, excluded: boolean) => {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!excluded && (trimmed === 'AND' || trimmed === 'OR' || trimmed === 'NOT')) {
      tokens.push({kind: 'operator', op: trimmed})
      return
    }
    tokens.push({kind: 'term', text: trimmed, excluded})
  }

  while (i < query.length) {
    while (i < query.length && /\s/.test(query[i] ?? '')) i++
    if (i >= query.length) break

    let excluded = false
    if (query[i] === '-' && i + 1 < query.length && !/\s/.test(query[i + 1] ?? '')) {
      excluded = true
      i++
    }

    if (query[i] === '"') {
      i++
      const start = i
      while (i < query.length && query[i] !== '"') i++
      pushTerm(query.slice(start, i), excluded)
      if (query[i] === '"') i++
      continue
    }

    const start = i
    while (i < query.length && !/\s/.test(query[i] ?? '')) i++
    const text = query.slice(start, i)
    pushTerm(text, excluded)
  }

  return tokens
}

const isTrigramSearchable = (text: string): boolean =>
  text.trim().length >= BLOCKS_CONTENT_FTS_MIN_QUERY_LENGTH

const compilePhraseContentSearchQuery = (query: string): BlocksContentSearchQuery | null => {
  const rankQuery = stripOuterQuotePair(query.trim())
  if (!isTrigramSearchable(rankQuery)) return null
  return {
    matchQuery: quoteFtsPhrase(rankQuery),
    rankQuery,
  }
}

/** Compile QuickFind user text into safe FTS5 trigram MATCH syntax.
 *
 *  Default words become required literal terms (`sync foo` →
 *  `"sync" "foo"`), so multi-word searches match terms anywhere.
 *  User quotes preserve contiguous phrase matching. Uppercase OR and
 *  NOT / -term are the only exposed operators; other punctuation and
 *  operator-looking words are quoted as user text so MATCH does not
 *  surface parser errors in QuickFind.
 */
export const compileBlocksContentSearchQuery = (
  query: string,
): BlocksContentSearchQuery | null => {
  const trimmed = query.trim()
  if (!isTrigramSearchable(trimmed)) return null

  const tokens = tokenizeContentSearchQuery(trimmed)
  const hasPositiveFtsTerm = tokens.some(token =>
    token.kind === 'term' && !token.excluded && isTrigramSearchable(token.text),
  )
  const rankQuery = stripOuterQuotePair(trimmed)
  const clauses: string[][] = [[]]
  const exclusions: string[] = []
  let pendingOr = false
  let pendingNot = false
  let sawPositive = false

  const currentClause = () => clauses[clauses.length - 1]!
  const addPositive = (phrase: string) => {
    if (pendingOr && currentClause().length > 0) {
      clauses.push([])
    }
    currentClause().push(phrase)
    sawPositive = true
    pendingOr = false
    pendingNot = false
  }
  const addRequiredLiteral = (text: string) => {
    if (!isTrigramSearchable(text)) return false
    addPositive(quoteFtsPhrase(text))
    return true
  }

  for (const token of tokens) {
    if (token.kind === 'operator') {
      if (token.op === 'OR') {
        if (sawPositive) pendingOr = true
        else if (!addRequiredLiteral(token.op)) return compilePhraseContentSearchQuery(trimmed)
        continue
      }
      if (token.op === 'NOT') {
        if (sawPositive || hasPositiveFtsTerm) pendingNot = true
        else if (!addRequiredLiteral(token.op)) return compilePhraseContentSearchQuery(trimmed)
        continue
      }
      if (!sawPositive && !addRequiredLiteral(token.op)) return compilePhraseContentSearchQuery(trimmed)
      continue
    }

    if (token.excluded && !hasPositiveFtsTerm) {
      if (!addRequiredLiteral(`-${token.text}`)) return compilePhraseContentSearchQuery(trimmed)
      continue
    }
    if (pendingNot) {
      if (isTrigramSearchable(token.text)) {
        exclusions.push(quoteFtsPhrase(token.text))
      } else {
        return compilePhraseContentSearchQuery(trimmed)
      }
      pendingNot = false
      pendingOr = false
      continue
    }
    if (token.excluded && hasPositiveFtsTerm) {
      if (isTrigramSearchable(token.text)) {
        exclusions.push(quoteFtsPhrase(token.text))
      } else {
        return compilePhraseContentSearchQuery(trimmed)
      }
      pendingOr = false
      continue
    }
    if (!addRequiredLiteral(token.text)) return compilePhraseContentSearchQuery(trimmed)
  }

  const nonEmptyClauses = clauses.filter(clause => clause.length > 0)
  if (nonEmptyClauses.length === 0 && isTrigramSearchable(rankQuery)) return compilePhraseContentSearchQuery(trimmed)
  if (nonEmptyClauses.length === 0) return null

  const positiveExpr = nonEmptyClauses.length === 1
    ? nonEmptyClauses[0]!.join(' ')
    : `(${nonEmptyClauses.map(clause => clause.join(' ')).join(' OR ')})`
  const matchQuery = exclusions.length === 0
    ? positiveExpr
    : `${positiveExpr} ${exclusions.map(phrase => `NOT ${phrase}`).join(' ')}`
  return {matchQuery, rankQuery}
}

/** Escape SQLite LIKE metacharacters (`%`, `_`) and the escape char
 *  itself in a value that must be matched literally inside a LIKE
 *  pattern. Pairs with an explicit `ESCAPE '\'` clause on the SQL side
 *  (we use backslash as the escape char). Without this a user-typed
 *  `_` or `%` acts as a wildcard — `a_b` would match `axb`, and a bare
 *  `%` filter would match every row. Bound `?` params already block SQL
 *  injection; this only fixes LIKE-pattern semantics. Exported (only)
 *  so `kernelQueries.fuzz.test.ts` can differential-test it directly
 *  against real SQLite — every production call site stays internal to
 *  this module. */
export const escapeLikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, c => `\\${c}`)

/** Content search — case-insensitive trigram FTS substring match. */
export const SELECT_BLOCKS_BY_CONTENT_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('b')}
  FROM blocks_fts
  JOIN blocks b
    ON b.id = blocks_fts.block_id
   AND b.workspace_id = blocks_fts.workspace_id
  WHERE blocks_fts.workspace_id = ?
    AND blocks_fts MATCH ?
    AND b.deleted = 0
    AND b.content != ''
  ORDER BY
    CASE
      WHEN LOWER(b.content) = LOWER(?) THEN 0
      WHEN LOWER(b.content) LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END,
    coalesce(b.user_updated_at, b.updated_at) DESC
  LIMIT ?
`

/** Recent non-empty blocks in a workspace, used by empty-query pickers. */
export const SELECT_RECENT_BLOCKS_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
  ORDER BY coalesce(user_updated_at, updated_at) DESC, id ASC
  LIMIT ?
`

/** User pages in a workspace — the seed for deriving that workspace's
 *  app-state roots. */
export const SELECT_USER_PAGE_IDS_SQL = `
  SELECT block_id AS id FROM block_types
   WHERE workspace_id = ? AND type = ?
`

/** `SELECT_RECENT_BLOCKS_SQL` restricted to user-authored rows — the
 *  activity view (Recents), where a panel row or a preferences block is
 *  noise, not an edit.
 *
 *  Three exclusions, and the structural one carries the weight: every
 *  per-user state row (panels, layout sessions, per-plugin prefs and
 *  ui-state, and whatever records a plugin files under them) descends
 *  from one of that user's two state roots, so walking DOWN from those
 *  roots — a set bounded by the UI surface, not by document size — drops
 *  all of it without the kernel knowing any plugin's type ids.
 *
 *  The walk starts at the ROOTS, not at the user page above them: a user
 *  page is an ordinary navigable page, and a note authored directly on it
 *  is content. Only `ui-state` / `user-prefs` and their descendants are
 *  app-owned (`USER_STATE_ROOT_PATHS`).
 *
 *  Then `SYSTEM_BLOCK_TYPES` covers app-owned rows that live at the
 *  workspace root instead, and a `seed:key` property marks a block as a
 *  materialized CODE seed. The seed-key test is what lets the type list
 *  stay narrow: a property-schema or block-type block a user created is
 *  authored content and stays, while the kernel's own definition blocks —
 *  rewritten en masse on a seed revision bump — do not.
 *
 *  All of it sits inside the statement, before the LIMIT: filtering a
 *  fetched window instead would hand back a page short by whatever it
 *  dropped, and a run of ineligible rows would empty it.
 *
 *  The walk deliberately does NOT filter `deleted = 0`, for the same
 *  reason `IS_DESCENDANT_OF_SQL` doesn't: descent is a structural fact
 *  about `parent_id`, independent of soft-delete. Sync-apply permits a
 *  live child under a tombstoned parent (`blocks_parent_not_deleted_check_*`
 *  is skipped for `source IS NULL` writes), so stopping at a tombstone
 *  would leak that live state row into the feed as user activity. The
 *  outer query still filters deleted rows out of the RESULT.
 *
 *  Params: stateRootIdsJson, workspaceId, ...SYSTEM_BLOCK_TYPES, limit —
 *  see `recentUserBlocksParams`. */
export const SELECT_RECENT_USER_BLOCKS_SQL = `
  WITH RECURSIVE user_state(id) AS (
    SELECT value FROM json_each(?)
    UNION
    SELECT b.id FROM blocks b
      JOIN user_state ON b.parent_id = user_state.id
  )
  SELECT ${buildQualifiedBlockColumnsSql('blocks')}
  FROM blocks
  WHERE blocks.workspace_id = ?
    AND blocks.deleted = 0
    AND blocks.content != ''
    AND blocks.id NOT IN (SELECT id FROM user_state)
    AND json_extract(blocks.properties_json, '$."${seedKeyProp.name}"') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM block_types bt
       WHERE bt.block_id = blocks.id
         AND bt.type IN (${SYSTEM_BLOCK_TYPES.map(() => '?').join(', ')})
    )
  ORDER BY coalesce(blocks.user_updated_at, blocks.updated_at) DESC, blocks.id ASC
  LIMIT ?
`

/** Bind list for `SELECT_RECENT_USER_BLOCKS_SQL`. Single-sourced so the
 *  placeholder count in the statement and the parameter order can't
 *  drift as `SYSTEM_BLOCK_TYPES` grows. */
export const recentUserBlocksParams = (
  stateRootIds: readonly string[],
  workspaceId: string,
  limit: number,
): unknown[] =>
  [JSON.stringify(stateRootIds), workspaceId, ...SYSTEM_BLOCK_TYPES, limit]

/** Distinct alias values in a workspace, optionally substring-filtered.
 *  Reads `block_aliases` (the trigger-maintained side index in
 *  clientSchema.ts) instead of scanning `json_each(properties_json,
 *  '$.alias')` per query. The case-insensitive filter rides
 *  `idx_block_aliases_ws_alias_lower`; the case-preserving GROUP BY
 *  collapses duplicate aliases that appear on multiple blocks. The
 *  `MIN(b.created_at)` ordering keeps the historical "oldest-first"
 *  sort even though the index itself doesn't carry timestamps. */
export const SELECT_ALIASES_IN_WORKSPACE_SQL = `
  SELECT ba.alias AS alias
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND b.deleted = 0
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
  GROUP BY ba.alias
  ORDER BY
    MIN(CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END),
    MIN(b.created_at),
    ba.alias
`

/** Single-block lookup by exact alias (used by createOrRestore wrappers
 *  and call-site alias jumps). Returns the oldest match (deterministic
 *  tie-break on workspaces with two blocks accidentally claiming the
 *  same alias). `blocks.id` breaks the remaining tie so "oldest" is a
 *  TOTAL order: two devices creating the same page in the same
 *  millisecond leave `created_at` equal, and without this which row wins
 *  is whatever the scan reaches first — so two clients can disagree
 *  about where `[[Name]]` points. Lookups go through
 *  `idx_block_aliases_ws_alias`; the blocks JOIN reads the row by
 *  primary key. */
export const SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('blocks')}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at, blocks.id
  LIMIT 1
`

/** ALL live claimants of an exact alias in a workspace — no `LIMIT 1`.
 *  The single-row lookups above tie-break on `created_at`, which is a
 *  defense-in-depth convenience for callers that just want "the block
 *  named X". A caller deciding whether an alias is CLAIMED cannot use
 *  them: `block_aliases_workspace_alias_unique` only fires for local
 *  user txs (`tx_context.source IS NOT NULL`), so sync-applied rows can
 *  leave several live claimants, and the oldest is not necessarily the
 *  one that matters. Same index (`idx_block_aliases_ws_alias`). */
export const SELECT_BLOCKS_BY_ALIAS_IN_WORKSPACE_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('blocks')}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at, blocks.id
`

/** Variant of `SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL` that ignores
 *  one specific block. Same plan as above with an extra `blocks.id !=
 *  ?` predicate. Used exclusively by the same-tx collision-detection
 *  path: when a row writes its own alias inside the user's tx, the
 *  trigger-maintained index already contains that row by the time the
 *  processor runs, so a plain "oldest claimant of alias X" would
 *  return the row itself when it happens to be the oldest claimant —
 *  silently missing collisions where the actual conflicting claimant
 *  is younger. Excluding the attempting row fixes that. */
export const SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('blocks')}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.id != ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at, blocks.id
  LIMIT 1
`

/** Fuzzy alias-match pre-filter SQL builder. Token-AND prefix-substring
 *  filter on `alias_lower` — the caller passes one LIKE pattern per
 *  query token (typically the first 3 chars of each token, see
 *  `buildFilterPrefixes` in fuzzyRank.ts). Permissive on purpose: the
 *  final rank/keep decision happens in JS, where we score per-token
 *  word-start / substring / edit-distance-1 plus recency. Returns the
 *  user-facing stamp (`coalesce(user_updated_at, updated_at)`) so the JS
 *  ranker can boost recently-edited rows.
 *
 *  Orders exact whole-query matches first, then prefix matches, before
 *  applying `LIMIT`: the prefix is only 3 chars, so a single trigram can
 *  match far more aliases than the over-fetch budget. Without this an
 *  unordered LIMIT could evict the very alias the user typed verbatim
 *  before the JS ranker (which rewards exact matches) ever sees it. The
 *  full lowered query is bound for the exact/prefix comparisons; pass `''`
 *  for the empty-query "browse all aliases" path (everything ties as a
 *  prefix match and falls through to the deterministic created_at order).
 *
 *  Falls back to a workspace-scoped scan when `tokenCount === 0` (empty
 *  query) so the same query handle can also serve the "browse all
 *  aliases" path. */
export const buildFuzzyAliasMatchesSql = (tokenCount: number): string => {
  const filters = tokenCount > 0
    ? Array(tokenCount).fill(`ba.alias_lower LIKE '%' || ? || '%' ESCAPE '\\'`).join(' AND ')
    : '1=1'
  return `
    SELECT
      ba.alias AS alias,
      b.id AS blockId,
      b.content AS content,
      coalesce(b.user_updated_at, b.updated_at) AS updatedAt
    FROM block_aliases ba
    JOIN blocks b ON b.id = ba.block_id
    WHERE ba.workspace_id = ?
      AND b.deleted = 0
      AND (${filters})
    ORDER BY
      CASE
        WHEN ba.alias_lower = ? THEN 0
        WHEN ba.alias_lower LIKE ? || '%' ESCAPE '\\' THEN 1
        ELSE 2
      END,
      b.created_at,
      ba.alias
    LIMIT ?
  `
}

/** Alias substring match used by alias-search surfaces; one row per
 *  (alias, block) pair. Same index plan as the distinct-aliases query
 *  above: filter on alias_lower, JOIN blocks for content + ordering. */
export const SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL = `
  SELECT
    ba.alias AS alias,
    b.id AS blockId,
    b.content AS content
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND b.deleted = 0
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%' ESCAPE '\\')
  ORDER BY
    CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' ESCAPE '\\' THEN 1
      ELSE 2
    END,
    b.created_at,
    ba.alias
  LIMIT ?
`

/** First child of `parentId` whose content matches exactly. Tree-shape:
 *  joins on `blocks.parent_id`, ordered by `(order_key, id)` so the
 *  "first" tie-breaks deterministically. */
export const SELECT_FIRST_CHILD_BY_CONTENT_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('child')}
  FROM blocks AS child
  WHERE child.parent_id = ?
    AND child.deleted = 0
    AND child.content = ?
  ORDER BY child.order_key, child.id
  LIMIT 1
`

export interface AliasMatch {
  alias: string
  blockId: string
  content: string
}

export interface AliasMatchWithRecency extends AliasMatch {
  updatedAt: number
}

/** One `(block, type)` membership row from the `block_types` index. */
export interface BlockTypeAssignment {
  blockId: string
  type: string
}

/** Live-claimant count for one alias string. */
export interface AliasClaimantCount {
  alias: string
  claimants: number
}

// ════════════════════════════════════════════════════════════════════
// Phase 4 chunk B — kernel queries as `queriesFacet` contributions
// ════════════════════════════════════════════════════════════════════
//
// Each query mirrors the dep declarations from the corresponding
// `repo.X(id)` factory on `Repo` (which Phase 1 / 2 already wrote
// correctly). Once chunk C lands, those factories become thin shims —
// then deleted entirely — and `repo.query.X(...)` is the only surface.
//
/** Local cast: `BlockRow` has typed fields; `QueryCtx.hydrateBlocks`
 *  takes the looser `Record<string, unknown>` shape so the api module
 *  doesn't depend on the row schema. The cast is safe — `hydrateBlocks`
 *  flows directly into `parseBlockRow` which expects `BlockRow`. */
const asBlockRows = (rows: ReadonlyArray<BlockRow>): ReadonlyArray<Record<string, unknown>> =>
  rows as unknown as ReadonlyArray<Record<string, unknown>>

// Result schemas. The dispatcher's resultSchema.parse boundary runs
// on every load, so a strict zod schema would walk every BlockData
// field on every subtree/children/etc. — wasteful when the SQL→
// parseBlockRow boundary already produces fully-typed rows.
//
// Instead, ship typed pass-through schemas that satisfy `Schema<T>`
// (`{parse(input): T}`) without runtime validation. The TypeScript
// surface from QueryRegistry stays precise (reviewer P2: kernel
// queries no longer return Promise<unknown>), while the runtime cost
// is zero. Plugin authors with strict typing needs supply their own
// zod schema and pay the validation cost knowingly.
const blockDataArraySchema: Schema<BlockData[]> = {
  parse: (input) => input as BlockData[],
}
const stringArraySchema: Schema<string[]> = {
  parse: (input) => input as string[],
}
const numberSchema: Schema<number> = {
  parse: (input) => input as number,
}
const blockDataOrNullSchema: Schema<BlockData | null> = {
  parse: (input) => input as BlockData | null,
}
const subtreeRowArraySchema: Schema<SubtreeRow[]> = {
  parse: (input) => input as SubtreeRow[],
}

// ──── Tree queries ────

/** Subtree rooted at `id`, includeRoot=true (spec §11). Returns
 *  {@link SubtreeRow}s — each block plus its `depth` relative to the root —
 *  in pre-order, siblings by `(order_key, id)`. Identity-stable via the
 *  dispatcher's handle-store key. Dep declaration mirrors the legacy
 *  `repo.subtree(id)` factory in `repo.ts`.
 *
 *  Returns the FULL subtree by default (property field/value machinery
 *  included) — the structural view, so a consumer never silently misses
 *  machinery. The display-visible view — excluding recognized machinery
 *  (PR #288 §9 — data-keyed, not flip-gated, since the backfill mints field
 *  rows pre-flip; prunes at every recognized `::` field row, see
 *  {@link VISIBLE_SUBTREE_SQL}) — is opt-in via `hidePropertyChildren:
 *  true`, the same option `core.children` / `tx.childrenOf` take. The
 *  outline hooks pass it; structural consumers (copy, navigation) get
 *  everything. */
export const subtreeQuery = defineQuery<
  {id: string; hidePropertyChildren?: boolean},
  SubtreeRow[]
>({
  name: 'core.subtree',
  argsSchema: z.object({id: z.string(), hidePropertyChildren: z.boolean().optional()}),
  resultSchema: subtreeRowArraySchema,
  resolve: async ({id, hidePropertyChildren = false}, ctx) => {
    // Upfront deps — declared before SQL so the empty-result case (root
    // missing on first load) and any mid-load invalidations have
    // something to match against. Re-declared per-row below; HandleStore
    // tolerates duplicates.
    ctx.depend({kind: 'row', id})
    ctx.depend({kind: 'parent-edge', parentId: id})
    const rows = hidePropertyChildren
      ? await ctx.db.getAll<BlockRow & {depth: number}>(VISIBLE_SUBTREE_SQL, [id, ...registrySeedParams(ctx.repo)])
      : await ctx.db.getAll<BlockRow & {depth: number}>(SUBTREE_SQL, [id])
    const out = ctx.hydrateBlocks(asBlockRows(rows))
    // SUBTREE_SQL already computes depth (0 at the root, +1 per level) and
    // hydrateBlocks preserves row order, so `out[i]` ↔ `rows[i]`. depth is
    // root-relative — a property of position in THIS subtree, not of the
    // block — so it goes onto a fresh result wrapper, never onto the
    // cached BlockData that hydrateBlocks just stored.
    const withDepth = out.map((data, i): SubtreeRow => ({...data, depth: rows[i].depth}))
    for (const data of withDepth) {
      ctx.depend({kind: 'parent-edge', parentId: data.id})
    }
    return withDepth
  },
})

/** Ancestor chain (excludes `id` itself). */
export const ancestorsQuery = defineQuery<{id: string}, BlockData[]>({
  name: 'core.ancestors',
  argsSchema: z.object({id: z.string()}),
  resultSchema: blockDataArraySchema,
  resolve: async ({id}, ctx) => {
    ctx.depend({kind: 'row', id})
    const rows = await ctx.db.getAll<BlockRow>(ANCESTORS_SQL, [id, id])
    return ctx.hydrateBlocks(asBlockRows(rows))
  },
})

interface ManyAncestorsEntry {
  startId: string
  ancestors: BlockData[]
}

const manyAncestorsResultSchema: Schema<ManyAncestorsEntry[]> = {
  parse: (input) => input as ManyAncestorsEntry[],
}

/** Batched ancestor walk. Returns one entry per input id, in input
 *  order, with the leaf-to-root chain (depth-ascending) — same
 *  ordering as the single-id `core.ancestors` query.
 *
 *  Use over N `core.ancestors` calls when a UI needs ancestors for
 *  many ids known up front (e.g. a backlinks panel rendering N
 *  source blocks each with breadcrumbs). One round-trip vs. N gives
 *  a meaningful cold-start win when the SQLite connection is
 *  contended. Empty entries are returned for ids whose row doesn't
 *  exist or is soft-deleted, so consumers can map 1:1 over the input
 *  list without nullable lookups. */
export const manyAncestorsQuery = defineQuery<
  {ids: readonly string[]},
  ManyAncestorsEntry[]
>({
  name: 'core.manyAncestors',
  argsSchema: z.object({ids: z.array(z.string()).readonly()}),
  resultSchema: manyAncestorsResultSchema,
  resolve: async ({ids}, ctx) => {
    if (ids.length === 0) return []
    for (const id of ids) ctx.depend({kind: 'row', id})

    type Row = BlockRow & {chain_start_id: string}
    const rows = await ctx.db.getAll<Row>(manyAncestorsSql(ids.length), [...ids])

    const rowsByStart = new Map<string, BlockRow[]>()
    for (const id of ids) rowsByStart.set(id, [])
    for (const row of rows) {
      const list = rowsByStart.get(row.chain_start_id)
      // The seed ids filter to deleted=0, so chain_start_id always
      // matches one of the input ids — the conditional is just a
      // belt-and-suspenders guard against a future SQL change.
      if (list) list.push(row)
    }

    // Hydrate each chain through the dispatcher's hydrateBlocks so the
    // per-row deps land and the BlockCache picks up the rows. We pass
    // each chain in a single call so the hydrate-order is depth-asc
    // per chain — a flat single-call hydrate would interleave chains.
    return ids.map(startId => ({
      startId,
      ancestors: ctx.hydrateBlocks(asBlockRows(rowsByStart.get(startId) ?? [])),
    }))
  },
})

/** Direct children of `id`, ordered `(order_key, id)`. Returns EVERY child
 *  by default (property field rows included) — the structural view. The
 *  display-visible view — excluding recognized field rows (PR #288 §9;
 *  data-keyed, not flip-gated) — is opt-in via
 *  `hidePropertyChildren: true` (the outline hooks pass it), the same option
 *  `tx.childrenOf` takes. */
/** The registry half of the visible-children predicate (#389 item 7): the
 *  seed-definition ids the REGISTRY knows, which `block_types` may not carry
 *  yet, plus the workspace they belong to.
 *
 *  Pure — seed definition ids are uuidv5 over `workspaceId:seedKey`, so this
 *  is a computation over the loaded declarations with no DB read. It closes
 *  the window where a field row arrives over sync ahead of its definition
 *  block on a warm device, and the SQL view showed a row the tx-layer
 *  recognizer hid.
 *
 *  MEMOIZED on snapshot identity, and not as a micro-optimisation: these SQL
 *  constants back `core.children` / `childIds` / `subtree`, which the outline
 *  resolves once per rendered block, and the set is ~100 SHA-1 hashes plus a
 *  multi-KB JSON string. Recomputing it per resolve cost tens of
 *  milliseconds per page render for a value that only changes when the
 *  registry is REPLACED — which is exactly what a WeakMap key expresses.
 *
 *  Returns `['[]', '']` when no registry is primed, which is precisely the
 *  pre-existing `block_types`-only behaviour. */
const seedParamsBySnapshot = new WeakMap<object, readonly [string, string]>()

export const registrySeedParams = (repo: Repo): readonly [string, string] => {
  const registry = repo.propertyDefinitions
  if (!registry) return ['[]', '']
  const cached = seedParamsBySnapshot.get(registry)
  if (cached) return cached
  const ids: string[] = []
  for (const seedKey of registry.seedsByKey.keys()) {
    ids.push(propertyDefinitionBlockId(registry.workspaceId, seedKey))
  }
  const params = [JSON.stringify(ids), registry.workspaceId] as const
  seedParamsBySnapshot.set(registry, params)
  return params
}

export const childrenQuery = defineQuery<
  {id: string; hidePropertyChildren?: boolean},
  BlockData[]
>({
  name: 'core.children',
  argsSchema: z.object({id: z.string(), hidePropertyChildren: z.boolean().optional()}),
  resultSchema: blockDataArraySchema,
  resolve: async ({id, hidePropertyChildren = false}, ctx) => {
    ctx.depend({kind: 'parent-edge', parentId: id})
    const rows = hidePropertyChildren
      ? await ctx.db.getAll<BlockRow>(VISIBLE_CHILDREN_SQL, [id, ...registrySeedParams(ctx.repo)])
      : await ctx.db.getAll<BlockRow>(CHILDREN_SQL, [id])
    return ctx.hydrateBlocks(asBlockRows(rows))
  },
})

/** Child-id list of `id` (lean shape). With `hydrate: true`, also runs
 *  the full row SELECT and primes the cache — the consumer-facing
 *  variant the React hooks use to avoid N+1 row loads on mount. Same
 *  everything-by-default as `core.children` (the hooks opt into the
 *  visible view via `hidePropertyChildren: true`). */
export const childIdsQuery = defineQuery<
  {id: string; hydrate?: boolean; hidePropertyChildren?: boolean},
  string[]
>({
  name: 'core.childIds',
  argsSchema: z.object({
    id: z.string(),
    hydrate: z.boolean().optional(),
    hidePropertyChildren: z.boolean().optional(),
  }),
  resultSchema: z.array(z.string()),
  resolve: async ({id, hydrate = false, hidePropertyChildren = false}, ctx) => {
    ctx.depend({kind: 'parent-edge', parentId: id})
    if (!hydrate) {
      const rows = hidePropertyChildren
        ? await ctx.db.getAll<{id: string}>(VISIBLE_CHILDREN_IDS_SQL, [id, ...registrySeedParams(ctx.repo)])
        : await ctx.db.getAll<{id: string}>(CHILDREN_IDS_SQL, [id])
      return rows.map(r => r.id)
    }
    const rows = hidePropertyChildren
      ? await ctx.db.getAll<BlockRow>(VISIBLE_CHILDREN_SQL, [id, ...registrySeedParams(ctx.repo)])
      : await ctx.db.getAll<BlockRow>(CHILDREN_SQL, [id])
    // declareRowDeps:false — result is the id list; per-row deps would
    // wake the handle on content/property edits that can't change the
    // id set. Hydration here is pure cache priming for the React hooks
    // that follow up with per-block reads.
    return ctx.hydrateBlocks(asBlockRows(rows), {declareRowDeps: false}).map(d => d.id)
  },
})

// ──── Search queries ────

/** Live blocks in `workspaceId` whose `type` property equals `type`.
 *  Membership reactivity rides the `typedBlocks.type` channel — fired
 *  by the kernel invalidation rule when a block's `block_types` row for
 *  `(workspaceId, type)` is inserted/removed (creation, restore,
 *  type-add/remove, soft-delete). Per-row deps from `hydrateBlocks`
 *  cover edits to currently-matched rows. */
export const byTypeQuery = defineQuery<{workspaceId: string; type: string}, BlockData[]>({
  name: 'core.byType',
  argsSchema: z.object({workspaceId: z.string(), type: z.string()}),
  resultSchema: blockDataArraySchema,
  resolve: async ({workspaceId, type}, ctx) => {
    if (!workspaceId) return []
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_TYPE_CHANNEL,
      key: typedBlocksTypeKey(workspaceId, type),
    })
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_TYPE_SQL, [workspaceId, type],
    )
    return ctx.hydrateBlocks(asBlockRows(rows))
  },
})

const typedBlocksArgsSchema = z.object({
  workspaceId: z.string(),
  types: z.array(z.string()).optional(),
  where: z.record(z.string(), z.unknown()).optional(),
  referencedBy: referenceFilterSchema.optional(),
  match: z.array(blockPredicateSchema).optional(),
  exclude: z.array(blockPredicateSchema).optional(),
  order: z.enum(['created-asc', 'created-desc']).optional(),
})

const ANCESTOR_DEP_KIND = 'a'
const TARGET_DEP_KIND = 't'

/** SQL that materializes every (block_id, anc_id) pair the typed query
 *  considers when an ancestor-scoped predicate is present. Returns the
 *  full set of ancestor ids touched so the resolver can register row
 *  deps on them — content / property / parent_id changes on any
 *  ancestor can flip membership and we need to wake. Mirrors the
 *  ancestor_chain CTE the compiler emits, but materializes only the
 *  candidate seed (no per-predicate filtering) since we want every
 *  potentially-relevant ancestor in the dep set.
 *
 *  Each `targetArms` entry rides the SAME walk to return the target ids those
 *  rows point at, for one named property. One statement rather than two so the
 *  recursive walk — the expensive part — is paid once; the arms are told apart
 *  by `dep_kind`. See `declareAncestorDeps`. */
const ANCESTOR_DEP_NODES_SQL = (candidatesCte: string, targetArms: readonly string[]) => `
  WITH RECURSIVE
    ${candidatesCte},
    walk(anc_id, anc_parent_id, depth, path) AS (
      SELECT seed.id, seed.parent_id, 0, '!' || hex(seed.id) || '/'
      FROM candidates c
      JOIN blocks seed ON seed.id = c.id
      WHERE seed.deleted = 0
      UNION ALL
      SELECT
        parent.id,
        parent.parent_id,
        walk.depth + 1,
        walk.path || '!' || hex(parent.id) || '/'
      FROM walk
      JOIN blocks parent ON parent.id = walk.anc_parent_id
      WHERE parent.deleted = 0
        AND walk.depth < 100
        AND INSTR(walk.path, '!' || hex(parent.id) || '/') = 0
    )
  SELECT DISTINCT '${ANCESTOR_DEP_KIND}' AS dep_kind, anc_id AS dep_id FROM walk${
    targetArms.map(arm => `
  UNION
  ${arm}`).join('')}
`



/** Subscribe to the property channels relevant to a single `where`
 *  map — every direct key, plus the inner keys reached through any
 *  `target` traversal. The inner keys live on other rows (the ref
 *  targets), so changes there have to wake this query just like
 *  changes to the source row's outer property would.
 *
 *  Live-channel rule for `target`: if the inner predicate has no
 *  selective key (empty `target: {}`, `target: { x: null }`,
 *  `target: { x: { exists: false } }`, or any combination of unset-
 *  matching predicates), a fresh target-row insert that matches
 *  won't fire any property channel — the row never set the property
 *  the predicate names. Without subscribing to the live channel in
 *  that case, the subscriber stays stale until an unrelated write
 *  fires invalidations. Mirrors the top-level "live channel only
 *  when no positive axis" gate. */
const collectWhereDeps = (
  where: Readonly<Record<string, unknown>> | undefined,
  workspaceId: string,
  ctx: QueryCtx,
  /** Sink for property names whose non-selective `target:` predicate needs
   *  target-row liveness. Non-null only where the caller can later NAME those
   *  target ids (`declareAncestorDeps`); null means fall back to the
   *  workspace-wide live channel. */
  enumerableTargetProps: Set<string> | null,
): void => {
  if (where === undefined) return
  for (const [name, value] of Object.entries(where)) {
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_PROPERTY_CHANNEL,
      key: typedBlocksPropertyKey(workspaceId, name),
    })
    if (value === null || typeof value !== 'object' || value instanceof Date || Array.isArray(value)) continue
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length !== 1) continue
    const [op, operand] = entries[0]!
    if (op !== 'target') continue
    if (operand === null || typeof operand !== 'object' || Array.isArray(operand)) continue
    const inner = operand as Record<string, unknown>
    const innerHasSelective = Object.values(inner).some(isSelectiveWhereValue)
    if (!innerHasSelective) {
      // An ancestor-scope caller reaches every row this predicate is
      // evaluated against, so it can depend on the handful of target ids
      // those rows point at instead of on every block in the workspace.
      // Self scope cannot: its candidate CTE has already dropped the rows a
      // newly-live target would admit, so the ids are not observable from
      // the result set and the coarse channel stays.
      if (enumerableTargetProps) enumerableTargetProps.add(name)
      else {
        ctx.depend({
          kind: 'plugin',
          channel: TYPED_BLOCKS_LIVE_CHANNEL,
          key: typedBlocksLiveKey(workspaceId),
        })
      }
    }
    // Always recurse for the narrower per-property channels too —
    // updates to an existing target row's properties still wake via
    // those even when the live channel is also subscribed.
    //
    // `null`, not the sink: a nested target hangs off the TARGET row, which
    // the ancestor walk never reaches, so its ids are not enumerable here.
    collectWhereDeps(inner, workspaceId, ctx, null)
  }
}

const collectReferenceFilterDeps = (
  ref: TypedBlockQueryReferenceFilter,
  workspaceId: string,
  ctx: QueryCtx,
  opts: {includeImplicitAncestorStructure?: boolean} = {},
): void => {
  if (ref.sourceField !== undefined) {
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
      key: typedBlocksReferenceFieldKey(workspaceId, ref.id, ref.sourceField),
    })
    return
  }
  ctx.depend({
    kind: 'plugin',
    channel: TYPED_BLOCKS_REFERENCE_CHANNEL,
    key: typedBlocksReferenceKey(workspaceId, ref.id),
  })
  if (opts.includeImplicitAncestorStructure) {
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
      key: typedBlocksStructureKey(workspaceId, ref.id),
    })
  }
}

const collectPredicateDeps = (
  predicates: readonly BlockPredicate[],
  workspaceId: string,
  ctx: QueryCtx,
  ancestorTargetProps: Set<string>,
): void => {
  for (const predicate of predicates) {
    collectWhereDeps(
      predicate.where,
      workspaceId,
      ctx,
      predicate.scope === 'ancestor' ? ancestorTargetProps : null,
    )
    if (predicate.referencedBy !== undefined) {
      collectReferenceFilterDeps(predicate.referencedBy, workspaceId, ctx, {
        includeImplicitAncestorStructure: predicate.scope === 'ancestor',
      })
    }
  }
}

const collectTypedBlockAxisDeps = (
  normalized: ResolvedTypedBlockQuery,
  ctx: QueryCtx,
): {
  workspaceId: string
  types: readonly string[]
  referencedBy: ResolvedTypedBlockQuery['referencedBy']
  matchPredicates: readonly BlockPredicate[]
  excludePredicates: readonly BlockPredicate[]
  /** Properties whose ancestor-scoped `target:` predicate still needs its
   *  target ids named — see `declareAncestorDeps`. */
  ancestorTargetProps: ReadonlySet<string>
} => {
  const workspaceId = normalized.workspaceId
  const types = normalized.types ?? []
  const referencedBy = normalized.referencedBy
  const matchPredicates = normalized.match ?? []
  const excludePredicates = normalized.exclude ?? []

  for (const t of types) {
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_TYPE_CHANNEL,
      key: typedBlocksTypeKey(workspaceId, t),
    })
  }
  const ancestorTargetProps = new Set<string>()
  // Top-level `where` is self scope — not enumerable (see collectWhereDeps).
  collectWhereDeps(normalized.where, workspaceId, ctx, null)
  if (referencedBy !== undefined) {
    collectReferenceFilterDeps(referencedBy, workspaceId, ctx)
  }
  collectPredicateDeps(matchPredicates, workspaceId, ctx, ancestorTargetProps)
  collectPredicateDeps(excludePredicates, workspaceId, ctx, ancestorTargetProps)

  // Live channel — only when there's no positive membership axis to
  // catch "fresh row could enter the result". A type/referencedBy
  // filter or a non-null where predicate already implies the new row
  // had to fire one of those channels to match, so live would be
  // pure fan-out. Required for:
  //   - no filters at all (degenerate "all live blocks" query)
  //   - where with only null predicates (e.g. `{status: null}`) —
  //     a row created without `status` set never fires the property
  //     channel, so live is the only signal that a candidate
  //     appeared. (Mixed cases like `{status: null, foo: 'bar'}`
  //     don't need live: matching rows must set `foo='bar'` to
  //     match, which fires the foo property channel.)
  const hasSelectiveWhere = Object.values(normalized.where ?? {}).some(isSelectiveWhereValue)
  const hasMatchAxis = matchPredicates.some(p =>
    p.referencedBy !== undefined ||
    (p.where !== undefined && Object.values(p.where).some(isSelectiveWhereValue)),
  )
  const hasPositiveAxis =
    types.length > 0 || referencedBy !== undefined || hasSelectiveWhere || hasMatchAxis
  if (!hasPositiveAxis) {
    ctx.depend({
      kind: 'plugin',
      channel: TYPED_BLOCKS_LIVE_CHANNEL,
      key: typedBlocksLiveKey(workspaceId),
    })
  }

  return {workspaceId, types, referencedBy, matchPredicates, excludePredicates, ancestorTargetProps}
}

const typedBlockNeedsAncestorChain = (
  matchPredicates: readonly BlockPredicate[],
  excludePredicates: readonly BlockPredicate[],
): boolean =>
  matchPredicates.some(p => p.scope === 'ancestor') ||
  excludePredicates.some(p => p.scope === 'ancestor')

/** One UNION arm per named property, reading the target ids out of the SAME
 *  `properties_json` expression the predicate itself compiles to
 *  (`compileTargetTraversal`).
 *
 *  NOT `block_references`: that edge index is trigger-maintained from
 *  `references_json`, which the references processor writes POST-COMMIT. A
 *  ref-typed property write therefore lands (and invalidates on the property
 *  channel) before its edge exists, so a resolve in that window would see no
 *  target and register no dep. On the `kind: 'structure'` paths the ancestor
 *  deps do not fire on the later `references_json` edit either, so the miss
 *  would be permanent. Reading the property value cannot skew from the
 *  predicate, because it is the same expression. */
const targetLivenessArms = (
  props: ReadonlySet<string>,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): string[] => {
  const arms: string[] = []
  for (const name of [...props].sort()) {
    const extract = `json_extract(b.properties_json, ${inlineJsonPath(name)})`
    const kind = refCodecKind(propertySchemas.get(name))
    if (kind === 'ref') {
      arms.push(
        `SELECT DISTINCT '${TARGET_DEP_KIND}', ${extract}\n` +
        `  FROM walk JOIN blocks b ON b.id = walk.anc_id\n` +
        `  WHERE ${extract} IS NOT NULL`,
      )
    } else if (kind === 'refList') {
      // Same fan-out the predicate uses; `json_each` over a NULL/absent value
      // yields no rows, which is why it needs no null guard there or here.
      arms.push(
        `SELECT DISTINCT '${TARGET_DEP_KIND}', je.value\n` +
        `  FROM walk JOIN blocks b ON b.id = walk.anc_id, json_each(${extract}) je`,
      )
    }
  }
  return arms
}

const declareAncestorDeps = async (
  normalized: ResolvedTypedBlockQuery,
  ctx: QueryCtx,
  kind: 'row' | 'structure',
  /** Properties whose ancestor-scoped `target: {}` predicate needs its target
   *  rows' liveness. Declared HERE, not at the call sites, so a resolver that
   *  walks ancestors cannot suppress the coarse `typedBlocks.live` channel
   *  (which `collectWhereDeps` already did) without also picking up the
   *  precise ids that replace it — the under-firing direction. */
  targetProps: ReadonlySet<string>,
): Promise<void> => {
  assertAncestorWalkBounded(normalized)
  const candidatesCte = buildCandidatesCte(normalized, ctx.repo.propertySchemas)
  const rows = await ctx.db.getAll<{dep_kind: string; dep_id: string | null}>(
    ANCESTOR_DEP_NODES_SQL(
      candidatesCte.sql,
      targetLivenessArms(targetProps, ctx.repo.propertySchemas),
    ),
    candidatesCte.params,
  )
  for (const row of rows) {
    if (row.dep_id === null) continue
    if (row.dep_kind === TARGET_DEP_KIND) {
      // The predicate compiles to `EXISTS(… AND deleted = 0)`, so this target
      // being created, deleted or restored flips membership, and
      // `typedBlocks.structure` is emitted keyed on the changed block's own
      // id. A target with no row yet still gets a dep — that is the case a
      // later create would otherwise admit unnoticed.
      //
      // The branch only diverges from the fallthrough when `kind === 'row'`:
      // a row dep would also fire on the target's CONTENT edits, which cannot
      // change this predicate. Under `kind === 'structure'` both arms land on
      // the same dep, so deleting this branch fails nothing there — what the
      // tests pin is the SQL arm that produces these rows at all.
      ctx.depend({
        kind: 'plugin',
        channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
        key: typedBlocksStructureKey(normalized.workspaceId, row.dep_id),
      })
      continue
    }
    if (kind === 'row') {
      ctx.depend({kind: 'row', id: row.dep_id})
    } else {
      ctx.depend({
        kind: 'plugin',
        channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
        key: typedBlocksStructureKey(normalized.workspaceId, row.dep_id),
      })
    }
  }
}

/** Resolve a typed block query against the given context. Used both
 *  by `typedBlocksQuery` and by thin wrappers like `backlinksForBlockQuery`
 *  that compose typed-query semantics — sharing this resolver keeps
 *  the dep declarations and SQL in one place. */
export const resolveTypedBlocks = async (
  query: ResolvedTypedBlockQuery,
  ctx: QueryCtx,
): Promise<BlockData[]> => {
  if (!query.workspaceId) return []
  const normalized = normalizeTypedBlockQuery(query)
  const {
    workspaceId,
    types,
    referencedBy,
    matchPredicates,
    excludePredicates,
    ancestorTargetProps,
  } = collectTypedBlockAxisDeps(normalized, ctx)
  const needsAncestorChain = typedBlockNeedsAncestorChain(matchPredicates, excludePredicates)

  // Ancestor-scope predicates inspect rows up the parent chain.
  // Register row deps on every ancestor id touched so a property /
  // content / parent_id change on any ancestor wakes the handle.
  if (needsAncestorChain) {
    await declareAncestorDeps(normalized, ctx, 'row', ancestorTargetProps)
  }

  if (
    types.length === 1 &&
    normalized.where === undefined &&
    referencedBy === undefined &&
    matchPredicates.length === 0 &&
    excludePredicates.length === 0 &&
    normalized.order !== 'created-desc'
  ) {
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_TYPE_SQL, [workspaceId, types[0]],
    )
    return ctx.hydrateBlocks(asBlockRows(rows))
  }
  const compiled = compileTypedBlockQuery(normalized, ctx.repo.propertySchemas)
  const rows = await ctx.db.getAll<BlockRow>(compiled.sql, [...compiled.params])
  return ctx.hydrateBlocks(asBlockRows(rows))
}

/** Id projection for typed queries. Same typed-query semantics and
 *  membership invalidation as `resolveTypedBlocks`, but it intentionally
 *  avoids hydrating result rows, so content-only edits to current
 *  members do not invalidate collection consumers. */
export const resolveTypedBlockIds = async (
  query: ResolvedTypedBlockQuery,
  ctx: QueryCtx,
): Promise<string[]> => {
  if (!query.workspaceId) return []
  const normalized = normalizeTypedBlockQuery(query)
  const {matchPredicates, excludePredicates, ancestorTargetProps} =
    collectTypedBlockAxisDeps(normalized, ctx)
  if (typedBlockNeedsAncestorChain(matchPredicates, excludePredicates)) {
    await declareAncestorDeps(normalized, ctx, 'structure', ancestorTargetProps)
  }
  const compiled = compileTypedBlockQuery(normalized, ctx.repo.propertySchemas, {projection: 'ids'})
  const rows = await ctx.db.getAll<{id: string}>(compiled.sql, [...compiled.params])
  return rows.map(row => row.id)
}

/** SQLite-backed typed block query. Repo.queryBlocks / subscribeBlocks
 *  default workspaceId before dispatching here; direct query callers
 *  should pass workspaceId explicitly.
 *
 *  Reactivity (spec §9.2 + §9.4): each filter dimension contributes its
 *  own narrow dep so the handle re-resolves only when something that
 *  could flip membership actually changes:
 *
 *    - per `type` in `types`     → `typedBlocks.type` channel
 *    - per name in `where`        → `typedBlocks.property` channel
 *    - `referencedBy.id` (no field) → `typedBlocks.reference` channel
 *    - `referencedBy.id + sourceField` → `typedBlocks.referenceField` channel
 *    - per name in any `match`/`exclude` predicate's `where` → `typedBlocks.property`
 *    - per `referencedBy` in any `match`/`exclude` predicate → reference channels
 *    - any ancestor-scope predicate → row deps on every walked ancestor id
 *    - no filter at all           → `typedBlocks.live` channel
 *
 *  Per-row deps from `hydrateBlocks` cover edits to rows already in the
 *  result. The old `{kind:'workspace', workspaceId}` dep was too coarse
 *  — UiState focus writes (and unrelated content edits) re-fired it
 *  needlessly. */
export const typedBlocksQuery = defineQuery<ResolvedTypedBlockQuery, BlockData[]>({
  name: 'core.typedBlocks',
  argsSchema: typedBlocksArgsSchema,
  resultSchema: blockDataArraySchema,
  resolve: (query, ctx) => resolveTypedBlocks(query, ctx),
})

export const typedBlockIdsQuery = defineQuery<ResolvedTypedBlockQuery, string[]>({
  name: 'core.typedBlockIds',
  argsSchema: typedBlocksArgsSchema,
  resultSchema: stringArraySchema,
  resolve: (query, ctx) => resolveTypedBlockIds(query, ctx),
})

/** Count projection for typed queries. Same membership semantics and
 *  invalidation as `resolveTypedBlockIds` — it shares `collectTypedBlockAxisDeps`
 *  and the compiler's candidate set — but aggregates to a single integer in
 *  SQLite instead of marshalling the id list. Used by per-block count badges
 *  (e.g. inline backlink counts) where only the cardinality is needed. */
export const resolveTypedBlockCount = async (
  query: ResolvedTypedBlockQuery,
  ctx: QueryCtx,
): Promise<number> => {
  if (!query.workspaceId) return 0
  const normalized = normalizeTypedBlockQuery(query)
  const {matchPredicates, excludePredicates, ancestorTargetProps} =
    collectTypedBlockAxisDeps(normalized, ctx)
  if (typedBlockNeedsAncestorChain(matchPredicates, excludePredicates)) {
    await declareAncestorDeps(normalized, ctx, 'structure', ancestorTargetProps)
  }
  const compiled = compileTypedBlockQuery(normalized, ctx.repo.propertySchemas, {projection: 'count'})
  const row = await ctx.db.get<{count: number}>(compiled.sql, [...compiled.params])
  return row?.count ?? 0
}

export const typedBlockCountQuery = defineQuery<ResolvedTypedBlockQuery, number>({
  name: 'core.typedBlockCount',
  argsSchema: typedBlocksArgsSchema,
  resultSchema: numberSchema,
  resolve: (query, ctx) => resolveTypedBlockCount(query, ctx),
})

/** Substring-match content search. Empty `query` returns []. */
export const searchByContentQuery = defineQuery<
  {workspaceId: string; query: string; limit?: number},
  BlockData[]
>({
  name: 'core.searchByContent',
  argsSchema: z.object({
    workspaceId: z.string(),
    query: z.string(),
    limit: z.number().optional(),
  }),
  resultSchema: blockDataArraySchema,
  resolve: async ({workspaceId, query, limit = 50}, ctx) => {
    const compiledQuery = compileBlocksContentSearchQuery(query)
    if (compiledQuery === null) return []
    // Narrow `kernel.content` channel — fires only when content
    // actually changes or live-set membership shifts. UiState property
    // writes (focus / selection) don't move either, so navigation
    // doesn't churn this handle. See `kernelInvalidation.ts`.
    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_CONTENT_CHANNEL,
      key: kernelContentKey(workspaceId),
    })
    // The prefix-rank LIKE takes the escaped rankQuery (so `_`/`%` in
    // the query rank as literals); the exact `= LOWER(?)` rank takes the
    // raw rankQuery. The FTS MATCH itself is unaffected — LIKE is only a
    // tiebreaker over the already-matched rows.
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_CONTENT_SQL,
      [
        workspaceId,
        compiledQuery.matchQuery,
        compiledQuery.rankQuery,
        escapeLikePattern(compiledQuery.rankQuery),
        limit,
      ],
    )
    // Skip per-row deps. The kernel.content channel above covers
    // every axis that can flip a content-substring match: content
    // edits and live-set membership shifts. Property edits, parent
    // moves, and reference changes on a currently-matched row don't
    // affect whether the row matches — declaring per-row deps would
    // fan out invalidations for free, and on result sets of 50–100
    // rows it materially inflates handle dep count.
    return ctx.hydrateBlocks(asBlockRows(rows), {declareRowDeps: false})
  },
})

/** The app-state roots of every user in `workspaceId` — the seeds the
 *  Recents filter walks down from. Two steps because the roots' ids are a
 *  uuid-v5 derivation off the user page (`stateChildBlockId`), which SQL
 *  cannot compute: read the user pages, derive in JS. Both halves are
 *  cheap — one indexed `block_types` read, and a couple of hashes per
 *  user. */
const userStateRootIds = async (
  ctx: {db: {getAll: <T>(sql: string, params: unknown[]) => Promise<T[]>}},
  workspaceId: string,
): Promise<string[]> => {
  const pages = await ctx.db.getAll<{id: string}>(
    SELECT_USER_PAGE_IDS_SQL, [workspaceId, USER_TYPE],
  )
  return pages.flatMap(page => userStateRootBlockIds(page.id))
}

/** Recent non-empty block candidates. Empty workspaceId returns []. */
export const recentBlocksQuery = defineQuery<
  {workspaceId: string; limit?: number},
  BlockData[]
>({
  name: 'core.recentBlocks',
  argsSchema: z.object({
    workspaceId: z.string(),
    limit: z.number().optional(),
  }),
  resultSchema: blockDataArraySchema,
  resolve: async ({workspaceId, limit = 50}, ctx) => {
    if (!workspaceId) return []
    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_CONTENT_CHANNEL,
      key: kernelContentKey(workspaceId),
    })
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_RECENT_BLOCKS_SQL, [workspaceId, limit],
    )
    // Skip per-row deps for the same reason as searchByContent:
    // the kernel.content channel covers content edits + live-set
    // membership, and we explicitly tolerate stale recency ordering
    // between content events. Property/parent edits on a returned
    // row don't change membership or content — leaving them out of
    // the dep set keeps the picker from churning on UiState writes.
    return ctx.hydrateBlocks(asBlockRows(rows), {declareRowDeps: false})
  },
})

export interface RecentActivityEntry {
  block: BlockData
  /** Leaf-to-root chain, block itself excluded — the shape
   *  `core.manyAncestors` returns. */
  ancestors: BlockData[]
}

const recentActivityResultSchema: Schema<RecentActivityEntry[]> = {
  parse: (input) => input as RecentActivityEntry[],
}

/** Recently edited USER-AUTHORED blocks, each with its ancestor chain —
 *  what an activity feed needs to fold an edited tree back into one entry
 *  and to name the page an edit happened on.
 *
 *  One query rather than `recentBlocks` + `manyAncestors` because the
 *  chains must correspond to the rows. Two handles resolve independently
 *  and the ancestor handle is re-keyed by the id set, so every change to
 *  the rows re-opens a window where the chains are missing — during which
 *  a consumer either paints every row as rootless (wrong groups, then a
 *  reflow) or blanks the feed. Resolving both here makes that window
 *  structurally impossible, and it costs one round trip less.
 *
 *  What "user-authored" excludes is `SELECT_RECENT_USER_BLOCKS_SQL`'s
 *  business — read that. Empty workspaceId returns []. */
export const recentActivityQuery = defineQuery<
  {workspaceId: string; limit?: number},
  RecentActivityEntry[]
>({
  name: 'core.recentActivity',
  argsSchema: z.object({
    workspaceId: z.string(),
    limit: z.number().optional(),
  }),
  resultSchema: recentActivityResultSchema,
  resolve: async ({workspaceId, limit = 50}, ctx) => {
    if (!workspaceId) return []
    // Same dep policy as `recentBlocks` — `kernel.content` covers content
    // edits and live-set membership, and we accept lightly stale recency
    // ordering between content events rather than waking on every
    // `updated_at` bump (which every UiState write causes).
    //
    // TYPE TAGS are the one filtering axis with no dep, accepted rather
    // than missed: a block acquires a system type at the moment it is
    // minted (a create, which fires this channel), and the one gesture
    // that adds a type to a live block — `#type` — rewrites its content
    // in the same breath. Tagging an already-listed row `panel` out of
    // nowhere is not a flow that exists.
    //
    // Ancestors skip per-row deps: what a reader sees of an ancestor is
    // its CONTENT (the entry's title), and a rename fires this channel.
    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_CONTENT_CHANNEL,
      key: kernelContentKey(workspaceId),
    })
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_RECENT_USER_BLOCKS_SQL,
      recentUserBlocksParams(await userStateRootIds(ctx, workspaceId), workspaceId, limit),
    )
    const blocks = ctx.hydrateBlocks(asBlockRows(rows), {declareRowDeps: false})
    if (blocks.length === 0) return []

    type ChainRow = BlockRow & {chain_start_id: string}
    const chainRows = await ctx.db.getAll<ChainRow>(
      manyAncestorsSql(blocks.length), blocks.map(block => block.id),
    )
    const chainsByStart = new Map<string, BlockRow[]>()
    for (const block of blocks) chainsByStart.set(block.id, [])
    for (const row of chainRows) chainsByStart.get(row.chain_start_id)?.push(row)

    return blocks.map(block => {
      // One call per chain so hydrate order stays depth-ascending within
      // it, as `core.manyAncestors` does.
      const ancestors = ctx.hydrateBlocks(
        asBlockRows(chainsByStart.get(block.id) ?? []), {declareRowDeps: false},
      )
      // A parent change is the one edit that changes what this entry SAYS
      // without touching any content: moved to another page, the entry
      // keeps naming the old one; moved under a state root, it should
      // have left the feed entirely. `kernel.content` doesn't carry it,
      // so declare it per block — on the ancestors too, since a page
      // moved out from under a row re-homes that row's entry without the
      // row itself moving. Narrow on purpose: this channel is keyed per
      // block and fires only on a `parent_id` change, so it costs a wake
      // exactly when the answer changed, unlike a row dep (which every
      // UiState property write would trip).
      for (const shown of [block, ...ancestors]) {
        ctx.depend({
          kind: 'plugin',
          channel: TYPED_BLOCKS_STRUCTURE_CHANNEL,
          key: typedBlocksStructureKey(workspaceId, shown.id),
        })
      }
      return {block, ancestors}
    })
  },
})

/** First child of `parentId` whose content matches exactly. */
export const firstChildByContentQuery = defineQuery<
  {parentId: string; content: string},
  BlockData | null
>({
  name: 'core.firstChildByContent',
  argsSchema: z.object({parentId: z.string(), content: z.string()}),
  resultSchema: blockDataOrNullSchema,
  resolve: async ({parentId, content}, ctx) => {
    ctx.depend({kind: 'parent-edge', parentId})
    const children = await ctx.db.getAll<{id: string}>(CHILDREN_IDS_SQL, [parentId])
    for (const child of children) ctx.depend({kind: 'row', id: child.id})
    const row = await ctx.db.getOptional<BlockRow>(
      SELECT_FIRST_CHILD_BY_CONTENT_SQL, [parentId, content],
    )
    if (row === null) return null
    // declareRowDeps:false — the children loop above already declared a
    // row dep for every candidate (including the matched one), so the
    // default per-row dep here would just duplicate one of them.
    return ctx.hydrateBlocks(asBlockRows([row]), {declareRowDeps: false})[0] ?? null
  },
})

// ──── Alias queries ────

/** Distinct alias values in a workspace, optionally substring-filtered. */
export const aliasesInWorkspaceQuery = defineQuery<
  {workspaceId: string; filter?: string},
  string[]
>({
  name: 'core.aliasesInWorkspace',
  argsSchema: z.object({workspaceId: z.string(), filter: z.string().optional()}),
  resultSchema: z.array(z.string()),
  resolve: async ({workspaceId, filter = ''}, ctx) => {
    if (!workspaceId) return []
    // `kernel.aliases` fires only when the `alias` property changes or
    // an aliased row enters/leaves the live set — narrow enough that
    // UiState writes don't wake autocomplete handles.
    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_ALIASES_CHANNEL,
      key: kernelAliasesKey(workspaceId),
    })
    // Escaped value backs the substring + prefix LIKEs (so `_`/`%` in
    // the filter match literally); raw value backs the `? = ''` guard
    // and the exact `= LOWER(?)` rank comparison.
    const escaped = escapeLikePattern(filter)
    const rows = await ctx.db.getAll<{alias: string}>(
      SELECT_ALIASES_IN_WORKSPACE_SQL, [workspaceId, filter, escaped, filter, escaped],
    )
    return rows.map(r => r.alias)
  },
})

/** Alias autocomplete: one row per `(alias, blockId)` pair. */
export const aliasMatchesQuery = defineQuery<
  {workspaceId: string; filter: string; limit?: number},
  AliasMatch[]
>({
  name: 'core.aliasMatches',
  argsSchema: z.object({
    workspaceId: z.string(),
    filter: z.string(),
    limit: z.number().optional(),
  }),
  resultSchema: z.array(z.object({
    alias: z.string(),
    blockId: z.string(),
    content: z.string(),
  })),
  resolve: async ({workspaceId, filter, limit = 50}, ctx) => {
    if (!workspaceId) return []
    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_ALIASES_CHANNEL,
      key: kernelAliasesKey(workspaceId),
    })
    // See `aliasesInWorkspace`: escaped value for the LIKEs, raw for the
    // `? = ''` guard and the exact `= LOWER(?)` rank comparison.
    const escaped = escapeLikePattern(filter)
    const rows = await ctx.db.getAll<AliasMatch>(
      SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL, [workspaceId, filter, escaped, filter, escaped, limit],
    )
    // Per-row deps so content edits on a currently-returned alias block
    // refresh the autocomplete preview. Sister kernel queries that
    // return BlockData get this for free via `hydrateBlocks` (which
    // calls `ctx.depend({kind:'row', id})` per hydrated row); this
    // query returns a custom `{alias, blockId, content}` shape and
    // bypasses hydration, so the deps have to be declared explicitly.
    // Without them the kernel.aliases channel only catches alias-list
    // changes — content edits to a returned row would slip past.
    for (const row of rows) ctx.depend({kind: 'row', id: row.blockId})
    return rows
  },
})

/** Fuzzy alias autocomplete pre-filter — token-AND prefix-substring
 *  match. Returns a wider candidate set (caller chooses `limit`); the
 *  fuzzy ranker in `fuzzyRank.ts` does the final scoring + ordering.
 *  Empty `prefixes` returns every (alias, block) pair in the workspace
 *  up to `limit`, suitable for the "browse all" path. */
export const aliasMatchesFuzzyQuery = defineQuery<
  {workspaceId: string; prefixes: string[]; query?: string; limit?: number},
  AliasMatchWithRecency[]
>({
  name: 'core.aliasMatchesFuzzy',
  argsSchema: z.object({
    workspaceId: z.string(),
    prefixes: z.array(z.string()),
    query: z.string().optional(),
    limit: z.number().optional(),
  }),
  resultSchema: z.array(z.object({
    alias: z.string(),
    blockId: z.string(),
    content: z.string(),
    updatedAt: z.number(),
  })),
  resolve: async ({workspaceId, prefixes, query = '', limit = 100}, ctx) => {
    if (!workspaceId) return []
    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_ALIASES_CHANNEL,
      key: kernelAliasesKey(workspaceId),
    })
    const sql = buildFuzzyAliasMatchesSql(prefixes.length)
    // The two extra params back the exact/prefix ORDER BY so the LIMIT
    // retains the verbatim match; `alias_lower` is already lowercased.
    // Prefixes are literal token substrings (first-3 of each query token,
    // see `buildFilterPrefixes`), not wildcard patterns, so their LIKE
    // metacharacters are escaped — as is the prefix-rank query — so a
    // typed `_`/`%` matches literally. The exact `= ?` rank takes the
    // raw query.
    const queryLower = query.toLowerCase()
    const escapedPrefixes = prefixes.map(escapeLikePattern)
    const params: (string | number)[] = [
      workspaceId, ...escapedPrefixes, queryLower, escapeLikePattern(queryLower), limit,
    ]
    const rows = await ctx.db.getAll<AliasMatchWithRecency>(sql, params)
    // Same reasoning as `aliasMatches`: this query returns a custom row
    // shape (no BlockData hydration), so per-row deps have to be
    // declared explicitly to catch content edits on a currently-shown
    // alias block.
    for (const row of rows) ctx.depend({kind: 'row', id: row.blockId})
    return rows
  },
})

/** Types of a bounded, already-chosen set of blocks — one row per
 *  `(blockId, type)` pair, in the order the block declares them.
 *
 *  Exists for display hints on rows some other query already picked —
 *  the type shown beside each wikilink completion candidate. It is
 *  deliberately NOT a search predicate: callers pass the ids they are
 *  about to render, so the cost is O(ids) and independent of workspace
 *  size. Filtering blocks BY type is `byType` / `typedBlocks`, which go
 *  through the `block_types` index instead.
 *
 *  Reads `properties_json.$.types` directly rather than that index,
 *  because the index cannot answer this question faithfully: its
 *  PRIMARY KEY is `(block_id, type)`, so it hands rows back
 *  type-ascending and the block's own ordering is gone. Consumers show
 *  the FIRST type, and `searchAliasLabels`' other path reads the
 *  property array — so an index read made the hint change (`Author` →
 *  `Person`) as soon as the user typed a character. Both are an
 *  `id IN (...)` seek; this one just keeps `je.key` (the array index)
 *  to sort by, and applies the same `typeof(je.value) = 'text'`
 *  tolerance the `block_types` trigger does, so the two paths agree on
 *  malformed values too. Measured at 20k pages / 50 ids it costs what
 *  the index read did — 0.277ms vs 0.284ms, best-of-60 — so the
 *  correctness is free. Folding it into one row per block with
 *  `json_extract(...,'$.types')` is NOT free (4.3ms, ~15x worse);
 *  don't "optimize" it into that shape.
 *
 *  Per-id row deps (not just per returned row): a block that has no
 *  types yet returns nothing, and tagging it later has to invalidate
 *  this handle too. */
export const blockTypesByIdsQuery = defineQuery<
  {workspaceId: string; blockIds: string[]},
  BlockTypeAssignment[]
>({
  name: 'core.blockTypesByIds',
  argsSchema: z.object({
    workspaceId: z.string(),
    // Capped so "bounded, already-chosen set" is enforced rather than
    // merely documented: this is registered as `core.blockTypesByIds`,
    // so any plugin can call it, and one `?` placeholder per id would
    // otherwise let a caller blow SQLITE_MAX_VARIABLE_NUMBER and
    // declare that many row deps to walk on every later invalidation.
    // The completion path asks for at most its display limit (50).
    blockIds: z.array(z.string()).max(200),
  }),
  resultSchema: z.array(z.object({
    blockId: z.string(),
    type: z.string(),
  })),
  resolve: async ({workspaceId, blockIds}, ctx) => {
    if (!workspaceId || blockIds.length === 0) return []
    for (const blockId of blockIds) ctx.depend({kind: 'row', id: blockId})
    const placeholders = blockIds.map(() => '?').join(', ')
    return ctx.db.getAll<BlockTypeAssignment>(
      `SELECT b.id AS blockId, je.value AS type
       FROM blocks b, json_each(b.properties_json, '$.types') je
       WHERE b.workspace_id = ?
         AND b.deleted = 0
         AND b.id IN (${placeholders})
         AND json_type(b.properties_json, '$.types') = 'array'
         AND typeof(je.value) = 'text'
       ORDER BY b.id, je.key`,
      [workspaceId, ...blockIds],
    )
  },
})

/** How many LIVE blocks claim each of the given aliases.
 *
 *  Duplicate claimants are a documented latent state: the
 *  `block_aliases_workspace_alias_unique` trigger only fires for local
 *  user txs, so sync-applied rows can leave several. Consumers that
 *  show something about "the block behind this alias" need to know,
 *  because `aliasLookup` resolves the alias to the OLDEST claimant
 *  regardless of how anything else ranked them.
 *
 *  Keyed by alias rather than block id on purpose: the caller has
 *  already truncated its ranked rows to a display limit, so counting
 *  claimants among THOSE would miss a claimant that ranked below the
 *  cutoff and report a contested alias as uncontested. Index-backed by
 *  `idx_block_aliases_ws_alias`. */
export const aliasClaimantCountsQuery = defineQuery<
  {workspaceId: string; aliases: string[]},
  AliasClaimantCount[]
>({
  name: 'core.aliasClaimantCounts',
  argsSchema: z.object({
    workspaceId: z.string(),
    // Same bound + reasoning as `blockTypesByIds`.
    aliases: z.array(z.string()).max(200),
  }),
  resultSchema: z.array(z.object({
    alias: z.string(),
    claimants: z.number(),
  })),
  resolve: async ({workspaceId, aliases}, ctx) => {
    if (!workspaceId || aliases.length === 0) return []
    // The alias channel, not per-row deps: what matters here is a
    // claimant entering or leaving the set for these aliases, which is
    // exactly what this channel reports (and the rows that could do it
    // are not knowable up front).
    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_ALIASES_CHANNEL,
      key: kernelAliasesKey(workspaceId),
    })
    const placeholders = aliases.map(() => '?').join(', ')
    return ctx.db.getAll<AliasClaimantCount>(
      `SELECT ba.alias AS alias, count(*) AS claimants
       FROM block_aliases ba
       JOIN blocks b ON b.id = ba.block_id
       WHERE ba.workspace_id = ?
         AND ba.alias IN (${placeholders})
         AND b.deleted = 0
       GROUP BY ba.alias`,
      [workspaceId, ...aliases],
    )
  },
})

/** Every LIVE claimant of an exact alias in a workspace, oldest first.
 *
 *  `aliasLookup` answers "the block named X" and settles ties on
 *  `created_at`. That is the wrong question for a caller deciding whether a
 *  name is CONTESTED: the uniqueness trigger skips sync-apply, so two devices
 *  that create the same page offline both keep their claim, and a page can
 *  hold its own name and share it at the same time — which a single-row
 *  lookup reports as "fine, that's you".
 *
 *  Rows rather than the `aliasClaimantCounts` tally because the caller has to
 *  ACT on the others: name them, open them, fold them in. Counts answer "is
 *  this alias contested" for a list already truncated to a display limit;
 *  this answers "who, exactly". */
export const aliasClaimantsQuery = defineQuery<
  {workspaceId: string; alias: string},
  BlockData[]
>({
  name: 'core.aliasClaimants',
  argsSchema: z.object({workspaceId: z.string(), alias: z.string()}),
  resultSchema: blockDataArraySchema,
  resolve: async ({workspaceId, alias}, ctx) => {
    if (!workspaceId || !alias) return []
    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_ALIASES_CHANNEL,
      key: kernelAliasesKey(workspaceId),
    })
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_ALIAS_IN_WORKSPACE_SQL, [workspaceId, alias],
    )
    return ctx.hydrateBlocks(asBlockRows(rows))
  },
})

/** Single-block lookup by exact alias in a workspace. */
export const aliasLookupQuery = defineQuery<
  {workspaceId: string; alias: string},
  BlockData | null
>({
  name: 'core.aliasLookup',
  argsSchema: z.object({workspaceId: z.string(), alias: z.string()}),
  resultSchema: blockDataOrNullSchema,
  resolve: async ({workspaceId, alias}, ctx) => {
    if (!workspaceId || !alias) return null
    ctx.depend({
      kind: 'plugin',
      channel: KERNEL_ALIASES_CHANNEL,
      key: kernelAliasesKey(workspaceId),
    })
    const row = await ctx.db.getOptional<BlockRow>(
      SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL, [workspaceId, alias],
    )
    if (row === null) return null
    return ctx.hydrateBlocks(asBlockRows([row]))[0] ?? null
  },
})

// ──── Dynamic-plugin discovery ────

/** Workspace's `type: 'extension'` blocks (spec §8 Stage 2 — Phase 4
 *  switches `dynamicExtensionsExtension` from the legacy `byType` call
 *  to this dedicated query). Mechanically `byType('extension')`; lives
 *  as its own kernel query so callers can register against a stable
 *  name without depending on the convention.
 *
 *  No reactive dep: the only consumer (AppRuntimeProvider) calls
 *  `.load()` once at FacetRuntime build time and feeds the result into
 *  `resolveFacetRuntime`. Nothing observes the handle after that, so a
 *  `workspace` dep would just churn the loader on every workspace write
 *  without changing any observable behavior — installing or removing
 *  an extension is picked up via the `refresh_extensions` command
 *  (`Reload extensions` in the palette / `defaultShortcuts.ts`), which
 *  re-runs `dynamicExtensionsExtension` and re-calls
 *  `repo.setFacetRuntime`. */
export const findExtensionBlocksQuery = defineQuery<{workspaceId: string}, BlockData[]>({
  name: 'core.findExtensionBlocks',
  argsSchema: z.object({workspaceId: z.string()}),
  resultSchema: blockDataArraySchema,
  resolve: async ({workspaceId}, ctx) => {
    if (!workspaceId) return []
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_TYPE_SQL, [workspaceId, 'extension'],
    )
    return ctx.hydrateBlocks(asBlockRows(rows))
  },
})

// ──── Bundle ────

/** All kernel queries — contributed to the FacetRuntime via
 *  `kernelDataExtension`, which the Repo installs at construction
 *  (`installKernelRuntime`, default true) and every `setFacetRuntime`
 *  swap re-merges. */
export const KERNEL_QUERIES: ReadonlyArray<AnyQuery> = [
  subtreeQuery,
  ancestorsQuery,
  manyAncestorsQuery,
  childrenQuery,
  childIdsQuery,
  byTypeQuery,
  typedBlocksQuery,
  typedBlockIdsQuery,
  typedBlockCountQuery,
  searchByContentQuery,
  recentBlocksQuery,
  recentActivityQuery,
  firstChildByContentQuery,
  aliasesInWorkspaceQuery,
  aliasMatchesQuery,
  aliasMatchesFuzzyQuery,
  blockTypesByIdsQuery,
  aliasClaimantCountsQuery,
  aliasClaimantsQuery,
  aliasLookupQuery,
  findExtensionBlocksQuery,
]

// ──── Type registry augmentation ────

/** Register every kernel query with `QueryRegistry` so call sites
 *  using `repo.query.<name>(args)` and `repo.query['core.<name>'](args)`
 *  get precise arg + result types without `as` casts. Plugins extend the
 *  same interface from their own module per §12.1. */
declare module '@/data/api' {
  interface QueryRegistry {
    'core.subtree': typeof subtreeQuery
    'core.ancestors': typeof ancestorsQuery
    'core.manyAncestors': typeof manyAncestorsQuery
    'core.children': typeof childrenQuery
    'core.childIds': typeof childIdsQuery
    'core.byType': typeof byTypeQuery
    'core.typedBlocks': typeof typedBlocksQuery
    'core.typedBlockIds': typeof typedBlockIdsQuery
    'core.typedBlockCount': typeof typedBlockCountQuery
    'core.searchByContent': typeof searchByContentQuery
    'core.recentBlocks': typeof recentBlocksQuery
    'core.recentActivity': typeof recentActivityQuery
    'core.firstChildByContent': typeof firstChildByContentQuery
    'core.aliasesInWorkspace': typeof aliasesInWorkspaceQuery
    'core.aliasMatches': typeof aliasMatchesQuery
    'core.aliasMatchesFuzzy': typeof aliasMatchesFuzzyQuery
    'core.blockTypesByIds': typeof blockTypesByIdsQuery
    'core.aliasClaimantCounts': typeof aliasClaimantCountsQuery
    'core.aliasClaimants': typeof aliasClaimantsQuery
    'core.aliasLookup': typeof aliasLookupQuery
    'core.findExtensionBlocks': typeof findExtensionBlocksQuery
  }
}
