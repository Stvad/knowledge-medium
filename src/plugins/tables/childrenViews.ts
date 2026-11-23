/** What a table draws, declared to the outline (`childrenViewFacet`), so its
 *  walks, edit policy and merges go by the table rather than the data tree.
 *  - A host, where it is drawn: its query's field rows, then its grid, a
 *    nested surface in a scope of its own (`tableRenderScopeId`). Its view and
 *    column blocks are drawn nowhere, its rows only in the grid.
 *  - A row, in the grid's scope: its notes, the children `RowNotes` draws. */
import { z } from 'zod'
import { defineQuery, type BlockData, type Query } from '@/data/api'
import type { Block } from '@/data/block'
import { childrenViewFacet, type ChildrenView, type DrawnChild } from '@/data/childrenView'
import { queriesFacet } from '@/data/facets'
import { hasBlockType } from '@/data/properties'
import type { Repo } from '@/data/repo'
import type { AppExtension } from '@/facets/facet'
import { gridDrawing, tableRenderScopeId } from './registry'
import { queryProp, TABLE_TYPE } from './schema'

const ROW_NOTES_QUERY = 'tables.rowNotes'
const HOST_MEMBERS_QUERY = 'tables.hostMembers'

declare module '@/data/api' {
  interface QueryRegistry {
    [ROW_NOTES_QUERY]: typeof rowNotesQuery
    [HOST_MEMBERS_QUERY]: typeof hostMembersQuery
  }
}

/** A row's children less its property rows (its cells draw those) and less
 *  `rows`, its children the grid also draws as rows: a second occurrence in
 *  one scope would be a second editor. */
const rowNotesQuery: Query<{id: string; rows: string[]}, string[]> = defineQuery<{id: string; rows: string[]}, string[]>({
  name: ROW_NOTES_QUERY,
  argsSchema: z.object({id: z.string(), rows: z.array(z.string())}).strict(),
  resultSchema: z.array(z.string()),
  resolve: async ({id, rows}, ctx) => {
    const ids = await ctx.run('core.childIds', {id, hydrate: true, propertyChildren: 'none' as const})
    return rows.length === 0 ? ids : ids.filter(child => !rows.includes(child))
  },
})

/** A host's query field rows (`QueryFields`), then its grid. */
type HostMembersArgs = {hostId: string; queryFieldId: string | null; gridScope: string}

const hostMembersQuery: Query<HostMembersArgs, DrawnChild[]> = defineQuery<HostMembersArgs, DrawnChild[]>({
  name: HOST_MEMBERS_QUERY,
  argsSchema: z.object({hostId: z.string(), queryFieldId: z.string().nullable(), gridScope: z.string()}).strict(),
  resultSchema: {parse: input => input as DrawnChild[]},
  resolve: async ({hostId, queryFieldId, gridScope}, ctx) => {
    const fields = queryFieldId === null
      ? []
      : (await ctx.run('core.propertyRows', {ownerId: hostId, fieldId: queryFieldId})).fields.map(({field}) => field.id)
    return [...fields, {kind: 'nested-surface', renderScopeId: gridScope}]
  },
})

/** Of `rows`, those that are `rowId`'s own children, in a stable order. */
const rowsUnder = (repo: Repo, rowId: string, rows: Iterable<string>): string[] =>
  [...rows].filter(id => repo.block(id).peek()?.parentId === rowId).sort()

/** The notes a row draws, given the grid's rows: one handle for `RowNotes` and the walks. */
export const rowNotes = (row: Block, rows: Iterable<string>) =>
  row.repo.query[ROW_NOTES_QUERY]({id: row.id, rows: rowsUnder(row.repo, row.id, rows)})

const queryFieldIdOf = (repo: Repo): string | null =>
  repo.propertyDefinitions?.definitionsByName.get(queryProp.name)?.[0]?.fieldId ?? null

const hostView = (parent: Block, renderScopeId: string): ChildrenView => ({
  id: 'tables.host',
  read: () => parent.repo.query[HOST_MEMBERS_QUERY]({
    hostId: parent.id,
    queryFieldId: queryFieldIdOf(parent.repo),
    gridScope: tableRenderScopeId(renderScopeId, parent.id),
  }),
})

const viewOf = (parent: Block, data: BlockData, renderScopeId: string | undefined): ChildrenView | null => {
  if (renderScopeId === undefined) return null
  const grid = gridDrawing(renderScopeId, parent.id)
  if (grid?.isRow(parent.id)) return {id: 'tables.row', read: () => rowNotes(parent, grid.rows)}
  return hasBlockType(data, TABLE_TYPE) ? hostView(parent, renderScopeId) : null
}

/** The queries the views read: data-level, so `tablesDataExtension` carries them. */
export const tableChildrenQueries: AppExtension = [
  queriesFacet.of(rowNotesQuery, {source: 'tables'}),
  queriesFacet.of(hostMembersQuery, {source: 'tables'}),
]

export const tableChildrenViews: AppExtension = [
  childrenViewFacet.of(({parent, data, surface}) => viewOf(parent, data, surface.renderScopeId), {source: 'tables'}),
]
