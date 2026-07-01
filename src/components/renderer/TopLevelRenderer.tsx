import { Header } from '@/components/Header.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { BlockRendererProps } from '@/types.js'
import { NestedBlockContextProvider } from '@/context/block.js'
import { useActionContext } from '@/shortcuts/useActionContext.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import { outlineRenderScopeId } from '@/utils/renderScope.js'

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

  return (
    // paddingTop reserves the iOS status-bar strip. As an installed PWA we run
    // `apple-mobile-web-app-status-bar-style=black-translucent` + `viewport-fit=cover`
    // (index.html), so iOS draws content full-screen BEHIND the translucent status
    // bar; without this inset the Header sits under the clock/battery (visible on
    // iPad). It's on the `bg-background` frame so the themed background still flows
    // edge-to-edge behind the status bar (the immersive look black-translucent buys),
    // with only the content pushed down. `env(safe-area-inset-top)` is 0 in a normal
    // browser tab, so this is inert outside the installed PWA. Bottom/side insets are
    // handled per-surface (bottom nav, sidebar, panel scroller) — not here — to avoid
    // double-insetting.
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
