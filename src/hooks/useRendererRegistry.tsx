import { useState, useEffect } from 'react'
import { BlockData, RendererRegistry, BlockRendererProps } from '../types'
import { wrappedComponentFromModule } from './useDynamicComponent'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { RendererBlockRenderer } from '@/components/renderer/RendererBlockRenderer.tsx'
import { AutomergeUrl, isValidAutomergeUrl, Repo } from '@automerge/automerge-repo'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import { LayoutRenderer } from '@/components/renderer/LayoutRenderer.tsx'
import { getAllChildrenBlocks } from '@/data/block.ts'
import { MissingDataRenderer } from '@/components/renderer/MissingDataRenderer'

export const defaultRegistry: RendererRegistry = {
  default: DefaultBlockRenderer,
  renderer: RendererBlockRenderer,
  layout: LayoutRenderer,
  missingData: MissingDataRenderer,
}

export const useRenderer = ({block, context}: BlockRendererProps) => {
  const blockData = block?.use()
  const [registry, setRegistry] = useState<RendererRegistry>(defaultRegistry)
  const repo = useRepo()
  // todo this should just have a cache of the renderers, initialized on first use
  // plausibly writen to a value within a system
  useEffect(() => {
    loadRegistry(repo, block.id, context?.safeMode!!).then(setRegistry)
  }, [])

  if (blockData?.properties.renderer && registry[blockData.properties.renderer]) {
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

const loadRegistry = async (repo: Repo, blockId: string, safeMode: boolean): Promise<RendererRegistry> => {
  if (safeMode) {
    console.log('Safe mode enabled - using default registry only')
    return defaultRegistry
  }

  console.log('Manually refreshing renderer registry')
  const newRegistry = {...defaultRegistry}

  const rendererBlocks = await getRendererBlocks(repo, blockId)
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
}

const getRendererBlocks = async (repo: Repo, blockId: string): Promise<BlockData[]> => {
  if (!isValidAutomergeUrl(blockId)) return []

  const getTopmostParent = async (blockId: AutomergeUrl): Promise<BlockData | undefined> => {
    const block = await repo.find<BlockData>(blockId).doc()
    if (!block?.parentId) return block
    return getTopmostParent(block.parentId as AutomergeUrl)
  }
  const parentBlock = await getTopmostParent(blockId as AutomergeUrl)

  const topmostId = parentBlock?.id || blockId
  const allBlocks = await getAllChildrenBlocks(repo, topmostId)
  return allBlocks.filter(block => block.properties.type === 'renderer')
}
