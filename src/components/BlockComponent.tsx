import {BlockRendererProps} from '../types.ts'
import {useState} from 'react'
import {useRenderer} from '../context/RendererContext'
import {DefaultBlockRenderer} from './DefaultBlockRenderer.tsx'

type BlockComponentProps = BlockRendererProps

export function BlockComponent({block, onUpdate}: BlockComponentProps) {
    const [isEditing, setIsEditing] = useState(false)

    const registryRenderer = useRenderer(block)
    const Renderer = isEditing ? DefaultBlockRenderer : registryRenderer

    //todo maybe support 2 modes
    // full replaces - where all the things are handled by renderer
    // or partial, where there some common things the base compenent provides
    // like children, editing mode, the bullet thing in the future etc

    return (
        <div className={`block`}>
            <div className="block-actions">
                <button onClick={() => setIsEditing(!isEditing)}>
                    {isEditing ? 'Done' : 'Edit'}
                </button>
            </div>
            <Renderer block={block} onUpdate={onUpdate}/>
        </div>
    )
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
