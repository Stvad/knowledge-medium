import {createContext, useContext} from 'react'
import {Block, RendererRegistry} from '../types'
import {defaultRegistry} from '../hooks/useRendererRegistry.tsx'

interface RendererContextType {
    registry: RendererRegistry
    refreshRegistry: () => Promise<void>
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
