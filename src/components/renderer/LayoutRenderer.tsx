import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useIsMobile } from '@/utils/react.tsx'
import { useChildIds } from '@/hooks/block.ts'

export function LayoutRenderer({block}: BlockRendererProps) {
  const isMobile = useIsMobile()
  const panelBlocks = useChildIds(block)
  const panelsToRender = isMobile ? panelBlocks.slice(-1) : panelBlocks

  return <div className="layout flex min-w-0 flex-row flex-grow justify-start overflow-x-auto h-full">
    {panelsToRender.map((panelId) => {
      return <NestedBlockContextProvider
        overrides={{topLevel: true, panelId: panelId, isMainPanel: panelId === panelBlocks[0]}} key={panelId}
      >
        <div className="panel-container h-full w-full min-w-0 max-w-3xl shrink-0 border-l border-border pl-2 first:border-l-0 first:pl-0 only:mx-auto md:min-w-md md:basis-0 md:grow md:shrink">
          <BlockComponent blockId={panelId}/>
        </div>
      </NestedBlockContextProvider>
    })}
  </div>
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) =>
  !!(context && !context.topLevel && !context.panelId)
LayoutRenderer.priority = () => 20
