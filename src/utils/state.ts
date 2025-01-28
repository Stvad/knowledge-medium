import {BlockData} from '../types.ts'
import {Repo} from '@automerge/automerge-repo'
import {isNotNullish} from './types.ts'
import { Block } from '@/data/block.ts'

export const importState = async (state: { blocks: BlockData[] }, repo: Repo) => {
    const blockMap = new Map<string, Block>()
    
    // First create all blocks
    await Promise.all(state.blocks.map(async block => {
        const newBlock = Block.new(repo, block)
        blockMap.set(block.id, newBlock)
    }))

    // Update ids and references
    for (const block of state.blocks) {
        const blockInstance = blockMap.get(block.id)
        if (!blockInstance) continue

        blockInstance.change((doc: BlockData) => {
            doc.id = blockInstance.id
        })

        // Update parent reference
        if (block.parentId) {
            const parentBlock = blockMap.get(block.parentId)
            if (parentBlock) {
                blockInstance.updateParentId(parentBlock.id)
            }
        }

        // Update child references
        if (block.childIds?.length) {
            const childBlocks = block.childIds
                .map(childId => blockMap.get(childId))
                .filter(isNotNullish)

            blockInstance.change((doc: BlockData) => {
                doc.childIds = childBlocks.map(b => b.id)
            })
        }
    }
    return blockMap
}
