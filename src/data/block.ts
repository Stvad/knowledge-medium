import { BlockData, User, BlockProperty } from '@/types'
import { Repo } from '@/data/repo'
import { UndoRedoManager, UndoRedoOptions } from '@/data/undoRedo.ts'
import { parseReferences } from '@/utils/referenceParser'
import { aliasProp, fromList } from '@/data/properties.ts'
import { delay } from '@/utils/async.ts'
import { getRootBlock } from '@/data/blockTraversal.ts'

export {
  getLastVisibleDescendant,
  getRootBlock,
  nextVisibleBlock,
  previousVisibleBlock,
} from '@/data/blockTraversal.ts'

export type ChangeFn<T> = (doc: T) => void;
export type ChangeOptions<T> = UndoRedoOptions<T>;

export const defaultChangeScope = 'block-default'

export class Block {
  constructor(
    readonly repo: Repo,
    readonly undoRedoManager: UndoRedoManager,
    readonly id: string,
    readonly currentUser: User,
  ) {
  }

  async data() {
    return this.repo.loadBlockData(this.id)
  }

  dataSync() {
    return this.repo.getCachedBlockData(this.id)
  }

  async parent() {
    const doc = await this.data()
    if (!doc?.parentId) return null
    return this.repo.find(doc.parentId)
  }

  async parents() {
    const parents = []
    let parent = await this.parent()
    while (parent) {
      parents.push(parent)
      parent = await parent.parent()
    }
    return parents.reverse()
  }

  async hasChildren() {
    const doc = await this.data()
    return !!doc?.childIds?.length
  }

  async children(): Promise<Block[]> {
    const doc = await this.data()
    if (!doc?.childIds?.length) return []

    return doc.childIds.map(childId => this.repo.find(childId))
  }

  change(
    callback: ChangeFn<BlockData>,
    options: ChangeOptions<BlockData> = {},
  ) {
    this._transaction(() => {
      this._change(callback, options)
    }, options)

    void parseAndUpdateReferences(this)
  }

  _transaction(callback: () => void, options: ChangeOptions<BlockData> = {}) {
    this.undoRedoManager.transaction(callback, {
      ...options,
      scope: options.scope ?? defaultChangeScope,
      dependencies: [this.id],
    })
  }

  _change(
    callback: ChangeFn<BlockData>,
    options: ChangeOptions<BlockData> = {},
  ) {
    this.repo.applyBlockChange(this.id, callback, {
      ...options,
      scope: options.scope ?? defaultChangeScope,
    })
  }

  async index() {
    const parent = await this.parent()
    if (!parent) return 0

    const doc = await parent.data()
    if (!doc) throw new Error('Parent block not found')

    return getChildIndex(doc, this.id)
  }

  async outdent(topLevelBlockId: string) {
    if (this.id === topLevelBlockId) return false

    const parent = await this.parent()
    if (!parent || parent.id === topLevelBlockId) return false

    const grandparent = await parent.parent()
    if (!grandparent) return false

    this.undoRedoManager.transaction(() => {
      parent._change((parentDoc) => {
        const index = getChildIndex(parentDoc, this.id)
        parentDoc.childIds.splice(index, 1)
      })

      grandparent._change((grandparentDoc) => {
        const parentIndex = getChildIndex(grandparentDoc, parent.id)
        grandparentDoc.childIds.splice(parentIndex + 1, 0, this.id)
      })

      this._updateParentId(grandparent.id)
    }, {description: 'Outdent block', scope: defaultChangeScope})
    return true
  }

  async indent() {
    const parent = await this.parent()
    if (!parent) return

    const parentDoc = await parent.data()
    if (!parentDoc) throw new Error('Parent block not found')

    const currentIndex = getChildIndex(parentDoc, this.id)
    if (currentIndex <= 0) return

    const newParentId = parentDoc.childIds[currentIndex - 1]
    const newParent = this.repo.find(newParentId)

    this.undoRedoManager.transaction(() => {
      parent._change((parentDoc) => {
        parentDoc.childIds.splice(currentIndex, 1)
      })

      newParent._change((newParentDoc) => {
        newParentDoc.childIds.push(this.id)
      })

      this._updateParentId(newParentId)
    }, {description: 'Indent block', scope: defaultChangeScope})
    return true
  }

  async changeOrder(shift: number) {
    const parent = await this.parent()
    if (!parent) return

    const parentDoc = await parent.data()
    if (!parentDoc) throw new Error('Parent block not found')

    const currentIndex = getChildIndex(parentDoc, this.id)
    const newIndex = currentIndex + shift

    if (newIndex < 0 || newIndex >= parentDoc.childIds.length) return

    parent.change((parentDoc) => {
      parentDoc.childIds.splice(currentIndex, 1)
      parentDoc.childIds.splice(newIndex, 0, this.id)
    })
  }

  async delete() {
    const parent = await this.parent()
    if (!parent) return

    parent.change((parentDoc) => {
      const index = getChildIndex(parentDoc, this.id)
      parentDoc.childIds.splice(index, 1)
    })
  }

  async insertChildren({
    blocks,
    position = 'last',
  }: {
    blocks: Block[],
    position?: 'first' | 'last' | number
  }) {
    this._transaction(() => {
      blocks.forEach(block => {
        block._updateParentId(this.id)
      })

      this._change(doc => {
        const blockIds = blocks.map(block => block.id)
        if (position === 'first') {
          doc.childIds.unshift(...blockIds)
        } else if (typeof position === 'number') {
          doc.childIds.splice(position, 0, ...blockIds)
        } else {
          doc.childIds.push(...blockIds)
        }
      })
    }, {description: 'Insert children blocks'})
  }

  private async createSibling(data: Partial<BlockData> = {}, offset: number = 1) {
    const parent = await this.parent()
    if (!parent) return

    const newBlock = this.repo.create({
      ...data,
      parentId: parent.id,
    })

    parent.change((parentDoc) => {
      parentDoc.childIds.splice(getChildIndex(parentDoc, this.id) + offset, 0, newBlock.id)
    })

    return this.repo.find(newBlock.id)
  }

  async createSiblingBelow(data: Partial<BlockData> = {}) {
    return this.createSibling(data, 1)
  }

  async createSiblingAbove(data: Partial<BlockData> = {}) {
    return this.createSibling(data, 0)
  }

  async childByContent(contentPath: string | string[], createIfNotExists: true, options?: {scope?: string}): Promise<Block>;
  async childByContent(contentPath: string | string[], createIfNotExists?: boolean, options?: {scope?: string}): Promise<Block | null>;
  async childByContent(
    contentPath: string | string[],
    createIfNotExists: boolean = false,
    options: {scope?: string} = {},
  ): Promise<Block | null> {
    const path = Array.isArray(contentPath) ? contentPath : [contentPath]
    return this.childByContentPath(path, createIfNotExists, options)
  }

  async childByContentPath(
    path: string[],
    createIfNotExists: boolean,
    options: {scope?: string} = {},
  ): Promise<Block | null> {
    if (path.length === 0) return null

    const [currentContent, ...remainingPath] = path
    await this.getDocOrThrow()

    const existingChild = await this.repo.findFirstChildByContent(this.id, currentContent)
    if (existingChild) {
      if (remainingPath.length === 0) {
        return existingChild
      }
      return existingChild.childByContentPath(remainingPath, createIfNotExists, options)
    }

    if (!createIfNotExists) return null

    const newBlock = await this.createChild({data: {content: currentContent}, scope: options.scope})
    if (remainingPath.length === 0) {
      return newBlock
    }
    return newBlock.childByContentPath(remainingPath, createIfNotExists, options)
  }

  async getProperty<T extends BlockProperty>(key: string | T): Promise<T | undefined> {
    const propName = typeof key === 'string' ? key : key.name
    const doc = await this.data()
    return doc?.properties[propName] as T | undefined
  }

  setProperty<T extends BlockProperty>(property: T) {
    this.change((doc) => {
      doc.properties[property.name] = property
    }, {scope: property.changeScope})
  }

  _updateParentId = (newParentId: string) =>
    this._change((doc) => {
      doc.parentId = newParentId
    })

  updateParentId = (newParentId: string) => this._transaction(() => this._updateParentId(newParentId))

  private getDocOrThrow = async () => {
    const doc = await this.data()
    if (!doc) throw new Error(`Block not found: ${this.id}`)
    return doc
  }

  async createChild({
    data = {},
    position = 'last',
    scope,
  }: {
    data?: Partial<BlockData>,
    position?: 'first' | 'last' | number,
    scope?: string,
  } = {}) {
    const newBlock = this.repo.create({
      ...data,
      parentId: this.id,
    }, {scope})

    this.change((doc) => {
      if (position === 'first') {
        doc.childIds.unshift(newBlock.id)
      } else if (typeof position === 'number') {
        doc.childIds.splice(position, 0, newBlock.id)
      } else {
        doc.childIds.push(newBlock.id)
      }
    }, {scope})

    return newBlock
  }

  async isDescendantOf(potentialAncestor: Block): Promise<boolean> {
    let current = await this.parent()
    while (current) {
      if (current.id === potentialAncestor.id) {
        return true
      }
      current = await current.parent()
    }
    return false
  }
}

const getChildIndex = (parent: BlockData, childId: string) =>
  parent.childIds.indexOf(childId)

export const getAllChildrenBlocks = async (block: Block): Promise<Block[]> => {
  return block.repo.getSubtreeBlocks(block.id)
}

const parseAndUpdateReferences = async (block: Block) => {
  const blockData = block.dataSync()
  if (!blockData) return

  const aliases = parseReferences(blockData.content).map(ref => ref.alias)
  const newReferenceSet = await Promise.all(aliases.map(async alias => ({
    id: (await getOrCreateBlockForAlias(block, alias)).id,
    alias,
  })))

  const currentReferences = block.dataSync()?.references ?? []
  if (JSON.stringify(currentReferences) === JSON.stringify(newReferenceSet)) {
    return
  }

  block._change((doc: BlockData) => {
    doc.references = newReferenceSet
  }, {
    skipMetadataUpdate: true,
    skipUndo: true,
    scope: `${defaultChangeScope}:references`,
  })
}

const getOrCreateBlockForAlias = async (block: Block, alias: string) => {
  const rootBlock = await getRootBlock(block)
  const existingBlock = await rootBlock.repo.findBlockByAliasInSubtree(rootBlock.id, alias)

  const referenceWasRemoved = (candidate: Block) =>
    (block.dataSync()?.references ?? []).findIndex(ref => ref.id === candidate.id) === -1

  return existingBlock || await createSelfDestructingBlockForAlias(rootBlock, alias, referenceWasRemoved)
}

const createNewBlockForAlias = async (rootBlock: Block, alias: string) => {
  const library = await rootBlock.childByContent('library', true)
  return library.createChild({data: {content: alias, properties: fromList(aliasProp([alias]))}})
}

const createSelfDestructingBlockForAlias = async (rootBlock: Block, alias: string, condition: (newBlock: Block) => boolean) => {
  const newBlock = await createNewBlockForAlias(rootBlock, alias)
  void selfDestructIf(newBlock, 4000, condition)

  return newBlock
}

const selfDestructIf = async (block: Block, ms: number, condition: (block: Block) => boolean) => {
  await delay(ms)
  if (condition(block)) return block.delete()
}
