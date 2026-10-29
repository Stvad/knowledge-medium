/**
 * Which `block_references` edges count as backlinks.
 *
 * Some edges have a surface of their own: a comment thread's anchor ref is a
 * reference to its target, but the target shows it as a thread, not a mention.
 * The plugin that owns such a surface declares the edge here, and every
 * backlinks route reads it through `edgePredicate`: the batched badge count and
 * list (`sourceBatch.ts`), the filtered and grouped routes (`sources.ts`), and
 * so the bridge and MCP backlinks commands that run them.
 *
 * Read from the facet runtime at resolve time, with no dependency on it: a
 * plugin toggled on or off leaves a mounted backlinks view on its previous
 * answer until that view's next invalidation.
 */

import type { Repo } from '@/data/repo'
import { defineFacet } from '@/facets/facet.js'

export type BacklinkEdgeExclusion =
  /** Every edge this property projects (`source_field = field`). */
  | { kind: 'field'; field: string }
  /** Content edges (`source_field = ''`) from sources of this type, whose
   *  content is a copy of other text rather than their own words. */
  | { kind: 'content-from-type'; type: string }

const isBacklinkEdgeExclusion = (value: unknown): value is BacklinkEdgeExclusion => {
  if (typeof value !== 'object' || value === null) return false
  const exclusion = value as Partial<{kind: unknown; field: unknown; type: unknown}>
  return (exclusion.kind === 'field' && typeof exclusion.field === 'string') ||
    (exclusion.kind === 'content-from-type' && typeof exclusion.type === 'string')
}

export const backlinkEdgeExclusionsFacet = defineFacet<BacklinkEdgeExclusion, readonly BacklinkEdgeExclusion[]>({
  id: 'backlinks.edge-exclusions',
  validate: isBacklinkEdgeExclusion,
})

/** The edges a route reads. `'mentions'` is every edge but the excluded ones.
 *  `{field}` is only the edges one property projects, which is how a plugin
 *  counts its own surface through the same batch. */
export type BacklinkEdges = 'mentions' | { field: string }

export interface EdgePredicate {
  /** A predicate over `br`, a `block_references` row. */
  sql: string
  params: readonly string[]
  /** True when the predicate admits every edge, so a caller can skip it. */
  admitsAll: boolean
}

const placeholders = (count: number): string => Array.from({length: count}, () => '?').join(', ')

export const edgePredicate = (repo: Repo, edges: BacklinkEdges): EdgePredicate => {
  if (edges !== 'mentions') return {sql: 'br.source_field = ?', params: [edges.field], admitsAll: false}
  const exclusions = repo.facetRuntime?.read(backlinkEdgeExclusionsFacet) ?? []
  const fields = [...new Set(exclusions.flatMap(e => e.kind === 'field' ? [e.field] : []))].sort()
  const types = [...new Set(exclusions.flatMap(e => e.kind === 'content-from-type' ? [e.type] : []))].sort()
  const clauses: {sql: string; params: readonly string[]}[] = []
  if (fields.length > 0) clauses.push({sql: `br.source_field NOT IN (${placeholders(fields.length)})`, params: fields})
  if (types.length > 0) {
    clauses.push({sql: `NOT (br.source_field = '' AND EXISTS (
      SELECT 1 FROM block_types bt WHERE bt.block_id = br.source_id AND bt.type IN (${placeholders(types.length)})))`, params: types})
  }
  return clauses.length === 0
    ? {sql: '1', params: [], admitsAll: true}
    : {sql: clauses.map(c => c.sql).join(' AND '), params: clauses.flatMap(c => c.params), admitsAll: false}
}
