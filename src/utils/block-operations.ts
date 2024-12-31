import {Block} from '../types'
import {v4 as uuidv4} from 'uuid'

export function removeBlock(blocks: Block[], idToRemove: string): Block[] {
    return blocks.filter(block => block.id !== idToRemove)
        .map(block => ({
            ...block,
            children: removeBlock(block.children, idToRemove)
        }));
}

export function findParentBlock(blocks: Block[], childId: string): Block | null {
    for (const block of blocks) {
        if (block.children.some(child => child.id === childId)) {
            return block;
        }
        const parent = findParentBlock(block.children, childId);
        if (parent) {
            return parent;
        }
    }
    return null;
}

export function moveBlock(blocks: Block[], blockId: string, direction: 'indent' | 'unindent'): Block[] {
    if (direction === 'indent') {
        return blocks.map(block => {
            const blockIndex = block.children.findIndex(child => child.id === blockId);
            if (blockIndex > 0) {
                // Move the block to the previous sibling's children
                const prevSibling = block.children[blockIndex - 1];
                const currentBlock = block.children[blockIndex];
                return {
                    ...block,
                    children: [
                        ...block.children.slice(0, blockIndex - 1),
                        {
                            ...prevSibling,
                            children: [...prevSibling.children, currentBlock]
                        },
                        ...block.children.slice(blockIndex + 1)
                    ]
                };
            }
            return {
                ...block,
                children: block.children.map(child => ({
                    ...child,
                    children: moveBlock(child.children, blockId, direction)
                }))
            };
        });
    } else {
        // Unindent: Move the block to its parent's siblings
        const parent = findParentBlock(blocks, blockId);
        if (!parent) return blocks;

        const blockToMove = parent.children.find(child => child.id === blockId)!;
        const parentParent = findParentBlock(blocks, parent.id);
        
        if (!parentParent) {
            // Move to root level
            return [...blocks.filter(b => b.id !== blockId), blockToMove];
        }

        const parentIndex = parentParent.children.findIndex(child => child.id === parent.id);
        return blocks.map(block => {
            if (block.id === parentParent.id) {
                return {
                    ...block,
                    children: [
                        ...block.children.slice(0, parentIndex + 1),
                        blockToMove,
                        ...block.children.slice(parentIndex + 1)
                    ]
                };
            }
            return {
                ...block,
                children: block.children.map(child => ({
                    ...child,
                    children: removeBlock(child.children, blockId)
                }))
            };
        });
    }
}

export const emptyBlock = () => createBlock()

export const createBlock = (overrides?: Partial<Block>) => ({
    id: uuidv4(),
    content: '',
    properties: {},
    children: [],
    ...overrides,
})
