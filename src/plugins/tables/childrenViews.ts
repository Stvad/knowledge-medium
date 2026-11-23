/** What a table draws, declared to the outline (`childrenViewFacet`), so its
 *  walks, edit policy and merges go by the table rather than the data tree.
 *  - A host, where it is drawn: its query's field rows, then its grid, a
 *    nested surface in a scope of its own (`tableRenderScopeId`). Its view and
 *    column blocks are drawn nowhere, its rows only in the grid.
 *  - A row, in the grid's scope: its notes, the children `RowNotes` draws. */
import { z } from 'zod'
import { defineQuery, type BlockData, type Query } from '@/data/api'
import type { Block } from '@/data/block'
import { childrenViewFacet, surfaceOwnerFacet, type ChildrenView, type NestedSurface } from '@/data/childrenView'
import { queriesFacet } from '@/data/facets'
import { hasBlockType } from '@/data/properties'
import type { AppExtension } from '@/facets/facet'
import { gridInScope, gridOfHost, notesInScope, tableRenderScopeId } from './registry'
import { hostChildrenQuery, queryFieldIdOf, TABLE_TYPE } from './schema'

const ROW_NOTES_QUERY = 'tables.rowNotes'

declare module '@/data/api' {
  interface QueryRegistry {
    [ROW_NOTES_QUERY]: typeof rowNotesQuery
  }
}

/** A row's notes among its `children` (property rows already left out, its
 *  cells draw those): all but the ones the grid also draws as rows, where a
 *  second occurrence in one scope would be a second editor. */
export const notesAmong = (children: readonly string[], isRow: (id: string) => boolean): string[] =>
  children.filter(child => !isRow(child))

const rowNotesQuery: Query<{id: string; rows: string[]}, string[]> = defineQuery<{id: string; rows: string[]}, string[]>({
  name: ROW_NOTES_QUERY,
  argsSchema: z.object({id: z.string(), rows: z.array(z.string())}).strict(),
  resultSchema: z.array(z.string()),
  resolve: async ({id, rows}, ctx) => {
    const selected = new Set(rows)
    return notesAmong(await ctx.run('core.childIds', {id, propertyChildren: 'none' as const}), child => selected.has(child))
  },
})

/** The notes a row draws, given the grid's rows. */
export const rowNotes = (row: Block, rows: readonly string[]) =>
  row.repo.query[ROW_NOTES_QUERY]({id: row.id, rows: [...rows]})

/** A host's query field rows (`QueryFields`), its grid, then under a query
 *  its children the query does not select (`OutsideQuery`, in the host's own scope). */
const hostMembers = async (parent: Block, data: BlockData, renderScopeId: string) => {
  const {repo} = parent
  const grid = gridOfHost(renderScopeId, parent.id)
  const surface: NestedSurface = {
    kind: 'nested-surface',
    renderScopeId: tableRenderScopeId(renderScopeId, parent.id),
    ...(grid && {members: grid.rows, propertyDisplay: grid.rowsDisplayScope}),
  }
  const hasQuery = grid?.hasQuery
  const fieldId = queryFieldIdOf(repo.propertyDefinitions)
  const fields = fieldId === undefined
    ? []
    : (await repo.query.propertyRows({ownerId: parent.id, fieldId}).load()).fields.map(({field}) => field.id)
  if (!hasQuery) return [...fields, surface]
  const shown = new Set(surface.members)
  const outside = (await repo.query.typedBlockIds(hostChildrenQuery(parent.id, data.workspaceId)).load()).filter(id => !shown.has(id))
  return [...fields, surface, ...outside]
}

const viewOf = (parent: Block, data: BlockData, renderScopeId: string | undefined): ChildrenView | null => {
  if (renderScopeId === undefined) return null
  const notes = notesInScope(renderScopeId)
  if (notes?.rowId === parent.id) return {id: 'tables.row', read: () => rowNotes(parent, notes.grid.rows)}
  const grid = gridInScope(renderScopeId)
  if (grid?.isRow(parent.id)) {
    const notesScope = grid.notesScopeId(parent.id)
    if (notesScope === renderScopeId) return {id: 'tables.row', read: () => rowNotes(parent, grid.rows)}
    const surface: NestedSurface = {
      kind: 'nested-surface', renderScopeId: notesScope,
      scopeRootId: parent.id, propertyDisplay: grid.rowsDisplayScope,
    }
    const load = async () => {
      const members = await rowNotes(parent, grid.rows).load()
      return members.length > 0 ? [{...surface, members}] : []
    }
    return {id: 'tables.row', read: () => ({load})}
  }
  return hasBlockType(data, TABLE_TYPE)
    ? {id: 'tables.host', read: () => ({load: () => hostMembers(parent, data, renderScopeId)})}
    : null
}

/** The queries the views read: data-level, so `tablesDataExtension` carries them. */
export const tableChildrenQueries: AppExtension = [
  queriesFacet.of(rowNotesQuery, {source: 'tables'}),
]

export const tableChildrenViews: AppExtension = [
  surfaceOwnerFacet.of(({repo, renderScopeId}) => {
    const notes = notesInScope(renderScopeId)
    if (notes?.grid.host.repo === repo) return {blockId: notes.rowId, surface: notes.grid.rowSurface(notes.rowId)}
    const grid = gridInScope(renderScopeId)
    if (grid?.host.repo !== repo || !grid.parentSurface) return null
    return {blockId: grid.host.id, surface: grid.parentSurface}
  }, {source: 'tables'}),
  childrenViewFacet.of(({parent, data, surface}) => viewOf(parent, data, surface.renderScopeId), {source: 'tables'}),
]
