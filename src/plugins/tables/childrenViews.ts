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
import { gridDrawing, gridOfHost, tableRenderScopeId } from './registry'
import { hostChildrenQuery, queryFieldIdOf, TABLE_TYPE } from './schema'

const ROW_NOTES_QUERY = 'tables.rowNotes'
const HOST_MEMBERS_QUERY = 'tables.hostMembers'

declare module '@/data/api' {
  interface QueryRegistry {
    [ROW_NOTES_QUERY]: typeof rowNotesQuery
    [HOST_MEMBERS_QUERY]: typeof hostMembersQuery
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
  resolve: async ({id, rows}, ctx) =>
    notesAmong(await ctx.run('core.childIds', {id, propertyChildren: 'none' as const}), child => rows.includes(child)),
})

type HostMembersArgs = {
  hostId: string
  workspaceId: string
  queryFieldId: string | null
  gridScope: string
  /** Under a query, the rows that are the host's own children; null without one. */
  rows: string[] | null
}

/** A host's query field rows (`QueryFields`), its grid, then under a query
 *  its children the query does not select (`OutsideQuery`, in the host's own scope). */
const hostMembersQuery: Query<HostMembersArgs, DrawnChild[]> = defineQuery<HostMembersArgs, DrawnChild[]>({
  name: HOST_MEMBERS_QUERY,
  argsSchema: z.object({
    hostId: z.string(), workspaceId: z.string(), queryFieldId: z.string().nullable(), gridScope: z.string(),
    rows: z.array(z.string()).nullable(),
  }).strict(),
  resultSchema: {parse: input => input as DrawnChild[]},
  resolve: async ({hostId, workspaceId, queryFieldId, gridScope, rows}, ctx) => {
    const fields = queryFieldId === null
      ? []
      : (await ctx.run('core.propertyRows', {ownerId: hostId, fieldId: queryFieldId})).fields.map(({field}) => field.id)
    const outside = rows === null
      ? []
      : (await ctx.run('core.typedBlockIds', hostChildrenQuery(hostId, workspaceId))).filter(id => !rows.includes(id))
    return [...fields, {kind: 'nested-surface', renderScopeId: gridScope}, ...outside]
  },
})

/** Of `rows`, those that are `parentId`'s own children, in a stable order. */
const rowsUnder = (repo: Repo, parentId: string, rows: Iterable<string>): string[] =>
  [...rows].filter(id => repo.block(id).peek()?.parentId === parentId).sort()

/** The notes a row draws, given the grid's rows. */
export const rowNotes = (row: Block, rows: Iterable<string>) =>
  row.repo.query[ROW_NOTES_QUERY]({id: row.id, rows: rowsUnder(row.repo, row.id, rows)})

const hostView = (parent: Block, data: BlockData, renderScopeId: string): ChildrenView => {
  const grid = gridOfHost(renderScopeId, parent.id)
  return {
    id: 'tables.host',
    read: () => parent.repo.query[HOST_MEMBERS_QUERY]({
      hostId: parent.id,
      workspaceId: data.workspaceId,
      queryFieldId: queryFieldIdOf(parent.repo.propertyDefinitions) ?? null,
      gridScope: tableRenderScopeId(renderScopeId, parent.id),
      rows: grid?.hasQuery ? rowsUnder(parent.repo, parent.id, grid.rows) : null,
    }),
  }
}

const viewOf = (parent: Block, data: BlockData, renderScopeId: string | undefined): ChildrenView | null => {
  if (renderScopeId === undefined) return null
  const grid = gridDrawing(renderScopeId, parent.id)
  if (grid?.isRow(parent.id)) return {id: 'tables.row', read: () => rowNotes(parent, grid.rows)}
  return hasBlockType(data, TABLE_TYPE) ? hostView(parent, data, renderScopeId) : null
}

/** The queries the views read: data-level, so `tablesDataExtension` carries them. */
export const tableChildrenQueries: AppExtension = [
  queriesFacet.of(rowNotesQuery, {source: 'tables'}),
  queriesFacet.of(hostMembersQuery, {source: 'tables'}),
]

export const tableChildrenViews: AppExtension = [
  childrenViewFacet.of(({parent, data, surface}) => viewOf(parent, data, surface.renderScopeId), {source: 'tables'}),
]
