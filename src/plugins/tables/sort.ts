/** A view's sort: a ref to one of its column blocks and a direction, both on
 *  the view block. A header click cycles ascending, descending, unsorted, in
 *  one transaction and one undo step. */
import { ChangeScope, memberCodecOf, type AnyPropertySchema, type TypedBlockQuery } from '@/data/api'
import type { Block } from '@/data/block'
import { queryableFieldsFacet } from '@/data/facets'
import type { Repo } from '@/data/repo'
import { useMemo } from 'react'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { useHandle } from '@/hooks/block'
import type { TableColumn } from './model'
import { viewSortColumnProp, viewSortDirectionProp, type SortDirection } from './schema'

export interface ViewSort {
  readonly columnId: string
  readonly direction: SortDirection
}

/** Sorts in SQL: a scalar codec the engine compares, under a name no queryable
 *  field also claims (the engine refuses an order on such a name). Lists,
 *  references and the row's own text do not sort yet. */
export const isSortable = (
  schema: AnyPropertySchema | undefined, fieldNames: ReadonlySet<string>,
): schema is AnyPropertySchema =>
  schema?.codec.where !== undefined && memberCodecOf(schema.codec) === undefined && !fieldNames.has(schema.name)

export const useViewSort = (view: Block): ViewSort | undefined =>
  useHandle(view, {selector: data => {
    const columnId = data ? safeDecodeRowProperty(data, viewSortColumnProp) : undefined
    return data && columnId ? {columnId, direction: safeDecodeRowProperty(data, viewSortDirectionProp)} : undefined
  }})

/** The engine order for a stored sort. A sort whose column is gone, has no
 *  property, or cannot sort, orders nothing. */
export const sortOrder = (
  sort: ViewSort | undefined, columns: readonly TableColumn[], schemas: readonly (AnyPropertySchema | undefined)[],
  fieldNames: ReadonlySet<string>,
): TypedBlockQuery['order'] | undefined => {
  if (!sort) return undefined
  const index = columns.findIndex(column => column.id === sort.columnId)
  const schema = index >= 0 ? schemas[index] : undefined
  return isSortable(schema, fieldNames) ? {property: schema.name, direction: sort.direction} : undefined
}

/** The queryable fields' names in a workspace (`created`, `updated`, a plugin's). */
export const useQueryableFieldNames = (repo: Repo, workspaceId: string): ReadonlySet<string> => {
  const fields = repo.facetRuntime?.read(queryableFieldsFacet, workspaceId)
  return useMemo(() => new Set(fields?.keys() ?? []), [fields])
}

export const nextSort = (current: ViewSort | undefined, columnId: string): ViewSort | undefined =>
  current?.columnId !== columnId ? {columnId, direction: 'asc'}
    : current.direction === 'asc' ? {columnId, direction: 'desc'}
    : undefined

export const writeSort = (repo: Repo, viewId: string, sort: ViewSort | undefined) =>
  repo.tx(async tx => {
    if (sort) {
      await tx.setProperty(viewId, viewSortColumnProp, sort.columnId)
      await tx.setProperty(viewId, viewSortDirectionProp, sort.direction)
    } else {
      await tx.unsetProperty(viewId, viewSortColumnProp)
      await tx.unsetProperty(viewId, viewSortDirectionProp)
    }
  }, {scope: ChangeScope.BlockDefault, description: 'sort table'})
