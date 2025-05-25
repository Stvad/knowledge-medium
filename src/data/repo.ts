import { Repo as AutomergeRepo, isValidAutomergeUrl, DocHandle } from '@automerge/automerge-repo'
import { Block } from '@/data/block'
import { BlockData, User } from '@/types'
import { UndoRedoManager } from '@onsetsoftware/automerge-repo-undo-redo'

export class Repo {
  // Caching is mainly for reference identity for react
  private blockCache = new Map<string, Block>()

  constructor(
    readonly automergeRepo: AutomergeRepo,
    readonly undoRedoManager: UndoRedoManager,
    readonly currentUser: User,
  ) {
  }

  find(id: string): Block {
    if (!isValidAutomergeUrl(id)) throw new Error('Invalid block id')

    const cachedBlock = this.blockCache.get(id)
    if (cachedBlock) {
      return cachedBlock
    }

    const rawHandle = this.automergeRepo.find<BlockData>(id)
    const existingUndoRedoHandle = this.undoRedoManager.getUndoRedoHandle<BlockData>(rawHandle.documentId)
    // todo
    // @ts-expect-error Local package dependency version mismatch
    const undoRedoHandle = existingUndoRedoHandle || this.undoRedoManager.addHandle(rawHandle)
    // this.setupHooks(undoRedoHandle)

    // @ts-expect-error Local package dependency version mismatch
    const block = new Block(this, this.undoRedoManager, undoRedoHandle.handle, this.currentUser)
    this.blockCache.set(id, block)
    return block
  }

  create(data: Partial<BlockData>): Block {
    // todo it's not really possible to undo block creation atm
    const rawHandle = this.createAutomergeDoc(data)
    // @ts-expect-error Local package dependency version mismatch
    const undoRedoHandle = this.undoRedoManager.addHandle<BlockData>(rawHandle)
    // this.setupHooks(undoRedoHandle)

    // @ts-expect-error Local package dependency version mismatch
    const block = new Block(this, this.undoRedoManager, undoRedoHandle.handle, this.currentUser)
    this.blockCache.set(block.id, block)
    return block
  }

  // private setupHooks(_: AutomergeRepoUndoRedo<BlockData>) {
  // Todo: https://github.com/onsetsoftware/automerge-repo-undo-redo/issues/5
  //   actually making changes here even on fields that are unrelated to each other makes the undo/redo go haywire
  //   So leaving this here as a reminder not to do this and handle things on Block class instead
  // }

  private createAutomergeDoc(props: Partial<BlockData>): DocHandle<BlockData> {
    const handle = this.automergeRepo.create<BlockData>()
    const url = handle.url

    handle.change(doc => {
      doc.id = url
      doc.content = props.content ?? ''
      doc.properties = props.properties || {}
      doc.childIds = props.childIds || []

      const createTime = Date.now()
      doc.createTime = props.createTime || createTime
      doc.updateTime = props.updateTime || createTime

      doc.createdByUserId = props.createdByUserId || this.currentUser.id
      doc.updatedByUserId = props.updatedByUserId || this.currentUser.id

      if (props.parentId) {
        doc.parentId = props.parentId
      }
    })

    return handle
  }
}

