import type { BlockData, TypedBlockQuery } from '@/data/api'
import type { Block } from '@/data/block'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { useHandle } from '@/hooks/block'
import type { QueryClauses } from './query/parse'
import { COLUMN_TYPE, NOT_TABLE_MACHINERY, VIEW_TYPE, columnFieldProp, columnHiddenProp, columnWidthProp, hostChildrenQuery } from './schema'

/** Rows mount and stay mounted, so a table draws at most this many. */
export const ROW_CAP = 300

/** A row added to a table already at the cap would not be drawn. */
export const canAddRow = (rowCount: number): boolean => rowCount < ROW_CAP

export interface TableColumn {
  readonly id: string
  /** The property definition the column shows, or null for the row's own content. */
  readonly fieldId: string | null
  readonly width: number | undefined
  readonly hidden: boolean
  /** The column block's own text; empty means "use the definition's name". */
  readonly label: string
}

const columnOf = (data: BlockData): TableColumn => ({
  id: data.id,
  fieldId: safeDecodeRowProperty(data, columnFieldProp) ?? null,
  width: safeDecodeRowProperty(data, columnWidthProp),
  hidden: safeDecodeRowProperty(data, columnHiddenProp) === true,
  label: data.content.trim(),
})

export const viewQuery = (hostId: string, workspaceId: string) => ({
  workspaceId, parentId: hostId, types: [VIEW_TYPE], order: 'outline' as const, propertyChildren: 'none' as const,
})

/** The host's view blocks in outline order; the first is the one shown.
 *  Undefined while loading, so a table never flashes as empty. */
export const useViewIds = (host: Block, workspaceId: string): readonly string[] | undefined =>
  useHandle(host.repo.query.typedBlockIds(viewQuery(host.id, workspaceId)), {selector: ids => ids})

export const useColumns = (host: Block, workspaceId: string, viewId: string): readonly TableColumn[] | undefined =>
  useHandle(host.repo.query.typedBlocks({
    workspaceId, parentId: viewId, types: [COLUMN_TYPE], order: 'outline', propertyChildren: 'none',
  }), {selector: blocks => blocks?.map(columnOf)})

/** Without a query, the host's children in outline order; with one, what it
 *  selects, oldest first, never the host itself. Either way field and value
 *  rows are left out, `order` replaces the default, and one id past the cap
 *  comes back so the grid can say it stopped. */
export const rowQuery = (
  hostId: string, workspaceId: string, query: QueryClauses | null, order?: TypedBlockQuery['order'],
): TypedBlockQuery & {limit: number} => ({
  ...query === null
    ? {...hostChildrenQuery(hostId, workspaceId), ...order && {order}}
    : {workspaceId, propertyChildren: 'none', ...query, order: order ?? 'created-asc', exclude: [...query.exclude ?? [], NOT_TABLE_MACHINERY, {id: hostId}]},
  limit: ROW_CAP + 1,
})

export const useRowIds = (
  host: Block, workspaceId: string, query: QueryClauses | null, order?: TypedBlockQuery['order'],
): readonly string[] | undefined =>
  useHandle(host.repo.query.typedBlockIds(rowQuery(host.id, workspaceId, query, order)), {selector: ids => ids})

/** The property names held by the rows the table's source selects, most
 *  common first: what a new column most likely shows. Read once. */
export const rowPropertyNames = async (
  host: Block, workspaceId: string, query: QueryClauses | null,
): Promise<string[]> => {
  const rows = await host.repo.queryBlocks(rowQuery(host.id, workspaceId, query))
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const name of Object.keys(row.properties)) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([name]) => name)
}
