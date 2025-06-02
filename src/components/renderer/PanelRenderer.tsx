import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { Button } from '@/components/ui/button.tsx'
import { X } from 'lucide-react'
import { topLevelBlockIdProp } from '@/data/properties.ts'
import { useSelectionState } from '@/data/globalState'
import { useRepo } from '@/context/repo'
import { useActionContext } from '@/shortcuts/useActionContext'
import { ActionContextTypes } from '@/shortcuts/types'
import { useMemo } from 'react'
import { usePropertyValue, useContent } from '@/hooks/block.ts'

export function PanelRenderer({block}: BlockRendererProps) {
  const [topLevelBlockId] = usePropertyValue(block, topLevelBlockIdProp)
  const [selectionState] = useSelectionState();
  const blockContent = useContent(block)
  const isMainPanel = blockContent === 'main'

  const repo = useRepo();

  // Memoize dependencies for MULTI_SELECT_MODE
  const multiSelectDeps = useMemo(() => {
    if (!selectionState.selectedBlockIds.length) return null;

    return {
      selectedBlocks: selectionState.selectedBlockIds.map(id => repo.find(id)),
      anchorBlock: selectionState.anchorBlockId ? repo.find(selectionState.anchorBlockId) : null,
      uiStateBlock: block,
    };
  }, [selectionState, block, repo]);

  // Activate MULTI_SELECT_MODE context when there are selected blocks and we're not editing
  useActionContext(
    ActionContextTypes.MULTI_SELECT_MODE,
    multiSelectDeps,
    !!multiSelectDeps
  );

  const handleClose = () => {
    block.delete()
  }

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
        <NestedBlockContextProvider overrides={{topLevel: false}}>
          <BlockComponent blockId={topLevelBlockId}/>
        </NestedBlockContextProvider>
      </div>
    </div>
  )
}

PanelRenderer.canRender = ({context}: BlockRendererProps) => !!(context?.topLevel && context.panelId)
PanelRenderer.priority = () => 5
