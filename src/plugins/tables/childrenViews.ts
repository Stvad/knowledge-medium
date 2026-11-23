/** What a table draws, declared to the outline (`childrenViewFacet`), so its
 *  walks, edit policy and merges go by the table rather than the data tree.
 *  - A host, where it is drawn: its query's field rows, then its grid, a
 *    nested surface in a scope of its own (`tableRenderScopeId`). Its view and
 *    column blocks are drawn nowhere, its rows only in the grid.
 *  - A row, in the grid's scope: its notes, the children `RowNotes` draws. */
import { z } from 'zod'
import { defineQuery, type BlockData, type Query } from '@/data/api'
import type { Block } from '@/data/block'
import { childrenViewFacet, surfaceOwnerFacet, type ChildrenView, type DrawnChild, type NestedSurface } from '@/data/childrenView'
import { queriesFacet } from '@/data/facets'
import { hasBlockType } from '@/data/properties'
import { propertyDisplayScopeSchema } from '@/data/propertyDisplayMode'
import type { AppExtension } from '@/facets/facet'
import { gridInScope, gridOfHost, notesInScope, tableRenderScopeId } from './registry'
import { hostChildrenQuery, queryFieldIdOf, TABLE_TYPE } from './schema'

const nestedSurfaceSchema = z.object({
  kind: z.literal('nested-surface'),
  renderScopeId: z.string(),
  members: z.array(z.string()).optional(),
  propertyDisplay: propertyDisplayScopeSchema.optional(),
  scopeRootId: z.string().optional(),
  isolateSelection: z.boolean().optional(),
}).strict()

const ROW_NOTES_QUERY = 'tables.rowNotes'
const HOST_MEMBERS_QUERY = 'tables.hostMembers'
const ROW_MEMBERS_QUERY = 'tables.rowMembers'

declare module '@/data/api' {
  interface QueryRegistry {
    [ROW_NOTES_QUERY]: typeof rowNotesQuery
    [HOST_MEMBERS_QUERY]: typeof hostMembersQuery
    [ROW_MEMBERS_QUERY]: typeof rowMembersQuery
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

type RowMembersArgs = {id: string; rows: string[]; notes: NestedSurface}

const rowMembersQuery: Query<RowMembersArgs, DrawnChild[]> = defineQuery<RowMembersArgs, DrawnChild[]>({
  name: ROW_MEMBERS_QUERY,
  argsSchema: z.object({id: z.string(), rows: z.array(z.string()), notes: nestedSurfaceSchema}).strict(),
  resultSchema: {parse: input => input as DrawnChild[]},
  resolve: async ({id, rows, notes}, ctx) => {
    const members = await ctx.run(ROW_NOTES_QUERY, {id, rows})
    return members.length > 0 ? [{...notes, members}] : []
  },
})

type HostMembersArgs = {
  hostId: string
  workspaceId: string
  queryFieldId: string | null
  hasQuery: boolean
  grid: NestedSurface
}

/** A host's query field rows (`QueryFields`), its grid, then under a query
 *  its children the query does not select (`OutsideQuery`, in the host's own scope). */
const hostMembersQuery: Query<HostMembersArgs, DrawnChild[]> = defineQuery<HostMembersArgs, DrawnChild[]>({
  name: HOST_MEMBERS_QUERY,
  argsSchema: z.object({
    hostId: z.string(), workspaceId: z.string(), queryFieldId: z.string().nullable(),
    hasQuery: z.boolean(),
    grid: nestedSurfaceSchema,
  }).strict(),
  resultSchema: {parse: input => input as DrawnChild[]},
  resolve: async ({hostId, workspaceId, queryFieldId, hasQuery, grid}, ctx) => {
    const fields = queryFieldId === null
      ? []
      : (await ctx.run('core.propertyRows', {ownerId: hostId, fieldId: queryFieldId})).fields.map(({field}) => field.id)
    if (!hasQuery) return [...fields, grid]
    const shown = new Set(grid.members)
    const outside = (await ctx.run('core.typedBlockIds', hostChildrenQuery(hostId, workspaceId))).filter(id => !shown.has(id))
    return [...fields, grid, ...outside]
  },
})

/** The notes a row draws, given the grid's rows. */
export const rowNotes = (row: Block, rows: readonly string[]) =>
  row.repo.query[ROW_NOTES_QUERY]({id: row.id, rows: [...rows]})

const hostView = (parent: Block, data: BlockData, renderScopeId: string): ChildrenView => {
  const grid = gridOfHost(renderScopeId, parent.id)
  return {
    id: 'tables.host',
    read: () => parent.repo.query[HOST_MEMBERS_QUERY]({
      hostId: parent.id,
      workspaceId: data.workspaceId,
      queryFieldId: queryFieldIdOf(parent.repo.propertyDefinitions) ?? null,
      hasQuery: grid?.hasQuery ?? false,
      grid: {
        kind: 'nested-surface',
        renderScopeId: tableRenderScopeId(renderScopeId, parent.id),
        ...(grid && {members: grid.rows, propertyDisplay: grid.rowsDisplayScope, isolateSelection: true}),
      },
    }),
  }
}

const viewOf = (parent: Block, data: BlockData, renderScopeId: string | undefined): ChildrenView | null => {
  if (renderScopeId === undefined) return null
  const notes = notesInScope(renderScopeId)
  if (notes?.rowId === parent.id) return {id: 'tables.row', read: () => rowNotes(parent, notes.grid.rows)}
  const grid = gridInScope(renderScopeId)
  if (grid?.isRow(parent.id)) {
    return {
      id: 'tables.row',
      read: () => grid.hasQuery ? parent.repo.query[ROW_MEMBERS_QUERY]({
        id: parent.id,
        rows: [...grid.rows],
        notes: {
          kind: 'nested-surface', renderScopeId: grid.notesScopeId(parent.id),
          scopeRootId: parent.id, propertyDisplay: grid.rowsDisplayScope,
        },
      }) : rowNotes(parent, grid.rows),
    }
  }
  return hasBlockType(data, TABLE_TYPE) ? hostView(parent, data, renderScopeId) : null
}

/** The queries the views read: data-level, so `tablesDataExtension` carries them. */
export const tableChildrenQueries: AppExtension = [
  queriesFacet.of(rowMembersQuery, {source: 'tables'}),
  queriesFacet.of(rowNotesQuery, {source: 'tables'}),
  queriesFacet.of(hostMembersQuery, {source: 'tables'}),
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
