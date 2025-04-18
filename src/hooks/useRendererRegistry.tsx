import { useState, useEffect } from 'react'
import { BlockData, RendererRegistry, BlockRendererProps } from '../types'
import { wrappedComponentFromModule } from './useDynamicComponent'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { RendererBlockRenderer } from '@/components/renderer/RendererBlockRenderer.tsx'
import { TopLevelRenderer } from '@/components/renderer/TopLevelRenderer.tsx'
import { MissingDataRenderer } from '@/components/renderer/MissingDataRenderer'
import { useRepo } from '@/context/repo.tsx'
import { getAllChildrenBlocks, Block, useData } from '@/data/block.ts'
import { useBlockContext } from '@/context/block.tsx'
import { memoize } from 'lodash'
import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.tsx'
import { PanelRenderer } from '@/components/renderer/PanelRenderer.tsx'

export const defaultRegistry: RendererRegistry = {
  default: DefaultBlockRenderer,
  renderer: RendererBlockRenderer,
  topLevel: TopLevelRenderer,
  layout: LayoutRenderer,
  panel: PanelRenderer,
  missingData: MissingDataRenderer,
}

export const refreshRendererRegistry = async () => {
  const event = new CustomEvent('renderer-registry-update', {
    detail: new Date().toISOString(),
  })
  window.dispatchEvent(event)
}

export const useRenderer = ({block, context}: BlockRendererProps) => {
  const blockData = useData(block)
  const [registry, setRegistry] = useState<RendererRegistry>(defaultRegistry)
  const repo = useRepo()
  const {rootBlockId} = useBlockContext()
  const [generation, setGeneration] = useState('initial-load')

  useEffect(() => {
    (async () => {
      setRegistry(await loadRegistry(repo.find(rootBlockId!), context?.safeMode ?? false, generation))
    })()
  }, [generation, rootBlockId, context?.safeMode])

  useEffect(() => {
    const reloadRegistry = (e: CustomEvent<string>) => {
      setGeneration(e.detail)
    }

    window.addEventListener('renderer-registry-update', reloadRegistry as EventListener)
    return () => window.removeEventListener('renderer-registry-update', reloadRegistry as EventListener)
  }, [])

  if (blockData?.properties?.renderer && registry[blockData.properties.renderer]) {
    return registry[blockData.properties.renderer]
  }

  /**
   * todo, caching of renderer for each block?
   * maybe do per/type?
   * also allowing people to switch between renderers would be good
   */

  const possibleRenderers = Object.values(registry)
    .filter(renderer => renderer.canRender?.({block, context}))

  const firstPriority = possibleRenderers.sort((a, b) =>
    (b.priority?.({block, context}) || 0) - (a.priority?.({block, context}) || 0))[0]

  return firstPriority ?? registry.default
}

const loadRegistry = memoize(async (rootBlock: Block, safeMode: boolean, generation: string): Promise<RendererRegistry> => {
  if (safeMode) {
    console.log('Safe mode enabled - using default registry only')
    return defaultRegistry
  }

  console.log(`Refreshing renderer registry`, {rootBlock, safeMode, generation})
  const newRegistry = {...defaultRegistry}

  const rendererBlocks = await getRendererBlocks(rootBlock)
  for (const block of rendererBlocks) {
    try {
      const DynamicComp = await wrappedComponentFromModule(block.content)
      if (DynamicComp) {
        newRegistry[block.id] = DynamicComp
        if (block.properties.rendererName) {
          //todo
          newRegistry[block.properties.rendererName as string] = DynamicComp
        }
      }
    } catch (error) {
      console.error(`Failed to compile renderer ${block.id}:`, error)
    }
  }
  return newRegistry
}, (rootBlock, safeMode, generation) => rootBlock.id + safeMode + generation)

const getRendererBlocks = async (rootBlock: Block): Promise<BlockData[]> => {
  const childrenBlocks = await getAllChildrenBlocks(rootBlock)
  const blockData = await Promise.all(childrenBlocks.map(b => b.data() as Promise<BlockData>))

  return blockData.filter(block => block.properties.type === 'renderer')
}
