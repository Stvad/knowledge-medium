import {BlockData} from '../types.ts'
import {Repo, DocHandle} from '@automerge/automerge-repo'
import {createBlockDoc} from './block-operations.ts'
import {isNotNullish} from './types.ts'

export const importState = async (state: { blocks: BlockData[] }, repo: Repo) => {
    const blockDocsMap = new Map<string, DocHandle<BlockData>>()
    await Promise.all(state.blocks.map(async block => {
        const doc = createBlockDoc(repo, block)
        blockDocsMap.set(block.id, doc)
    }))

    // Update ids
    for (const block of state.blocks) {
        const blockDoc = blockDocsMap.get(block.id)
        if (!blockDoc) continue

        blockDoc.change((doc: BlockData) => {
            doc.id = blockDoc.url
        })

        // Update parent reference
        if (block.parentId) {
            const parentDoc = blockDocsMap.get(block.parentId)
            if (parentDoc) {
                blockDoc.change((doc: BlockData) => {
                    doc.parentId = parentDoc.url
                })
            }
        }

        // Update child references
        if (block.childIds?.length) {
            const childDocs = block.childIds
                .map(childId => blockDocsMap.get(childId))
                .filter(isNotNullish)

            blockDoc.change((doc: BlockData) => {
                doc.childIds = childDocs.map(d => d.url)
            })
        }
    }
    return blockDocsMap
}
