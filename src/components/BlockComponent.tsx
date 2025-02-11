import { Block } from '../data/block'
import { useRenderer } from '../hooks/useRendererRegistry.tsx'
import { useBlockContext } from '@/context/block.tsx'
import { useRepo } from '@/context/repo.tsx'

interface BlockComponentProps {
    blockId: string;
}

export function BlockComponent({blockId}: BlockComponentProps) {
    const repo = useRepo()
    const block = repo.find(blockId)
    const context = useBlockContext()
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
