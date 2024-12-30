import {BlockRendererProps} from '../types.ts'
import {useRenderer} from '../context/RendererContext'

type BlockComponentProps = BlockRendererProps

export function BlockComponent({block, onUpdate}: BlockComponentProps) {
    const Renderer = useRenderer(block)

    //todo maybe support 2 modes
    // full replaces - where all the things are handled by renderer
    // or partial, where there some common things the base compenent provides
    // like children, editing mode, the bullet thing in the future etc

    return <Renderer block={block} onUpdate={onUpdate}/>
}

export const BlockChildren = ({block, onUpdate}: BlockComponentProps) => {
    return <>
        {block.children.map((child) => (
            <BlockComponent
                key={child.id}
                block={child}
                onUpdate={(updatedChild) => {
                    onUpdate({
                        ...block,
                        children: block.children.map((c) =>
                            c.id === updatedChild.id ? updatedChild : c,
                        ),
                    })
                }}
            />
        ))}
    </>
}
