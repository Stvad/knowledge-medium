import { Block } from '../data/block'
import { useRenderer } from '../hooks/useRendererRegistry.tsx'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import { useContext } from 'react'
import { BlockContext } from '@/context/block.tsx'

interface BlockComponentProps {
    blockId: string;
}

export function BlockComponent({blockId}: BlockComponentProps) {
    const repo = useRepo()
    const block = new Block(repo, blockId)
    const context = useContext(BlockContext)
    const Renderer = useRenderer({block, context})

    return <Renderer block={block} context={context}/>
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
