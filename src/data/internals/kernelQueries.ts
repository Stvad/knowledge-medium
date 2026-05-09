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
  type AnyQuery,
  type BlockData,
  type ResolvedTypedBlockQuery,
  type Schema,
} from '@/data/api'
import { SELECT_BLOCK_COLUMNS_SQL, buildQualifiedBlockColumnsSql, type BlockRow } from '@/data/blockSchema'
import { ANCESTORS_SQL, CHILDREN_IDS_SQL, CHILDREN_SQL, manyAncestorsSql, SUBTREE_SQL } from './treeQueries'
import {
  compileTypedBlockQuery,
  normalizeTypedBlockQuery,
} from './typedBlockQuery'
import {
  TYPED_BLOCKS_LIVE_CHANNEL,
  TYPED_BLOCKS_PROPERTY_CHANNEL,
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
  TYPED_BLOCKS_TYPE_CHANNEL,
  typedBlocksLiveKey,
  typedBlocksPropertyKey,
  typedBlocksReferenceFieldKey,
  typedBlocksReferenceKey,
  typedBlocksTypeKey,
} from './typedBlocksInvalidation'

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

/** Content search — case-insensitive substring match. */
export const SELECT_BLOCKS_BY_CONTENT_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
    AND LOWER(content) LIKE '%' || LOWER(?) || '%'
  ORDER BY
    CASE
      WHEN LOWER(content) = LOWER(?) THEN 0
      WHEN LOWER(content) LIKE LOWER(?) || '%' THEN 1
      ELSE 2
    END,
    updated_at DESC
  LIMIT ?
`

/** Recent non-empty blocks in a workspace, used by empty-query pickers. */
export const SELECT_RECENT_BLOCKS_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND content != ''
  ORDER BY updated_at DESC, id ASC
  LIMIT ?
`

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
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%')
  GROUP BY ba.alias
  ORDER BY
    MIN(CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' THEN 1
      ELSE 2
    END),
    MIN(b.created_at),
    ba.alias
`

/** Single-block lookup by exact alias (used by createOrRestore wrappers
 *  and call-site alias jumps). Returns the oldest match (deterministic
 *  tie-break on workspaces with two blocks accidentally claiming the
 *  same alias). Lookups go through `idx_block_aliases_ws_alias`; the
 *  blocks JOIN reads the row by primary key. */
export const SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL = `
  SELECT ${buildQualifiedBlockColumnsSql('blocks')}
  FROM block_aliases ba
  JOIN blocks ON blocks.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND blocks.deleted = 0
  ORDER BY blocks.created_at
  LIMIT 1
`

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
    AND (? = '' OR ba.alias_lower LIKE '%' || LOWER(?) || '%')
  ORDER BY
    CASE
      WHEN ba.alias_lower = LOWER(?) THEN 0
      WHEN ba.alias_lower LIKE LOWER(?) || '%' THEN 1
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
const blockDataOrNullSchema: Schema<BlockData | null> = {
  parse: (input) => input as BlockData | null,
}

// ──── Tree queries ────

/** Subtree rooted at `id`, includeRoot=true (spec §11). Identity-stable
 *  via the dispatcher's handle-store key. Dep declaration mirrors the
 *  legacy `repo.subtree(id)` factory in `repo.ts`. */
export const subtreeQuery = defineQuery<{id: string}, BlockData[]>({
  name: 'core.subtree',
  argsSchema: z.object({id: z.string()}),
  resultSchema: blockDataArraySchema,
  resolve: async ({id}, ctx) => {
    // Upfront deps — declared before SQL so the empty-result case (root
    // missing on first load) and any mid-load invalidations have
    // something to match against. Re-declared per-row below; HandleStore
    // tolerates duplicates.
    ctx.depend({kind: 'row', id})
    ctx.depend({kind: 'parent-edge', parentId: id})
    const rows = await ctx.db.getAll<BlockRow & {depth: number}>(SUBTREE_SQL, [id])
    const out = ctx.hydrateBlocks(asBlockRows(rows))
    for (const data of out) {
      ctx.depend({kind: 'parent-edge', parentId: data.id})
    }
    return out
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

/** Direct children of `id`, ordered `(order_key, id)`. */
export const childrenQuery = defineQuery<{id: string}, BlockData[]>({
  name: 'core.children',
  argsSchema: z.object({id: z.string()}),
  resultSchema: blockDataArraySchema,
  resolve: async ({id}, ctx) => {
    ctx.depend({kind: 'parent-edge', parentId: id})
    const rows = await ctx.db.getAll<BlockRow>(CHILDREN_SQL, [id])
    return ctx.hydrateBlocks(asBlockRows(rows))
  },
})

/** Child-id list of `id` (lean shape). With `hydrate: true`, also runs
 *  the full row SELECT and primes the cache — the consumer-facing
 *  variant the React hooks use to avoid N+1 row loads on mount. */
export const childIdsQuery = defineQuery<{id: string; hydrate?: boolean}, string[]>({
  name: 'core.childIds',
  argsSchema: z.object({id: z.string(), hydrate: z.boolean().optional()}),
  resultSchema: z.array(z.string()),
  resolve: async ({id, hydrate = false}, ctx) => {
    ctx.depend({kind: 'parent-edge', parentId: id})
    if (!hydrate) {
      const rows = await ctx.db.getAll<{id: string}>(CHILDREN_IDS_SQL, [id])
      return rows.map(r => r.id)
    }
    const rows = await ctx.db.getAll<BlockRow>(CHILDREN_SQL, [id])
    return ctx.primeBlocks(asBlockRows(rows)).map(d => d.id)
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
  referencedBy: z.object({
    id: z.string(),
    sourceField: z.string().optional(),
  }).optional(),
})

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
  resolve: async (query, ctx) => {
    if (!query.workspaceId) return []
    const normalized = normalizeTypedBlockQuery(query)
    const workspaceId = normalized.workspaceId
    const types = normalized.types ?? []
    const whereNames = Object.keys(normalized.where ?? {})
    const referencedBy = normalized.referencedBy

    for (const t of types) {
      ctx.depend({
        kind: 'plugin',
        channel: TYPED_BLOCKS_TYPE_CHANNEL,
        key: typedBlocksTypeKey(workspaceId, t),
      })
    }
    for (const name of whereNames) {
      ctx.depend({
        kind: 'plugin',
        channel: TYPED_BLOCKS_PROPERTY_CHANNEL,
        key: typedBlocksPropertyKey(workspaceId, name),
      })
    }
    if (referencedBy !== undefined) {
      if (referencedBy.sourceField !== undefined) {
        ctx.depend({
          kind: 'plugin',
          channel: TYPED_BLOCKS_REFERENCE_FIELD_CHANNEL,
          key: typedBlocksReferenceFieldKey(workspaceId, referencedBy.id, referencedBy.sourceField),
        })
      } else {
        ctx.depend({
          kind: 'plugin',
          channel: TYPED_BLOCKS_REFERENCE_CHANNEL,
          key: typedBlocksReferenceKey(workspaceId, referencedBy.id),
        })
      }
    }

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
    const hasNonNullWhere = whereNames.some(
      name => (normalized.where as Record<string, unknown>)[name] !== null,
    )
    const hasPositiveAxis =
      types.length > 0 || referencedBy !== undefined || hasNonNullWhere
    if (!hasPositiveAxis) {
      ctx.depend({
        kind: 'plugin',
        channel: TYPED_BLOCKS_LIVE_CHANNEL,
        key: typedBlocksLiveKey(workspaceId),
      })
    }

    if (
      types.length === 1 &&
      normalized.where === undefined &&
      referencedBy === undefined
    ) {
      const rows = await ctx.db.getAll<BlockRow>(
        SELECT_BLOCKS_BY_TYPE_SQL, [workspaceId, types[0]],
      )
      return ctx.hydrateBlocks(asBlockRows(rows))
    }
    const compiled = compileTypedBlockQuery(normalized, ctx.repo.propertySchemas)
    const rows = await ctx.db.getAll<BlockRow>(compiled.sql, [...compiled.params])
    return ctx.hydrateBlocks(asBlockRows(rows))
  },
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
    if (!query) return []
    ctx.depend({kind: 'workspace', workspaceId})
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_CONTENT_SQL, [workspaceId, query, query, query, limit],
    )
    return ctx.hydrateBlocks(asBlockRows(rows))
  },
})

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
    ctx.depend({kind: 'workspace', workspaceId})
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_RECENT_BLOCKS_SQL, [workspaceId, limit],
    )
    return ctx.hydrateBlocks(asBlockRows(rows))
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
    const row = await ctx.db.getOptional<BlockRow>(
      SELECT_FIRST_CHILD_BY_CONTENT_SQL, [parentId, content],
    )
    if (row === null) return null
    return ctx.hydrateBlocks(asBlockRows([row]))[0] ?? null
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
    ctx.depend({kind: 'workspace', workspaceId})
    const rows = await ctx.db.getAll<{alias: string}>(
      SELECT_ALIASES_IN_WORKSPACE_SQL, [workspaceId, filter, filter, filter, filter],
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
    ctx.depend({kind: 'workspace', workspaceId})
    return ctx.db.getAll<AliasMatch>(
      SELECT_ALIAS_MATCHES_IN_WORKSPACE_SQL, [workspaceId, filter, filter, filter, filter, limit],
    )
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
    ctx.depend({kind: 'workspace', workspaceId})
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

/** All kernel queries — registered at construction time when
 *  `RepoOptions.registerKernelQueries` is true (default), and
 *  contributed to the FacetRuntime via `kernelDataExtension`. */
export const KERNEL_QUERIES: ReadonlyArray<AnyQuery> = [
  subtreeQuery,
  ancestorsQuery,
  manyAncestorsQuery,
  childrenQuery,
  childIdsQuery,
  byTypeQuery,
  typedBlocksQuery,
  searchByContentQuery,
  recentBlocksQuery,
  firstChildByContentQuery,
  aliasesInWorkspaceQuery,
  aliasMatchesQuery,
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
    'core.searchByContent': typeof searchByContentQuery
    'core.recentBlocks': typeof recentBlocksQuery
    'core.firstChildByContent': typeof firstChildByContentQuery
    'core.aliasesInWorkspace': typeof aliasesInWorkspaceQuery
    'core.aliasMatches': typeof aliasMatchesQuery
    'core.aliasLookup': typeof aliasLookupQuery
    'core.findExtensionBlocks': typeof findExtensionBlocksQuery
  }
}
