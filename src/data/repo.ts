import { Repo as AutomergeRepo, isValidAutomergeUrl, DocHandle } from '@automerge/automerge-repo'
import {BrowserWebSocketClientAdapter} from '@automerge/automerge-repo-network-websocket'
import {IndexedDBStorageAdapter} from '@automerge/automerge-repo-storage-indexeddb'
import { Block } from '@/data/block.ts'
import { BlockData } from '@/types.ts'

export const repo = new AutomergeRepo({
    network: [new BrowserWebSocketClientAdapter('wss://sync.automerge.org')],
    storage: new IndexedDBStorageAdapter(),
})

export class Repo {
    constructor(readonly automergeRepo: AutomergeRepo) {}
    find(id: string): Block {
        if (!isValidAutomergeUrl(id)) throw new Error('Invalid block id')

        return new Block(this, this.automergeRepo.find(id))
    }

    create(data: Partial<BlockData>): Block {
        const doc = createBlockDoc(this.automergeRepo, data)
        return new Block(this, doc)
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
