import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useUIStateBlock, getPanelsBlock, MAIN_PANEL_NAME } from '@/data/globalState.ts'
import { use, useEffect } from 'react'
import { ChangeScope } from '@/data/api'
import { Block } from '../../data/block'
import { useRepo } from '@/context/repo.tsx'
import { useIsMobile } from '@/utils/react.tsx'
import { memoize } from 'lodash'
import { v5 as uuidv5 } from 'uuid'
import { focusedBlockIdProp, topLevelBlockIdProp } from '@/data/properties.ts'
import { PANEL_TYPE } from '@/data/blockTypes'
import { useChildren } from '@/hooks/block.ts'

// Mirrors UI_CHILD_NS in globalState.ts. Used to derive a deterministic
// child-id for the main panel under panelsBlock so two clients booting
// offline converge on the same panel row.
const UI_CHILD_NS = '8f6c2c84-1c12-4e4a-8b9e-9b0f87a7e1d2'

/** Get-or-create the "main" panel under the panels block. Idempotent
 *  via deterministic id. The panel row carries `types=['panel']` so the
 *  panel renderer picks it up; we set that under UiState scope so the
 *  write doesn't enter the upload queue. */
const ensureMainPanel = async (panelsBlock: Block): Promise<Block> => {
  const id = uuidv5(`${panelsBlock.id}:${MAIN_PANEL_NAME}`, UI_CHILD_NS)
  const repo = panelsBlock.repo
  const live = await repo.load(id)
  if (live && !live.deleted) return repo.block(id)

  const parentData = panelsBlock.peek() ?? await panelsBlock.load()
  if (!parentData) throw new Error(`ensureMainPanel: panelsBlock ${panelsBlock.id} not loaded`)

  await repo.tx(async tx => {
    const existing = await tx.get(id)
    if (existing && !existing.deleted) return
    if (existing && existing.deleted) {
      await tx.restore(id, {content: MAIN_PANEL_NAME})
      return
    }
    await tx.create({
      id,
      workspaceId: parentData.workspaceId,
      parentId: panelsBlock.id,
      orderKey: 'a0',
      content: MAIN_PANEL_NAME,
    })
  }, {scope: ChangeScope.UiState})
  return repo.block(id)
}

const getMainPanelBlock = memoize(
  ensureMainPanel,
  (panelsBlock) => `${panelsBlock.repo.instanceId}:${panelsBlock.id}`,
)

export function LayoutRenderer({block}: BlockRendererProps) {
  const uiBlock = useUIStateBlock()
  const panelBlock = use(getPanelsBlock(uiBlock))
  const mainPanelBlock = use(getMainPanelBlock(panelBlock))
  const repo = useRepo()
  const isMobile = useIsMobile()

  useEffect(() => {
    // Stamp `types=['panel']`, `topLevelBlockId=block.id`, and
    // `focusedBlockId=block.id` on the main panel block so the panel
    // renderer recognizes it and keyboard navigation has a panel-local
    // focus target after URL navigation. These writes go
    // through a UiState-scoped tx. The panel-infrastructure write is
    // engine-routing-only and shouldn't reach the upload queue.
    // Routing through `repo.tx` directly (vs `block.set`) lets us
    // override scope while still using the schema's codec.
    void repo.tx(async tx => {
      await repo.addTypeInTx(tx, mainPanelBlock.id, PANEL_TYPE)
      await tx.setProperty(mainPanelBlock.id, topLevelBlockIdProp, block.id)
      await tx.setProperty(mainPanelBlock.id, focusedBlockIdProp, block.id)
    }, {scope: ChangeScope.UiState, description: 'init main panel'})
  }, [block.id, mainPanelBlock, repo])

  useEffect(() => {
    const handleOpenPanel = async (event: CustomEvent<{ blockId: string, sourcePanelId?: string }>) => {
      const {blockId: blockToOpenId, sourcePanelId} = event.detail

      const panelsData = panelBlock.peek() ?? await panelBlock.load()
      if (!panelsData) return

      // Deterministic id derived from the block being opened so
      // re-opening the same block reuses an existing panel slot.
      const panelId = uuidv5(`${panelBlock.id}:${blockToOpenId}`, UI_CHILD_NS)

      // Position: create after the source panel. Use the source
      // panel's order_key as a base + a tilde discriminator so the
      // new panel sorts immediately after.
      let orderKey = `a${Date.now()}`
      if (sourcePanelId) {
        const sourceData = repo.cache.getSnapshot(sourcePanelId) ?? await repo.load(sourcePanelId)
        if (sourceData) orderKey = `${sourceData.orderKey}~${Date.now()}`
      }

      await repo.tx(async tx => {
        const existing = await tx.get(panelId)
        if (existing && !existing.deleted) {
          // Existing panel — re-stamp both the displayed block and
          // panel-local focus so navigation keys are immediately active.
          await tx.setProperty(panelId, topLevelBlockIdProp, blockToOpenId)
          await tx.setProperty(panelId, focusedBlockIdProp, blockToOpenId)
          return
        }
        if (existing && existing.deleted) {
          await tx.restore(panelId, {content: blockToOpenId})
        } else {
          await tx.create({
            id: panelId,
            workspaceId: panelsData.workspaceId,
            parentId: panelBlock.id,
            orderKey,
            content: blockToOpenId,
          })
        }
        await repo.addTypeInTx(tx, panelId, PANEL_TYPE)
        await tx.setProperty(panelId, topLevelBlockIdProp, blockToOpenId)
        await tx.setProperty(panelId, focusedBlockIdProp, blockToOpenId)
      }, {scope: ChangeScope.UiState, description: 'open panel'})
    }

    window.addEventListener('open-panel', handleOpenPanel as unknown as EventListener)

    return () => {
      window.removeEventListener('open-panel', handleOpenPanel as unknown as EventListener)
    }
  }, [panelBlock, repo])

  const panelBlocks = useChildren(panelBlock)
  // todo actual mobile support/separate renderer
  const panelsToRender = isMobile ? [mainPanelBlock] : panelBlocks

  return <div className="layout flex min-w-0 flex-row flex-grow justify-start overflow-x-auto h-full">
    {panelsToRender.map((panel) => {
      return <NestedBlockContextProvider
        overrides={{topLevel: true, panelId: panel.id}} key={panel.id}
      >
        <div className="panel-container h-full w-full min-w-0 max-w-3xl shrink-0 border-l border-border pl-2 first:border-l-0 first:pl-0 only:mx-auto md:min-w-md md:basis-0 md:grow md:shrink">
          <BlockComponent blockId={panel.id}/>
        </div>
      </NestedBlockContextProvider>
    })}
  </div>
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) =>
  !!(context && !context.topLevel && !context.panelId)
LayoutRenderer.priority = () => 20
