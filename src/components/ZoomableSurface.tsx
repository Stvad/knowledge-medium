/**
 * The rendering half of a zoomable surface (`@/utils/surfaceZoom`): the
 * surface declares its render scope and root, and renders whichever block its
 * zoom says, under crumbs that lead back out.
 */

import {useEffect, type ReactNode} from 'react'
import {ChevronRight} from 'lucide-react'
import {useBlockContext} from '@/context/block.js'
import {useRepo} from '@/context/repo.js'
import {useHandle} from '@/hooks/block.js'
import {firstLine, truncate} from '@/utils/string.js'
import {registerZoomableSurface, setSurfaceZoom, useSurfaceZoom, zoomPath} from '@/utils/surfaceZoom.js'

export interface ZoomCrumb {
  id: string
  label: string
}

export interface SurfaceZoom {
  /** The block the surface shows in its root's place. */
  blockId: string
  /** The blocks between the root and it, outermost first. */
  crumbs: readonly ZoomCrumb[]
}

const CRUMB_CHARS = 32

export const crumbLabel = (text: string): string => truncate(firstLine(text.trimStart()), CRUMB_CHARS)

const NO_CRUMBS: readonly ZoomCrumb[] = Object.freeze([])

interface ZoomableSurfaceProps {
  /** The scope the surface renders its blocks in. */
  renderScopeId: string
  rootId: string
  /** Renders the surface: zoomed, `zoom.blockId` in the root's place. */
  children: (zoom: SurfaceZoom | null) => ReactNode
}

/** Mounted in the scope the surface sits in, around the surface's own
 *  context: that outer scope is what nests it in another zoomable surface. */
export const ZoomableSurface = ({renderScopeId, rootId, children}: ZoomableSurfaceProps) => {
  const {renderScopeId: parentRenderScopeId} = useBlockContext()
  useEffect(
    () => registerZoomableSurface(renderScopeId, {rootId, parentRenderScopeId}),
    [renderScopeId, rootId, parentRenderScopeId],
  )
  const zoomed = useSurfaceZoom(renderScopeId)
  // A component of its own, so a surface that isn't zoomed reads no ancestors.
  return zoomed === undefined ? children(null) : <Zoomed zoomed={zoomed} rootId={rootId}>{children}</Zoomed>
}

/** While the zoomed block's ancestors are being read the surface is zoomed,
 *  without its inner crumbs: showing the root until they arrive would remount
 *  the surface twice. */
const Zoomed = ({zoomed, rootId, children}: {zoomed: string} & Pick<ZoomableSurfaceProps, 'rootId' | 'children'>) => {
  const crumbs = useHandle(useRepo().query.ancestors({id: zoomed}), {
    selector: chain => chain
      ? zoomPath(chain.ancestors, rootId)?.map(({id, content}) => ({id, label: crumbLabel(content)})) ?? null
      : NO_CRUMBS,
  })
  return children(crumbs ? {blockId: zoomed, crumbs} : null)
}

const Crumb = ({label, onClick}: {label: string; onClick: () => void}) => (
  <>
    <button
      type="button"
      onClick={event => { event.stopPropagation(); onClick() }}
      className="max-w-full truncate hover:text-foreground hover:underline"
    >
      {label || '…'}
    </button>
    <ChevronRight className="h-3 w-3 shrink-0" aria-hidden/>
  </>
)

interface SurfaceZoomCrumbsProps {
  renderScopeId: string
  zoom: SurfaceZoom
  /** Names the surface's root, the crumb that shows all of it again. */
  rootLabel: string
  /** The crumb row's accessible name. */
  label: string
}

export const SurfaceZoomCrumbs = ({renderScopeId, zoom, rootLabel, label}: SurfaceZoomCrumbsProps) => (
  <nav aria-label={label} className="flex flex-wrap items-center gap-x-0.5 px-1 text-xs text-muted-foreground">
    <Crumb label={rootLabel} onClick={() => setSurfaceZoom(renderScopeId, null)}/>
    {zoom.crumbs.map(crumb => (
      <Crumb key={crumb.id} label={crumb.label} onClick={() => setSurfaceZoom(renderScopeId, crumb.id)}/>
    ))}
  </nav>
)
