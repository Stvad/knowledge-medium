import {useState, useCallback, useEffect, createContext, useContext} from 'react'
import {Block, RendererRegistry} from '../types'
import {wrappedComponentFromModule} from './useDynamicComponent'
import {DefaultBlockRenderer} from '../components/DefaultBlockRenderer'
import {RendererBlockRenderer} from '../components/RendererBlockRenderer.tsx'
import {Repo} from '@automerge/automerge-repo'
import {useRepo} from '@automerge/automerge-repo-react-hooks'
import {getAllChildrenBlocks} from '../utils/block-operations.ts'

interface RendererContextType {
    registry: RendererRegistry
    refreshRegistry: () => Promise<void>
}

const getRendererBlocks = async (repo: Repo, blockId: string): Promise<Block[]> => {
    const allBlocks = await getAllChildrenBlocks(repo, blockId)
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

export const useRenderer = (block?: Block) => {
    const {registry} = useContext(RendererContext)
    if (!block) return registry.default

    if (block.properties.type === 'renderer') {
        return registry.renderer
    }

    if (block.properties.renderer && registry[block.properties.renderer]) {
        return registry[block.properties.renderer]
    }

    return registry.default
}
