import {useState, useEffect} from 'react'
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

    // Find and compile renderer blocks
    useEffect(() => {
        async function updateRegistry() {
            const newRegistry = {...registry}

            const rendererBlocks = getRendererBlocks(blocks)

            for (const block of rendererBlocks) {
                try {
                    const DynamicComp = await wrappedComponentFromModule(block.content);
                    if (DynamicComp) {
                        newRegistry[block.id] = DynamicComp;
                    }
                } catch (error) {
                    console.error(`Failed to compile renderer ${block.id}:`, error)
                }
            }

            setRegistry(newRegistry)
        }

        updateRegistry()
    }, [blocks])

    return registry
}
