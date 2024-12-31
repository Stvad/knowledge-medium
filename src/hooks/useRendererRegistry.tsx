import {useState, useCallback, useEffect, createContext, useContext} from 'react'
import {Block, RendererRegistry} from '../types'
import {wrappedComponentFromModule} from './useDynamicComponent'
import {DefaultBlockRenderer} from '../components/DefaultBlockRenderer'
import {RendererBlockRenderer} from '../components/RendererBlockRenderer.tsx'

interface RendererContextType {
    registry: RendererRegistry
    refreshRegistry: () => Promise<void>
}

const getRendererBlocks = (blocks: Block[]): Block[] =>
    blocks.flatMap(block =>
        block.properties.type === 'renderer'
            ? [block, ...getRendererBlocks(block.children)]
            : getRendererBlocks(block.children),
    )

export const defaultRegistry: RendererRegistry = {
    default: DefaultBlockRenderer,
    renderer: RendererBlockRenderer,
}

export function useRendererRegistry(blocks: Block[], safeMode?: boolean) {
    const [registry, setRegistry] = useState<RendererRegistry>(defaultRegistry)

    const refreshRegistry = useCallback(async () => {
        if (safeMode) {
            console.log('Safe mode enabled - using default registry only')
            return
        }

        console.log('Manually refreshing renderer registry')
        const newRegistry = {...registry}

        const rendererBlocks = getRendererBlocks(blocks)

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
    }, [blocks, registry])

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

export const useRenderer = (block: Block) => {
    const {registry} = useContext(RendererContext)

    if (block.properties.type === 'renderer') {
        return registry.renderer
    }

    if (block.properties.renderer && registry[block.properties.renderer]) {
        return registry[block.properties.renderer]
    }

    return registry.default
}
