import { Repo as AutomergeRepo } from '@automerge/automerge-repo'
import { BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'
import { UndoRedoManager } from '@onsetsoftware/automerge-repo-undo-redo'
import { ConvexReactClient } from 'convex/react'
import { sync } from '@/convex/sync.ts'

export const automergeRepo = new AutomergeRepo({
  // network: [new BrowserWebSocketClientAdapter('wss://sync.automerge.org')],
  storage: new IndexedDBStorageAdapter(),
})

const convex = new ConvexReactClient("https://dazzling-cobra-717.convex.cloud");

sync(automergeRepo, convex);


export const undoRedoManager = new UndoRedoManager()
