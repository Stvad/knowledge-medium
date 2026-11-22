import { surfaceRenderScopeId } from '@/utils/renderScope'
import type { GridController } from './controller'

export const TABLE_SURFACE = 'tables'

/** The render scope a host drawn in `parentRenderScopeId` draws its rows in. */
export const tableRenderScopeId = (parentRenderScopeId: string, hostId: string): string =>
  surfaceRenderScopeId(TABLE_SURFACE, parentRenderScopeId, hostId)

/** Mounted grids by render scope, for dispatch wraps and editor teardown,
 *  which receive only a block and its scope. */
const grids = new Map<string, GridController>()

export const registerGrid = (renderScopeId: string, controller: GridController): () => void => {
  grids.set(renderScopeId, controller)
  return () => {
    if (grids.get(renderScopeId) === controller) grids.delete(renderScopeId)
  }
}

export const isGridMounted = (renderScopeId: string): boolean => grids.has(renderScopeId)

/** The grid a host drawn in `parentRenderScopeId` shows, if one is mounted. */
export const gridOfHost = (parentRenderScopeId: string, hostId: string): GridController | undefined =>
  grids.get(tableRenderScopeId(parentRenderScopeId, hostId))

/** The grid that draws `blockId` in `renderScopeId`, as a row or as one of a row's values. */
export const gridDrawing = (renderScopeId: string | undefined, blockId: string | undefined): GridController | undefined => {
  if (!renderScopeId || !blockId) return undefined
  const grid = grids.get(renderScopeId)
  return grid?.rowOf(blockId) !== undefined ? grid : undefined
}
