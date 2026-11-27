/** A view's sort: a ref to one of its column blocks and a direction, both on
 *  the view block. A header click cycles ascending, descending, unsorted, in
 *  one transaction and one undo step. */
import { ChangeScope, memberCodecOf, type AnyPropertySchema, type TypedBlockQuery } from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { useHandle } from '@/hooks/block'
import type { TableColumn } from './model'
import { readTableQueryFacets, refValueTarget, type TableQueryFacets } from './query/registrations'
import { viewSortColumnProp, viewSortDirectionProp, type SortDirection } from './schema'

export interface ViewSort {
  readonly columnId: string
  readonly direction: SortDirection
}

type SortKey = Omit<Extract<TypedBlockQuery['order'], {property: string}>, 'direction'>

export const columnSortKeys = (
  repo: Repo, workspaceId: string, schemas: readonly (AnyPropertySchema | undefined)[],
  facets: TableQueryFacets = readTableQueryFacets(repo.facetRuntime, workspaceId),
): readonly (SortKey | undefined)[] => {
  const properties = repo.propertySchemasFor(workspaceId)
  return schemas.map(schema => {
    if (!schema) return undefined
    if (schema.codec.where) {
      return facets.fields?.has(schema.name) || memberCodecOf(schema.codec) ? undefined : {property: schema.name}
    }
    const target = refValueTarget(schema, properties, facets)
    return target ? {property: schema.name, target: target.name} : undefined
  })
}

export const useViewSort = (view: Block): ViewSort | undefined =>
  useHandle(view, {selector: data => {
    const columnId = data ? safeDecodeRowProperty(data, viewSortColumnProp) : undefined
    return data && columnId ? {columnId, direction: safeDecodeRowProperty(data, viewSortDirectionProp)} : undefined
  }})

/** The engine order for a stored sort. A sort whose column is gone, has no
 *  property, or cannot sort, orders nothing. */
export const sortOrder = (
  sort: ViewSort | undefined, columns: readonly TableColumn[], sortKeys: readonly (SortKey | undefined)[],
): TypedBlockQuery['order'] | undefined => {
  if (!sort) return undefined
  const index = columns.findIndex(column => column.id === sort.columnId)
  const key = sortKeys[index]
  return key ? {...key, direction: sort.direction} : undefined
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
