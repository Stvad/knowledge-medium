import { surfaceRenderScopeId } from '@/utils/renderScope'
import type { GridController } from './controller'

export const TABLE_SURFACE = 'tables'

/** The render scope a host drawn in `parentRenderScopeId` draws its rows in. */
export const tableRenderScopeId = (parentRenderScopeId: string, hostId: string): string =>
  surfaceRenderScopeId(TABLE_SURFACE, parentRenderScopeId, hostId)

const NOTES_SURFACE = 'tables.notes'

export const tableNotesScopeId = (gridScope: string, rowId: string): string =>
  surfaceRenderScopeId(NOTES_SURFACE, gridScope, rowId)

/** The owner is declared as soon as the grid lists the row, including lazy rows. */
export const notesInScope = (renderScopeId: string): {grid: GridController; rowId: string} | undefined => {
  const [surface, row, parent, ...rest] = renderScopeId.split(':')
  if (surface !== `surface.${NOTES_SURFACE}` || !row || !parent || rest.length > 0) return undefined
  try {
    const rowId = decodeURIComponent(row)
    const grid = grids.get(decodeURIComponent(parent))
    if (grid?.hasQuery && grid.isRow(rowId)) return {grid, rowId}
  } catch {
    return undefined
  }
}

/** Mounted grids by render scope, for dispatch wraps and editor teardown,
 *  which receive only a block and its scope. */
const grids = new Map<string, GridController>()

export const registerGrid = (renderScopeId: string, controller: GridController): () => void => {
  grids.set(renderScopeId, controller)
  return () => {
    if (grids.get(renderScopeId) === controller) grids.delete(renderScopeId)
  }
}

export const gridInScope = (renderScopeId: string): GridController | undefined => grids.get(renderScopeId)

export const isGridMounted = (renderScopeId: string): boolean => grids.has(renderScopeId)

/** The grid a host drawn in `parentRenderScopeId` shows, if one is mounted. */
export const gridOfHost = (parentRenderScopeId: string, hostId: string): GridController | undefined =>
  grids.get(tableRenderScopeId(parentRenderScopeId, hostId))

/** The grid that draws `blockId` in `renderScopeId`: a row, or a block in one of its cells. */
export const gridDrawing = (renderScopeId: string | undefined, blockId: string | undefined): GridController | undefined => {
  if (!renderScopeId || !blockId) return undefined
  const owner = notesInScope(renderScopeId)
  if (owner) return owner.grid
  const grid = grids.get(renderScopeId)
  return grid?.rowOf(blockId) !== undefined ? grid : undefined
}
