import {Block} from '../types.ts'
import {Repo, DocHandle} from '@automerge/automerge-repo'
import {createBlockDoc} from './block-operations.ts'

export const importState = async (state: { blocks: Block[] }, repo: Repo) => {
    const blockDocsMap = new Map<string, DocHandle<Block>>()
    await Promise.all(state.blocks.map(async block => {
        const doc = await createBlockDoc(repo, block)
        blockDocsMap.set(block.id, doc)
    }))

    // Update ids
    for (const block of state.blocks) {
        const blockDoc = blockDocsMap.get(block.id)
        if (!blockDoc) continue

        blockDoc.change((doc: Block) => {
            doc.id = blockDoc.url
        })

        // Update parent reference
        if (block.parentId) {
            const parentDoc = blockDocsMap.get(block.parentId)
            if (parentDoc) {
                blockDoc.change((doc: Block) => {
                    doc.parentId = parentDoc.url
                })
            }
        }

        // Update child references
        if (block.childIds?.length) {
            const childDocs = block.childIds
                .map(childId => blockDocsMap.get(childId))
                .filter(Boolean)

            blockDoc.change((doc: Block) => {
                doc.childIds = childDocs.map(d => d.url)
            })
        }
    }
    return blockDocsMap
}
