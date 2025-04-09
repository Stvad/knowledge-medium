import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useUIStateBlock, getPanelBlocks } from '@/data/globalState.ts'
import { use } from 'react'

const mainPanelId = 'main'

export function LayoutRenderer({block}: BlockRendererProps) {
  const uiBlock = useUIStateBlock()
  // todo refreshing
  const panels = use(
    getPanelBlocks(uiBlock, {name: mainPanelId, topLevelBlockId: block.id}),
  )

  return <div className={'layout flex flex-row flex-grow'}>
    {panels.map((panel) => {
      const blockData = panel.dataSync()! //todo
      if (!blockData) return null
      const panelId = blockData.content
      const topLevelBlockId = blockData.properties.topLevelBlockId as string

      return <NestedBlockContextProvider
        overrides={{topLevel: true, panelId: panelId}} key={panelId}
      >
        <BlockComponent blockId={topLevelBlockId ?? block.id}/>
      </NestedBlockContextProvider>
    })}
  </div>
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) =>
  !!(context && !context.topLevel && !context.panelId)
LayoutRenderer.priority = () => 5
