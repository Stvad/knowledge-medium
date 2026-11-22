import type { BlockData, TypedBlockQuery } from '@/data/api'
import type { Block } from '@/data/block'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { useHandle } from '@/hooks/block'
import type { QueryClauses } from './query/parse'
import { COLUMN_TYPE, VIEW_TYPE, columnFieldProp, columnHiddenProp, columnWidthProp } from './schema'

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

/** No row source returns a table's own configuration, this table's or another's. */
const NOT_TABLE_MACHINERY = {types: [VIEW_TYPE, COLUMN_TYPE]}

/** Without a query, the host's children in outline order; with one, what it
 *  selects, oldest first, never the host itself. Either way field and value
 *  rows are left out, `order` replaces the default, and one id past the cap
 *  comes back so the grid can say it stopped. */
export const rowQuery = (
  hostId: string, workspaceId: string, query: QueryClauses | null, order?: TypedBlockQuery['order'],
): TypedBlockQuery & {limit: number} => ({
  workspaceId, propertyChildren: 'none', limit: ROW_CAP + 1,
  ...query === null
    ? {parentId: hostId, order: order ?? 'outline', exclude: [NOT_TABLE_MACHINERY]}
    : {...query, order: order ?? 'created-asc', exclude: [...query.exclude ?? [], NOT_TABLE_MACHINERY, {id: hostId}]},
})

export const useRowIds = (
  host: Block, workspaceId: string, query: QueryClauses | null, order?: TypedBlockQuery['order'],
): readonly string[] | undefined =>
  useHandle(host.repo.query.typedBlockIds(rowQuery(host.id, workspaceId, query, order)), {selector: ids => ids})
