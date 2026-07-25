import { Header } from '@/components/Header.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { BlockRendererProps } from '@/types.js'
import { NestedBlockContextProvider } from '@/context/block.js'
import { useActionContext } from '@/shortcuts/useActionContext.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { outlineRenderScopeId } from '@/utils/renderScope.js'
import { usePanelLayoutProjection } from '@/hooks/usePanelLayoutProjection.js'

export function TopLevelRenderer({block}: BlockRendererProps) {
  /**
   * todo think about composition
   * I actually want the below thing to pick the renderer itself, but if my logic is
   * pick layout for top level, and then I go and try to pick renderer fo the block, by default
   * it will pick the layout renderer again recursively, which is not what I want
   * it needs to work with different data, hence context
   *
   * I'm not sure if I love context approach.
   * It moves away from "all data is in the document"
   * But I can't like designate the block "top level" and then change that and pass it down
   * bc change would immediately propagate to higher level renderer
   *
   */

  useActionContext(ActionContextTypes.GLOBAL)

  // TopLevelRenderer is the DEFAULT layout-root renderer: it owns the
  // URL⇄layout projection for the root block. There are two ways an
  // extension can take over the root instead of TopLevelRenderer — both
  // BYPASS this component, so whichever one is used MUST call
  // usePanelLayoutProjection itself, or the URL⇄layout sync silently dies:
  //   1. Register a higher-priority renderer for `layoutBoundary && !panelId`
  //      (useRenderer's canRender/priority resolution, @/hooks/useRendererRegistry).
  //   2. Set a `renderer` property (rendererProp) directly on the
  //      layout-session block — useRenderer checks that BEFORE canRender/
  //      priority, so it wins over TopLevelRenderer even without a
  //      higher-priority registration.
  usePanelLayoutProjection(block)

  return (
    // paddingTop reserves the iOS status-bar strip. As an installed PWA we run
    // `apple-mobile-web-app-status-bar-style=black-translucent` + `viewport-fit=cover`
    // (index.html), so iOS draws content full-screen BEHIND the translucent status
    // bar; without this inset the Header sits under the clock/battery (visible on
    // iPad). It's on the `bg-background` frame so the themed background still flows
    // edge-to-edge behind the status bar (the immersive look black-translucent buys),
    // with only the content pushed down. The *top* inset is 0 in a normal browser tab
    // (Safari's own top chrome already covers the notch there), so this is inert
    // outside the installed PWA. Bottom insets are handled per-surface (bottom nav,
    // sidebar footer, panel scroller) to avoid double-insetting; the left-sidebar
    // overlay reserves its OWN top inset (it's a viewport-anchored sibling of this
    // frame, not a child — see LeftSidebar). Left/right insets aren't reserved
    // anywhere yet (landscape-notch gutters) — a pre-existing gap, not handled here.
    <div
      className="min-h-screen h-screen bg-background text-foreground flex flex-col"
      style={{paddingTop: 'env(safe-area-inset-top, 0px)'}}
    >
      <div className="container mx-0 max-w-full flex flex-col flex-grow overflow-hidden px-0.5 md:px-2">
        <Header/>
        <NestedBlockContextProvider
          overrides={{
            layoutBoundary: false,
            renderScopeId: outlineRenderScopeId(block.id),
            scopeRootId: block.id,
          }}
        >
          <BlockComponent blockId={block.id}/>
        </NestedBlockContextProvider>
      </div>
    </div>
  )
}

TopLevelRenderer.canRender = ({context}: BlockRendererProps) => !!(context && context.layoutBoundary && !context.panelId)
TopLevelRenderer.priority = () => 20
