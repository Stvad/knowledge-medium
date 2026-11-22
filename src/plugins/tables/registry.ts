import type { GridController } from './controller'

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

/** The grid that draws `blockId` in `renderScopeId`, as a row or as one of a row's values. */
export const gridDrawing = (renderScopeId: string | undefined, blockId: string | undefined): GridController | undefined => {
  if (!renderScopeId || !blockId) return undefined
  const grid = grids.get(renderScopeId)
  return grid?.rowOf(blockId) !== undefined ? grid : undefined
}
