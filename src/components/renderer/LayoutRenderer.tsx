import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useUIStateBlock, getPanelsBlock } from '@/data/globalState.ts'
import { use, useEffect } from 'react'
import { useChildren } from '@/data/block.ts'

const mainPanelId = 'main'

export function LayoutRenderer({block}: BlockRendererProps) {
  const uiBlock = useUIStateBlock()
  const panelBlock = use(getPanelsBlock(uiBlock))

  useEffect(() => {
    (async () => {
      /** todo this is a clutch rn, the overall navigation story is under-baked
       * it's plausible to me that each panel should have it's own navigation stack
       *
       * having an "open in main panel" action is useful though
       *
       * though for page URL to stay meaningful,
       * we probably want some sort of story where changing it navigates "main" panel
       */
      const mainPanelBlock = await panelBlock.childByContent([mainPanelId], true)
      mainPanelBlock.setProperty('topLevelBlockId', block.id)

    })()
  }, [block.id])

  const panelBlocks = useChildren(panelBlock)

  return <div className={'layout flex flex-row flex-grow'}>
    {panelBlocks.map((panel) => {

      return <NestedBlockContextProvider
        overrides={{topLevel: true, panelId: panel.id}} key={panel.id}
      >
        <BlockComponent blockId={panel.id}/>
      </NestedBlockContextProvider>
    })}
  </div>
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) =>
  !!(context && !context.topLevel && !context.panelId)
LayoutRenderer.priority = () => 5
