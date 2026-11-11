/**
 * Zoomable surfaces: a block's subtree rendered nested in a panel (a comment
 * card, say) that a zoom made inside it re-roots, as a zoom made in a panel's
 * outline re-roots the panel.
 *
 * A surface is zoomable while it is mounted (`registerZoomableSurface`,
 * through `ZoomableSurface`). Its zoom is per-tab view state keyed by its
 * render scope, and outlives the mount. `navigate` hands a zoom whose
 * `sourceRenderScopeId` is a mounted surface's here, before the navigation
 * verb runs: it is not a navigation, and no decorator sees it.
 *
 * A stored zoom is a request, not the surface's state: a block no longer
 * under the surface's root (moved, deleted) zooms nothing. `zoomPath` is the
 * one rule for that, read by the surface as it renders and by zoom out.
 */

import {useSyncExternalStore} from 'react'
import {ChangeScope, type BlockData} from '@/data/api'
import {revealChildren} from '@/data/mutators'
import {focusBlock, isCollapsedProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {CallbackSet} from '@/utils/callbackSet'

interface MountedSurface {
  /** The block the surface shows when it isn't zoomed. */
  rootId: string
  /** The render scope the surface is mounted in: another zoomable surface's
   *  when it is nested in one. */
  parentRenderScopeId: string | undefined
}

const mounted = new Map<string, MountedSurface>()
const zooms = new Map<string, string>()
const listeners = new CallbackSet('surface-zoom')

export const registerZoomableSurface = (renderScopeId: string, surface: MountedSurface): (() => void) => {
  mounted.set(renderScopeId, surface)
  return () => {
    if (mounted.get(renderScopeId) === surface) mounted.delete(renderScopeId)
  }
}

export const setSurfaceZoom = (renderScopeId: string, blockId: string | null): void => {
  if ((zooms.get(renderScopeId) ?? null) === blockId) return
  if (blockId === null) zooms.delete(renderScopeId)
  else zooms.set(renderScopeId, blockId)
  listeners.notify()
}

export const peekSurfaceZoom = (renderScopeId: string): string | undefined => zooms.get(renderScopeId)

const subscribe = (listener: () => void): (() => void) => listeners.add(listener)

export const useSurfaceZoom = (renderScopeId: string): string | undefined =>
  useSyncExternalStore(subscribe, () => zooms.get(renderScopeId))

export const __resetSurfaceZoomsForTesting = (): void => {
  mounted.clear()
  zooms.clear()
  listeners.notify()
}

/** The blocks between a surface's root and a block zoomed into, outermost
 *  first, from that block's ancestors (nearest first). Null when they don't
 *  reach the root: the block is no longer under it. */
export const zoomPath = <T extends Pick<BlockData, 'id'>>(ancestors: readonly T[], rootId: string): T[] | null => {
  const root = ancestors.findIndex(ancestor => ancestor.id === rootId)
  return root < 0 ? null : ancestors.slice(0, root).reverse()
}

/** The mounted surfaces from `renderScopeId` outwards: a surface nested in
 *  another one's row is inside that one's zoom. Each once, so a surface
 *  registered as its own parent ends the walk. */
function* surfacesAround(renderScopeId: string): Generator<[string, MountedSurface]> {
  const seen = new Set<string>()
  for (let at: string | undefined = renderScopeId, surface; at !== undefined && !seen.has(at) && (surface = mounted.get(at)); at = surface.parentRenderScopeId) {
    seen.add(at)
    yield [at, surface]
  }
}

/** Zooms the surface mounted at `renderScopeId` into `blockId` and focuses
 *  it there; onto the surface's root, shows the whole surface again. A
 *  collapsed block is expanded, as a panel shows its root's children whatever
 *  the root's collapse. False, having done nothing, when there is no such
 *  surface or the block is not under its root: the zoom is the panel's. */
export const zoomSurfaceIn = async (
  repo: Repo,
  {renderScopeId, blockId, panelId}: {renderScopeId: string; blockId: string; panelId: string},
): Promise<boolean> => {
  const surface = mounted.get(renderScopeId)
  if (!surface) return false
  const zoomsIn = surface.rootId !== blockId
  if (zoomsIn && !zoomPath((await repo.query.ancestors({id: blockId}).load()).ancestors, surface.rootId)) return false
  setSurfaceZoom(renderScopeId, zoomsIn ? blockId : null)
  if (zoomsIn && !repo.isReadOnly) {
    const block = repo.block(blockId)
    await block.load()
    if (block.peekProperty(isCollapsedProp)) {
      await repo.tx(tx => revealChildren(tx, blockId), {scope: ChangeScope.BlockDefault, description: 'reveal zoomed block'})
    }
  }
  await focusBlock(repo.block(panelId), blockId, {renderScopeId})
  return true
}

/** Steps the innermost zoomed surface at or around `renderScopeId` out one
 *  level. False when none is zoomed, a stale request included: the zoom out
 *  is then the panel's. */
export const zoomSurfaceOut = async (repo: Repo, renderScopeId: string): Promise<boolean> => {
  for (const [scope, {rootId}] of surfacesAround(renderScopeId)) {
    const zoomed = zooms.get(scope)
    if (zoomed === undefined) continue
    const {ancestors} = await repo.query.ancestors({id: zoomed}).load()
    const path = zoomPath(ancestors, rootId)
    setSurfaceZoom(scope, path?.at(-1)?.id ?? null)
    if (path) return true
  }
  return false
}
