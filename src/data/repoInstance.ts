import { Repo as AutomergeRepo } from '@automerge/automerge-repo'
import { BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { UndoRedoManager } from '@onsetsoftware/automerge-repo-undo-redo'

export const automergeRepo = new AutomergeRepo({
  network: [new BrowserWebSocketClientAdapter('wss://sync.automerge.org')],
  storage: new IndexedDBStorageAdapter(),
})

export const undoRedoManager = new UndoRedoManager()
