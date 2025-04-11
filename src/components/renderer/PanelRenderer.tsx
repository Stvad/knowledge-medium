import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useProperty } from '@/data/block.ts'

/**
 * This is like this to avoid re-rending on context changing bc of new object creation
 * Plausibly over-optimizing, but wanted to keep an example/reminder on this.
 */
const CONTEXT_OVERRIDE = {topLevel: false}

export function PanelRenderer({block}: BlockRendererProps) {
  const [topLevelBlockId] = useProperty<string>(block, 'topLevelBlockId')

  return (
    <div className="panel max-w-full flex-grow">
      <NestedBlockContextProvider overrides={CONTEXT_OVERRIDE}>
        <BlockComponent blockId={topLevelBlockId || block.id}/>
      </NestedBlockContextProvider>
    </div>
  )
}

PanelRenderer.canRender = ({context}: BlockRendererProps) => !!(context?.topLevel && context.panelId)
PanelRenderer.priority = () => 5
