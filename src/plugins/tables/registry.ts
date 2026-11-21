import type { GridController } from './controller'

/** Mounted grids by render scope, for dispatch wraps that receive only an
 *  action's dependencies. */
const grids = new Map<string, GridController>()

export const registerGrid = (renderScopeId: string, controller: GridController): () => void => {
  grids.set(renderScopeId, controller)
  return () => {
    if (grids.get(renderScopeId) === controller) grids.delete(renderScopeId)
  }
}

/** The grid that draws `blockId` as one of its rows in `renderScopeId`. */
export const gridForRow = (renderScopeId: string | undefined, blockId: string | undefined): GridController | undefined => {
  if (!renderScopeId || !blockId) return undefined
  const grid = grids.get(renderScopeId)
  return grid?.hasRow(blockId) ? grid : undefined
}
