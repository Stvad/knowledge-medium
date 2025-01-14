import {BlockData} from '../types'
import {Repo, DocHandle, isValidAutomergeUrl, AutomergeUrl} from '@automerge/automerge-repo'

export function createBlockDoc(repo: Repo, props: Partial<BlockData>): DocHandle<BlockData> {
    const handle = repo.create<BlockData>()
    const url = handle.url
    
    handle.change(doc => {
        doc.id = url
        doc.content = props.content || ''
        doc.properties = props.properties || {}
        doc.childIds = props.childIds || []
        if (props.parentId) {
            doc.parentId = props.parentId
        }
    })
    
    return handle
}

export function addChildBlock(repo: Repo, parentId: AutomergeUrl, childId: AutomergeUrl) {
    const parentHandle = repo.find<BlockData>(parentId)
    
    parentHandle.change(doc => {
        doc.childIds.push(childId)
    })
    
    const childHandle = repo.find<BlockData>(childId)
    childHandle.change(doc => {
        doc.parentId = parentId
    })
}

export function removeChildBlock(repo: Repo, parentId: AutomergeUrl, childId: AutomergeUrl) {
    const parentHandle = repo.find<BlockData>(parentId)
    
    parentHandle.change(doc => {
        doc.childIds = doc.childIds.filter(id => id !== childId)
    })
    
    const childHandle = repo.find<BlockData>(childId)
    childHandle.change(doc => {
        doc.parentId = undefined
    })
}

export function moveBlock(
    repo: Repo, 
    blockUrl: AutomergeUrl,
    fromParentUrl: AutomergeUrl | undefined,
    toParentUrl: AutomergeUrl | undefined
) {
    if (fromParentUrl) {
        removeChildBlock(repo, fromParentUrl, blockUrl)
    }
    
    if (toParentUrl) {
        addChildBlock(repo, toParentUrl, blockUrl)
    }
}

export const getAllChildrenBlocks = async (repo: Repo, blockId: string): Promise<BlockData[]> => {
    if (!isValidAutomergeUrl(blockId)) return []

    const blockDoc = repo.find<BlockData>(blockId)
    const exportBlock = await blockDoc?.doc()
    if (!exportBlock) return []

    const childBlocks = await Promise.all(
        (exportBlock.childIds || []).map(id => getAllChildrenBlocks(repo, id)),
    )

    return [exportBlock, ...childBlocks.flat()]
}
