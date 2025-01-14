import {useState, useCallback, useEffect, createContext, useContext} from 'react'
import {BlockData, RendererRegistry} from '../types'
import {wrappedComponentFromModule} from './useDynamicComponent'
import {DefaultBlockRenderer} from '../components/DefaultBlockRenderer'
import {RendererBlockRenderer} from '../components/RendererBlockRenderer.tsx'
import {AutomergeUrl, isValidAutomergeUrl, Repo} from '@automerge/automerge-repo'
import {useRepo} from '@automerge/automerge-repo-react-hooks'
import {getAllChildrenBlocks} from '../utils/block-operations.ts'

interface RendererContextType {
    registry: RendererRegistry
    refreshRegistry: () => Promise<void>
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

export const defaultRegistry: RendererRegistry = {
    default: DefaultBlockRenderer,
    renderer: RendererBlockRenderer,
}

export function useRendererRegistry(rootBlockIds: string[], safeMode?: boolean) {
    const [registry, setRegistry] = useState<RendererRegistry>(defaultRegistry)
    const repo = useRepo()

    const refreshRegistry = useCallback(async () => {
        if (safeMode) {
            console.log('Safe mode enabled - using default registry only')
            return
        }

        console.log('Manually refreshing renderer registry')
        const newRegistry = {...defaultRegistry}

        const rendererBlocks = await Promise.all(
            rootBlockIds.map(url => getRendererBlocks(repo, url))
        ).then(arrays => arrays.flat())

        for (const block of rendererBlocks) {
            try {
                const DynamicComp = await wrappedComponentFromModule(block.content)
                if (DynamicComp) {
                    newRegistry[block.id] = DynamicComp
                    if (block.properties.rendererName) {
                        newRegistry[block.properties.rendererName] = DynamicComp
                    }
                }
            } catch (error) {
                console.error(`Failed to compile renderer ${block.id}:`, error)
            }
        }

        setRegistry(newRegistry)
    }, [rootBlockIds, registry])

    useEffect(() => {
        refreshRegistry()
    }, [])

    return {registry, refreshRegistry}
}

export const RendererContext = createContext<RendererContextType>({
    registry: defaultRegistry,
    refreshRegistry: async () => {
        console.warn('RendererContext not initialized')
    },
})

import { Block } from '../data/block'

export const useRenderer = (block?: Block) => {
    const blockData = block?.use()
    const {registry} = useContext(RendererContext)
    if (!block) return registry.default

    if (blockData?.properties.type === 'renderer') {
        return registry.renderer
    }

    if (blockData?.properties.renderer && registry[blockData.properties.renderer]) {
        return registry[blockData.properties.renderer]
    }

    return registry.default
}
