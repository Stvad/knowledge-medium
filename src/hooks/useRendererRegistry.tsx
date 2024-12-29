import {useState, useCallback, useEffect} from 'react'
import {Block, RendererRegistry} from '../types'
import {wrappedComponentFromModule} from './useDynamicComponent'
import {DefaultBlockRenderer} from '../components/DefaultBlockRenderer'
import {RendererBlockRenderer} from '../components/RendererBlockRenderer.tsx'

const getRendererBlocks = (blocks: Block[]): Block[] =>
    blocks.flatMap(block =>
        block.properties.type === 'renderer'
            ? [block, ...getRendererBlocks(block.children)]
            : getRendererBlocks(block.children),
    )

export function useRendererRegistry(blocks: Block[]) {
    const [registry, setRegistry] = useState<RendererRegistry>({
        default: DefaultBlockRenderer,
        renderer: RendererBlockRenderer,
    })

    const refreshRegistry = useCallback(async () => {
        console.log('Manually refreshing renderer registry')
        const newRegistry = {...registry}

        const rendererBlocks = getRendererBlocks(blocks)

        for (const block of rendererBlocks) {
            try {
                const DynamicComp = await wrappedComponentFromModule(block.content)
                if (DynamicComp) {
                    newRegistry[block.id] = DynamicComp
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
