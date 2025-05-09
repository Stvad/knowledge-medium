import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useUIStateBlock, getPanelsBlock } from '@/data/globalState.ts'
import { use, useEffect } from 'react'
import { useChildren, Block } from '@/data/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useIsMobile } from '@/utils/react.tsx'
import { memoize } from 'lodash'
import { topLevelBlockIdProp, typeProp, fromList } from '@/data/properties.ts'

const mainPanelName = 'main'

const getMainPanelBlock = memoize(
  (panelsBlock: Block) => panelsBlock.childByContent(mainPanelName, true),
  (panelsBlock) => panelsBlock.id
)

export function LayoutRenderer({block}: BlockRendererProps) {
  const uiBlock = useUIStateBlock()
  const panelBlock = use(getPanelsBlock(uiBlock))
  const mainPanelBlock = use(getMainPanelBlock(panelBlock))
  const repo = useRepo()
  const isMobile = useIsMobile()

  useEffect(() => {
    /** todo this is a clutch rn, the overall navigation story is under-baked
     * it's plausible to me that each panel should have it's own navigation stack
     *
     * having an "open in main panel" action is useful though
     *
     * though for page URL to stay meaningful,
     * we probably want some sort of story where changing it navigates "main" panel
     */
    mainPanelBlock.setProperty({...typeProp, value: 'panel'})
    mainPanelBlock.setProperty({...topLevelBlockIdProp, value: block.id})
      // todo a more ergonomic way to do the init?
  }, [block.id, mainPanelBlock])

  useEffect(() => {
    const handleOpenPanel = async (event: CustomEvent<{ blockId: string, sourcePanelId?: string }>) => {
      const {blockId: blockToOpenId} = event.detail

      const panels = await panelBlock.children()
      const afterPanelIdx = panels.findIndex((panel) => panel.id === event.detail.sourcePanelId)

      await panelBlock.createChild({
        data: {
          content: blockToOpenId,
          properties: fromList(
            {...typeProp, value: 'panel'},
            {...topLevelBlockIdProp, value: blockToOpenId},
          )
        },
        position: afterPanelIdx === -1 ? 'last' : afterPanelIdx + 1,
      })
    }

    window.addEventListener('open-panel', handleOpenPanel as unknown as EventListener)

    return () => {
      window.removeEventListener('open-panel', handleOpenPanel as unknown as EventListener)
    }
  }, [panelBlock, repo])

  const panelBlocks = useChildren(panelBlock)
  // todo actual mobile support/separate renderer
  const panelsToRender = isMobile ? [mainPanelBlock] : panelBlocks

  return <div className={'layout flex flex-row flex-grow overflow-x-auto justify-center h-full'}>
    {panelsToRender.map((panel) => {
      return <NestedBlockContextProvider
        overrides={{topLevel: true, panelId: panel.id}} key={panel.id}
      >
        <div className="panel-container border-l border-border flex-grow basis-0 min-w-md max-w-3xl pl-2 first:border-l-0 first:pl-0 h-full ">
          <BlockComponent blockId={panel.id}/>
        </div>
      </NestedBlockContextProvider>
    })}
  </div>
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) =>
  !!(context && !context.topLevel && !context.panelId)
LayoutRenderer.priority = () => 5
