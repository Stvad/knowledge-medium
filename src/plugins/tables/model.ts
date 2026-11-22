import type { BlockData } from '@/data/api'
import type { Block } from '@/data/block'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { useHandle } from '@/hooks/block'
import { COLUMN_TYPE, VIEW_TYPE, columnFieldProp, columnWidthProp } from './schema'

/** Rows mount and stay mounted, so a table draws at most this many. */
export const ROW_CAP = 300

/** A row added to a table already at the cap would not be drawn. */
export const canAddRow = (rowCount: number): boolean => rowCount < ROW_CAP

export interface TableColumn {
  readonly id: string
  /** The property definition the column shows, or null for the row's own content. */
  readonly fieldId: string | null
  readonly width: number | undefined
  /** The column block's own text; empty means "use the definition's name". */
  readonly label: string
}

const columnOf = (data: BlockData): TableColumn => ({
  id: data.id,
  fieldId: safeDecodeRowProperty(data, columnFieldProp) ?? null,
  width: safeDecodeRowProperty(data, columnWidthProp),
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

export const rowQuery = (hostId: string, workspaceId: string, viewIds: readonly string[]) => ({
  workspaceId, parentId: hostId, order: 'outline' as const, propertyChildren: 'none' as const,
  exclude: viewIds.map(id => ({id})), limit: ROW_CAP + 1,
})

/** Every child of the host except its view blocks and its own property rows,
 *  in outline order, one past the cap so the grid can say it stopped. */
export const useRowIds = (host: Block, workspaceId: string, viewIds: readonly string[]): readonly string[] | undefined =>
  useHandle(host.repo.query.typedBlockIds(rowQuery(host.id, workspaceId, viewIds)), {selector: ids => ids})
