import { createContext } from 'react'

/**
 * The seam between App (which owns boot resolution + the getInitialLayout
 * cache) and whichever renderer owns the layout root. App provides the
 * resolved layout-session block id plus a callback; the layout-root renderer
 * (TopLevelRenderer by default, or an extension override) consumes it via
 * `usePanelLayoutProjection`.
 *
 * An extension can become the layout-root renderer two ways — a
 * higher-priority renderer registered for `layoutBoundary && !panelId`, OR a
 * `renderer` property (rendererProp) set on the layout-session block itself
 * (useRenderer checks that first, ahead of canRender/priority — see
 * @/hooks/useRendererRegistry). Both fully bypass TopLevelRenderer, so
 * whichever one is in play must call `usePanelLayoutProjection` itself or
 * this context goes unconsumed and the URL⇄layout sync silently dies.
 *
 * `onLayoutHashChanged` MUST be called whenever the projection observes a
 * layout hash change — App uses it to bust the initial-layout cache, and
 * workspace re-resolution (Back button into another workspace, manual hash
 * edit) depends on that bust happening.
 */
export interface LayoutRootContextValue {
  rootBlockId: string
  onLayoutHashChanged: () => void
}

export const LayoutRootContext = createContext<LayoutRootContextValue | null>(null)
