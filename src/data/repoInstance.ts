import { Repo as AutomergeRepo } from '@automerge/automerge-repo'
import { BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { UndoRedoManager } from '../../../automerge-repo-undo-redo'
import { Repo } from '@/data/repo.ts'

export const automergeRepo = new AutomergeRepo({
  network: [new BrowserWebSocketClientAdapter('wss://sync.automerge.org')],
  storage: new IndexedDBStorageAdapter(),
})

export const undoRedoManager = new UndoRedoManager()
export const repo = new Repo(automergeRepo, undoRedoManager)

