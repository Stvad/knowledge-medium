/**
 * Which `block_references` edges count as backlinks.
 *
 * Some edges have a surface of their own: a comment thread's anchor ref is a
 * reference to its target, but the target shows it as a thread, not a mention.
 * The plugin that owns such a surface declares the edge here, and the batch
 * (`sourceBatch.ts`) applies it; every other backlinks route narrows the batch's
 * answer, so the badge, the lists, grouped backlinks and the bridge and MCP
 * backlinks commands all agree.
 *
 * Read from the facet runtime at resolve time, with no dependency on it: a
 * plugin toggled on or off leaves a mounted backlinks view on its previous
 * answer until that view's next invalidation. So does a source gaining or
 * losing a `content-from-type` type with no reference change, which only a
 * hand edit of a thread root's hidden type does; depending on that type's
 * channel instead would re-resolve every mounted backlinks view on every
 * comment created or deleted.
 */

import { buildInClause } from '@/data/internals/sqlBinds'
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
}

const exclusionsOf = (repo: Pick<Repo, 'facetRuntime'>): readonly BacklinkEdgeExclusion[] =>
  repo.facetRuntime?.read(backlinkEdgeExclusionsFacet) ?? []

/** Types whose blocks' content is a copy of other text: their references are
 *  not their own. Any reader of content references that acts on them, not
 *  only backlinks, should skip these blocks. */
export const contentCopyTypes = (repo: Pick<Repo, 'facetRuntime'>): string[] =>
  [...new Set(exclusionsOf(repo).flatMap(e => e.kind === 'content-from-type' ? [e.type] : []))].sort()

export const edgePredicate = (repo: Repo, edges: BacklinkEdges): EdgePredicate => {
  if (edges !== 'mentions') return {sql: 'br.source_field = ?', params: [edges.field]}
  const fields = [...new Set(exclusionsOf(repo).flatMap(e => e.kind === 'field' ? [e.field] : []))].sort()
  const types = contentCopyTypes(repo)
  const clauses: {sql: string; params: readonly string[]}[] = []
  if (fields.length > 0) clauses.push({sql: `br.source_field NOT IN (${buildInClause(fields.length)})`, params: fields})
  if (types.length > 0) {
    clauses.push({sql: `NOT (br.source_field = '' AND EXISTS (
      SELECT 1 FROM block_types bt WHERE bt.block_id = br.source_id AND bt.type IN (${buildInClause(types.length)})))`, params: types})
  }
  return clauses.length === 0
    ? {sql: '1', params: []}
    : {sql: clauses.map(c => c.sql).join(' AND '), params: clauses.flatMap(c => c.params)}
}
