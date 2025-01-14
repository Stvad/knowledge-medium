import {Block} from '../data/block'
import {useRenderer} from '../hooks/useRendererRegistry.tsx'
import {useRepo} from '@automerge/automerge-repo-react-hooks'

interface BlockComponentProps {
    blockId: string;
}

export function BlockComponent({blockId}: BlockComponentProps) {
    const repo = useRepo()
    const block = new Block(repo, blockId)
    const blockData = block.use()
    const Renderer = useRenderer(block)
    
    if (!blockData) {
        return <div>Loading block...</div>
    }

    return <Renderer block={block}/>
}

export const BlockChildren = ({block}: { block: Block }) => {
    return <>
        {block.use()?.childIds.map((childId) => (
            <BlockComponent
                key={childId}
                blockId={childId}
            />
        ))}
    </>
}
