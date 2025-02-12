import { Repo as AutomergeRepo, isValidAutomergeUrl, DocHandle } from '@automerge/automerge-repo'
import {BrowserWebSocketClientAdapter} from '@automerge/automerge-repo-network-websocket'
import {IndexedDBStorageAdapter} from '@automerge/automerge-repo-storage-indexeddb'
import { Block } from '@/data/block.ts'
import { BlockData } from '@/types.ts'
import { UndoRedoManager } from '@onsetsoftware/automerge-repo-undo-redo'

export const repo = new AutomergeRepo({
    network: [new BrowserWebSocketClientAdapter('wss://sync.automerge.org')],
    storage: new IndexedDBStorageAdapter(),
})

export class Repo {
    // Caching is mainly for reference identity for react
    private blockCache = new Map<string, Block>()

    constructor(
      readonly automergeRepo: AutomergeRepo,
      readonly undoRedoManager: UndoRedoManager
    ) {}

    find(id: string): Block {
        if (!isValidAutomergeUrl(id)) throw new Error('Invalid block id')

        const cachedBlock = this.blockCache.get(id)
        if (cachedBlock) {
            return cachedBlock
        }

        const rawHandle = this.automergeRepo.find<BlockData>(id)
        const existingUndoRedoHandle = this.undoRedoManager.getUndoRedoHandle<BlockData>(rawHandle.documentId)
        const undoRedoHandle = existingUndoRedoHandle || this.undoRedoManager.addHandle(rawHandle)
        
        // Create new block and cache it
        const block = new Block(this, this.undoRedoManager, undoRedoHandle.handle)
        this.blockCache.set(id, block)
        return block
    }

    create(data: Partial<BlockData>): Block {
        // todo it's not really possible to undo block creation atm
        const rawHandle = createBlockDoc(this.automergeRepo, data)
        const undoRedoHandle = this.undoRedoManager.addHandle(rawHandle)
        
        const block = new Block(this, this.undoRedoManager, undoRedoHandle.handle)
        this.blockCache.set(block.id, block)
        return block
    }
}

function createBlockDoc(repo: AutomergeRepo, props: Partial<BlockData>): DocHandle<BlockData> {
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
