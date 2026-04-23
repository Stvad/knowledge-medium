import { Block } from '@/data/block.ts'
import { blockRenderersFacet, RendererContribution } from '@/extensions/core.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { wrappedComponentFromModule } from '@/hooks/useDynamicComponent.tsx'
import { BlockData, StringBlockProperty } from '@/types.ts'

export const dynamicRenderersExtension = ({
  rootBlock,
  safeMode,
}: {
  rootBlock: Block
  safeMode: boolean
}): AppExtension => async () => {
  if (safeMode) {
    console.log('Safe mode enabled - using default renderer extensions only')
    return []
  }

  const rendererBlocks = await getRendererBlocks(rootBlock)
  const contributions: AppExtension[] = []

  for (const block of rendererBlocks) {
    try {
      const DynamicComp = await wrappedComponentFromModule(block.content)
      if (!DynamicComp) continue

      const rendererNameProp = block.properties.rendererName as StringBlockProperty | undefined
      const rendererContribution: RendererContribution = {
        id: block.id,
        renderer: DynamicComp,
        aliases: rendererNameProp?.value ? [rendererNameProp.value] : undefined,
      }

      contributions.push(blockRenderersFacet.of(rendererContribution, {
        precedence: 100,
        source: block.id,
      }))
    } catch (error) {
      console.error(`Failed to compile renderer ${block.id}:`, error)
    }
  }

  return contributions
}

const getRendererBlocks = async (rootBlock: Block): Promise<BlockData[]> => {
  return rootBlock.repo.findBlocksByTypeInSubtree(rootBlock.id, 'renderer')
}
