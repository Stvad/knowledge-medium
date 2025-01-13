import {Block} from '../types.ts'
import {useRenderer} from '../hooks/useRendererRegistry.tsx'
import {useDocument} from '@automerge/automerge-repo-react-hooks'
import {AutomergeUrl} from '@automerge/automerge-repo'

interface BlockComponentProps {
    blockId: string;
}

export function BlockComponent({blockId}: BlockComponentProps) {
    const [block, changeBlock] = useDocument<Block>(blockId as AutomergeUrl)
    const Renderer = useRenderer(block)
    
    if (!block) {
        return <div>Loading block...</div>
    }
    //todo maybe support 2 modes
    // full replaces - where all the things are handled by renderer
    // or partial, where there some common things the base compenent provides
    // like children, editing mode, the bullet thing in the future etc

    return <Renderer block={block} changeBlock={changeBlock}/>
}

export const BlockChildren = ({block}: { block: Block }) => {
    return <>
        {block.childIds.map((childUrl) => (
            <BlockComponent
                key={childUrl}
                blockId={childUrl}
            />
        ))}
    </>
}
