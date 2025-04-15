import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useProperty, useData } from '@/data/block.ts'
import { Button } from '@/components/ui/button.tsx'
import { X } from 'lucide-react'

const CONTEXT_OVERRIDE = {topLevel: false}

export function PanelRenderer({block}: BlockRendererProps) {
  const [topLevelBlockId] = useProperty<string>(block, 'topLevelBlockId')

  const handleClose = () => {
    block.delete()
  }

  const blockData = useData(block)
  const isMainPanel = blockData?.content === 'main'

  if (!topLevelBlockId) {
     console.warn(`Panel ${block.id} has no topLevelBlockId, skipping render.`)
     return null
  }

  return (
    <div className="panel max-w-full flex-grow h-full flex flex-col relative overflow-hidden">
      {!isMainPanel && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-1 right-0.5 h-6 w-6 z-10 text-muted-foreground hover:text-foreground"
          onClick={handleClose}
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
      <div className="flex-grow overflow-y-auto scrollbar-none">
        <NestedBlockContextProvider overrides={CONTEXT_OVERRIDE}>
          <BlockComponent blockId={topLevelBlockId}/>
        </NestedBlockContextProvider>
      </div>
    </div>
  )
}

PanelRenderer.canRender = ({context}: BlockRendererProps) => !!(context?.topLevel && context.panelId)
PanelRenderer.priority = () => 5
