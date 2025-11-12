import { Repo as AutomergeRepo, isValidAutomergeUrl, DocHandle } from '@automerge/automerge-repo'
import { Block } from '@/data/block'
import { BlockData, User } from '@/types'
import { UndoRedoManager } from '@onsetsoftware/automerge-repo-undo-redo'
import { USE_POWERSYNC } from './dataSource'
import { powerSyncDb } from './powerSyncInstance'
import { v4 as uuid } from 'uuid'
import { generateFirstOrderKey } from '@/utils/orderKey'

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
    const cachedBlock = this.blockCache.get(id)
    if (cachedBlock) {
      return cachedBlock
    }

    if (USE_POWERSYNC) {
      // In PowerSync mode, we just need the ID
      const block = new Block(this, this.undoRedoManager, id, this.currentUser)
      this.blockCache.set(id, block)
      return block
    } else {
      // In Automerge mode, we need the handle
      if (!isValidAutomergeUrl(id)) throw new Error('Invalid block id')

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
  }

  create(data: Partial<BlockData>): Block
  async create(data: Partial<BlockData> & { orderKey?: string }): Promise<Block>
  create(data: Partial<BlockData> & { orderKey?: string }): Block | Promise<Block> {
    if (USE_POWERSYNC) {
      return this.createPowerSyncBlock(data)
    } else {
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
  }

  // private setupHooks(_: AutomergeRepoUndoRedo<BlockData>) {
  // Todo: https://github.com/onsetsoftware/automerge-repo-undo-redo/issues/5
  //   actually making changes here even on fields that are unrelated to each other makes the undo/redo go haywire
  //   So leaving this here as a reminder not to do this and handle things on Block class instead
  // }

  private async createPowerSyncBlock(props: Partial<BlockData> & { orderKey?: string }): Promise<Block> {
    const id = uuid()
    const now = Date.now()
    const orderKey = props.orderKey || generateFirstOrderKey()

    await powerSyncDb.execute(
      `INSERT INTO blocks 
       (id, parent_id, order_key, content, create_time, update_time, 
        created_by_user_id, updated_by_user_id, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        id,
        props.parentId || null,
        orderKey,
        props.content ?? '',
        props.createTime ?? now,
        props.updateTime ?? now,
        props.createdByUserId ?? this.currentUser.id,
        props.updatedByUserId ?? this.currentUser.id
      ]
    )

    // Insert properties if provided
    if (props.properties) {
      for (const [name, prop] of Object.entries(props.properties)) {
        await powerSyncDb.execute(
          `INSERT INTO block_properties (block_id, name, type, value_json, change_scope)
           VALUES (?, ?, ?, ?, ?)`,
          [
            id,
            name,
            (prop as any).type,
            JSON.stringify((prop as any).value),
            (prop as any).changeScope || null
          ]
        )
      }
    }

    return this.find(id)
  }

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
      doc.references = props.references || []

      if (props.parentId) {
        doc.parentId = props.parentId
      }
    })

    return handle
  }
}

