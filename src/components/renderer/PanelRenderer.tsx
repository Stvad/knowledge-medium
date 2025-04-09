import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useUIStateProperty } from '@/data/globalState.ts'

/**
 * This is like this to avoid re-rending on context changing bc of new object creation
 * Plausibly over-optimizing, but wanted to keep an example/reminder on this.
 */
const CONTEXT_OVERRIDE = {topLevel: false}

export function PanelRenderer({block}: BlockRendererProps) {
  const [topLevelBlockId,] = useUIStateProperty<string>('topLevelBlockId')


  return (
    <NestedBlockContextProvider overrides={CONTEXT_OVERRIDE}>
      <div className="panel max-w-full flex-grow">
        <BlockComponent blockId={topLevelBlockId ?? block.id}/>
      </div>
    </NestedBlockContextProvider>
  )
}

PanelRenderer.canRender = ({context}: BlockRendererProps) => !!(context?.topLevel && context.panelId)
PanelRenderer.priority = () => 5
