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
import { defineQuery, type AnyQuery, type BlockData, type Schema } from '@/data/api'
import { SELECT_BLOCK_COLUMNS_SQL, buildQualifiedBlockColumnsSql, type BlockRow } from '@/data/blockSchema'
import { ANCESTORS_SQL, CHILDREN_IDS_SQL, CHILDREN_SQL, SUBTREE_SQL } from './treeQueries'

export const SELECT_BLOCK_BY_ID_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE id = ?
    AND deleted = 0
`

/** Type filter — flat-property shape (`$.type`, not `$.type.value`). */
export const SELECT_BLOCKS_BY_TYPE_SQL = `
  SELECT ${SELECT_BLOCK_COLUMNS_SQL}
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 0
    AND json_extract(properties_json, '$.type') = ?
  ORDER BY created_at ASC, id ASC
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
    return ctx.hydrateBlocks(asBlockRows(rows)).map(d => d.id)
  },
})

// ──── Search queries ────

/** Live blocks in `workspaceId` whose `type` property equals `type`. */
export const byTypeQuery = defineQuery<{workspaceId: string; type: string}, BlockData[]>({
  name: 'core.byType',
  argsSchema: z.object({workspaceId: z.string(), type: z.string()}),
  resultSchema: blockDataArraySchema,
  resolve: async ({workspaceId, type}, ctx) => {
    if (!workspaceId) return []
    ctx.depend({kind: 'workspace', workspaceId})
    const rows = await ctx.db.getAll<BlockRow>(
      SELECT_BLOCKS_BY_TYPE_SQL, [workspaceId, type],
    )
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
  childrenQuery,
  childIdsQuery,
  byTypeQuery,
  searchByContentQuery,
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
    'core.children': typeof childrenQuery
    'core.childIds': typeof childIdsQuery
    'core.byType': typeof byTypeQuery
    'core.searchByContent': typeof searchByContentQuery
    'core.firstChildByContent': typeof firstChildByContentQuery
    'core.aliasesInWorkspace': typeof aliasesInWorkspaceQuery
    'core.aliasMatches': typeof aliasMatchesQuery
    'core.aliasLookup': typeof aliasLookupQuery
    'core.findExtensionBlocks': typeof findExtensionBlocksQuery
  }
}
