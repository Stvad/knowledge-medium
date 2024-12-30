import {createContext, useContext} from 'react'
import {Block, RendererRegistry} from '../types'
import {DefaultBlockRenderer} from '../components/DefaultBlockRenderer'
import {RendererBlockRenderer} from '../components/RendererBlockRenderer'

interface RendererContextType {
    registry: RendererRegistry
    refreshRegistry: () => Promise<void>
}

const defaultRegistry: RendererRegistry = {
    default: DefaultBlockRenderer,
    renderer: RendererBlockRenderer,
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
