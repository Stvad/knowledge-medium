import { Block } from '../data/block'
import { useRenderer } from '../hooks/useRendererRegistry.tsx'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import { BlockContext } from '@/types.ts'

interface BlockComponentProps {
    blockId: string;
    context?: BlockContext;
}

export function BlockComponent({blockId, context}: BlockComponentProps) {
    const repo = useRepo()
    const block = new Block(repo, blockId)
    const blockData = block.use()
    const Renderer = useRenderer({block, context})

    if (!blockData) {
        return <div>Loading block...</div>
    }

    return <Renderer block={block} context={context}/>
}

//todo propagate context to children
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
