import { DocHandle, AutomergeUrl } from '@automerge/automerge-repo'
import { BlockData, BlockPropertyValue, User } from '@/types'
import { insertAt, deleteAt } from '@automerge/automerge/next'
import { useDocument } from '@automerge/automerge-repo-react-hooks'
import { memoize } from 'lodash'
import { Repo } from '@/data/repo'
import { UndoRedoManager, UndoRedoOptions } from '@onsetsoftware/automerge-repo-undo-redo'
import { useCallback } from 'react'

export type ChangeFn<T> = (doc: T) => void;
export type ChangeOptions<T> = UndoRedoOptions<T>;

export const defaultChangeScope = 'block-default'

/**
 * I want to abstract away the details of the storage lay away from the component, so i can plug in jazz.tools or similar later
 *
 * There is also whole undo/redo stuff on the app level.
 * https://github.com/onsetsoftware/automerge-repo-undo-redo/ seems to do it in a good way for Automerge
 */
export class Block {
  id: AutomergeUrl

  constructor(
    readonly repo: Repo,
    readonly undoRedoManager: UndoRedoManager,
    private readonly handle: DocHandle<BlockData>,
    readonly currentUser: User,
  ) {
    this.id = handle.url
  }

  async data() {
    return this.handle.doc()
  }

  dataSync() {
    return this.handle.docSync()
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
    
    return Promise.all(doc.childIds.map(childId => this.repo.find(childId)))
  }

  change(
    callback: ChangeFn<BlockData>,
    options: ChangeOptions<BlockData> = {},
  ) {
    this._transaction(() => {
      this._change(callback)
    }, options)
  }

  _transaction(callback: () => void, options: ChangeOptions<BlockData> = {}) {
    this.undoRedoManager.transaction(callback, {
      ...options,
      scope: options.scope ?? defaultChangeScope,
      dependencies: [this.handle.documentId],
    })
  }

  _change(
    callback: ChangeFn<BlockData>,
    options: ChangeOptions<BlockData> = {},
  ) {
    const handle = this.undoRedoManager.getUndoRedoHandle<BlockData>(this.handle.documentId)!
    handle.change(callback, options)
    handle.change(doc => {
      doc.updateTime = Date.now()
      doc.updatedByUserId = this.currentUser.id
    }, options)
  }

  async index() {
    const parent = await this.parent()
    if (!parent) return 0 // Can't get index of root level block

    const doc = await parent.data()
    if (!doc) throw new Error(`Parent block not found`)

    return getChildIndex(doc, this.id)
  }

  /**
   * todo we should outdent outside the view point, but that's not something this function can be aware of
   */
  async outdent() {
    const parent = await this.parent()
    if (!parent) return // We are root

    const grandparent = await parent.parent()
    if (!grandparent) return // Parent is root
    // 1. Remove this block from current parent's children

    this.undoRedoManager.transaction(() => {
      parent._change((parent) => {
        const index = getChildIndex(parent, this.id)
        deleteAt(parent.childIds, index)
      })

      // 2. Add this block to grandparent's children after the parent
      grandparent._change((grandparent) => {
        const parentIndex = getChildIndex(grandparent, parent.id)
        insertAt(grandparent.childIds, parentIndex + 1, this.id)
      })

      this._updateParentId(grandparent.id)
    }, {description: 'Outdent block', scope: defaultChangeScope})
  }

  async indent() {
    const parent = await this.parent()
    if (!parent) return // Can't indent root level block

    const parentDoc = await parent.data()
    if (!parentDoc) throw new Error(`Parent block not found`)

    // Find previous sibling to become new parent
    const currentIndex = getChildIndex(parentDoc, this.id)
    if (currentIndex <= 0) return // No previous sibling, can't indent

    const newParentId = parentDoc.childIds[currentIndex - 1]
    const newParent = this.repo.find(newParentId)

    this.undoRedoManager.transaction(() => {
      // 1. Remove from current parent's children
      parent._change((parent) => deleteAt(parent.childIds, currentIndex))

      // 2. Add to new parent's children
      newParent._change((newParent) => newParent.childIds.push(this.id))

      this._updateParentId(newParentId)
    }, {description: 'Indent block', scope: defaultChangeScope})
  }

  async changeOrder(shift: number) {
    const parent = await this.parent()
    if (!parent) return // Can't change order of root level block

    const parentDoc = await parent.data()
    if (!parentDoc) throw new Error(`Parent block not found`)

    const currentIndex = getChildIndex(parentDoc, this.id)
    const newIndex = currentIndex + shift

    if (newIndex < 0 || newIndex >= parentDoc.childIds.length) return

    parent.change((parent) => {
      deleteAt(parent.childIds, currentIndex)
      insertAt(parent.childIds, newIndex, this.id)
    })
  }

  /**
   * Doesn't actually delete the doc for now, just removes it from the parent
   */
  async delete() {
    const parent = await this.parent()
    if (!parent) return // Can't delete root level block

    parent.change((parent) => {
      const index = getChildIndex(parent, this.id)
      deleteAt(parent.childIds, index)
    })
  }

  async insertChildren({
    blocks,
    position = 'last'
  }: {
    blocks: Block[],
    position?: 'first' | 'last' | number
  }) {
    this._transaction(() => {
      // Update parent references for all blocks
      blocks.forEach(block => {
        block._updateParentId(this.id)
      });

      // Insert block IDs at the specified position
      this._change(doc => {
        const blockIds = blocks.map(b => b.id)
        if (position === 'first') {
          doc.childIds.unshift(...blockIds)
        } else if (typeof position === 'number') {
          doc.childIds.splice(position, 0, ...blockIds)
        } else {
          // Default to 'last'
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

    parent.change((parent) => {
      insertAt(parent.childIds, getChildIndex(parent, this.id) + offset, newBlock.id)
    })

    return this.repo.find(newBlock.id)
  }

  async createSiblingBelow(data: Partial<BlockData> = {}) {
    return this.createSibling(data, 1)
  }

  async createSiblingAbove(data: Partial<BlockData> = {}) {
    return this.createSibling(data, 0)
  }

  /**
   * Find a block by following a content path, optionally creating blocks if they don't exist
   * @param contentPath Either a single string to match against direct children, or an array of strings defining a path through the hierarchy
   * @param createIfNotExists If true and no matching block is found, creates new blocks with the given content
   * @returns The found or created block, or null if not found and creation not requested
   * Todo: rebuild with future data access layer for perf
   */
  async childByContent(contentPath: string | string[], createIfNotExists: true): Promise<Block>;
  async childByContent(contentPath: string | string[], createIfNotExists: boolean = false): Promise<Block | null> {
    const path = Array.isArray(contentPath) ? contentPath : [contentPath];
    return this.childByContentPath(path, createIfNotExists);
  }

  async childByContentPath(path: string[], createIfNotExists: boolean): Promise<Block | null> {
    if (path.length === 0) return null;
    
    const [currentContent, ...remainingPath] = path;
    const doc = await this.getDocOrThrow();

    // Search immediate children for match
    for (const childId of doc.childIds) {
      const child = this.repo.find(childId)
      const childData = await child.data()

      if (childData?.content === currentContent) {
        // If this is the last item in path, we found our target
        if (remainingPath.length === 0) {
          return child;
        }
        // Otherwise recurse deeper
        return child.childByContentPath(remainingPath, createIfNotExists);
      }
    }

    // No match found
    if (!createIfNotExists) return null;

    // Create new block and continue recursively if needed
    const newBlock = await this.createChild({data: {content: currentContent}});
    if (remainingPath.length === 0) {
      return newBlock;
    }
    return newBlock.childByContentPath(remainingPath, createIfNotExists);
  }

  async getProperty<T extends BlockPropertyValue>(name: string): Promise<T | undefined> {
    const doc = await this.data()
    if (!doc) return undefined
    return doc.properties[name] as T | undefined
  }

  setProperty<T extends BlockPropertyValue>(name: string, value: T, scope?: string) {
    this.change((doc) => doc.properties[name] = value, {scope: scope})
  }

  _updateParentId = (newParentId: string) =>
    this._change((doc) => {
      doc.parentId = newParentId
    })

  updateParentId = (newParentId: string) => this._transaction(() => this._updateParentId(newParentId))

  private getDocOrThrow = async () => {
    const doc = await this.handle.doc()
    if (!doc) throw new Error(`Block not found: ${this.id}`)
    return doc
  }

  async createChild({
    data = {},
    position = 'last'
  }: {
    data?: Partial<BlockData>,
    position?: 'first' | 'last' | number
  } = {}) {
    const newBlock = this.repo.create({
      ...data,
      parentId: this.id,
    })

    this.change((doc) => {
      if (position === 'first') {
        doc.childIds.unshift(newBlock.id)
      } else if (typeof position === 'number') {
        doc.childIds.splice(position, 0, newBlock.id)
      } else {
        // Default to 'last'
        doc.childIds.push(newBlock.id)
      }
    })

    return newBlock
  }
}

const getChildIndex = (parent: BlockData, childId: string) => {
  // Doing unpacking because https://github.com/automerge/automerge/pull/717
  // I should probably go use jazz.tools 😛
  return [...parent.childIds].indexOf(childId)
}

/**
 * Gets the root block ID for any given block
 * The root block is the topmost parent in the block hierarchy
 * memoization mainly to be able to use this with `use` in react components
 */
export const getRootBlock = memoize(async (block: Block): Promise<Block> => {
  const parent = await block.parent()

  if (!parent) return block

  return getRootBlock(parent)
}, (block) => block.id)

/**
 * Returns the next visible block in the document
 * Order: children first (if not collapsed), then next sibling, then parent's next sibling
 */
export const nextVisibleBlock = async (block: Block, topLevelBlockId: string): Promise<Block | null> => {
  const doc = await block.data()
  if (!doc) return null

  const blockIsTopLevel = block.id === topLevelBlockId

  // If block has children and is not collapsed, return first child
  if (doc.childIds.length > 0 && (!doc.properties['system:collapsed'] || blockIsTopLevel)) {
    return block.repo.find(doc.childIds[0])
  }

  // Look for next sibling or parent's next sibling
  let currentBlock = block
  while (true) {
    const parent = await currentBlock.parent()
    // If no parent or we've reached top level, stop
    if (!parent || currentBlock.id === topLevelBlockId) return null

    const parentDoc = await parent.data()
    if (!parentDoc) return null

    const currentIndex = getChildIndex(parentDoc, currentBlock.id)

    // If has next sibling, return it
    if (currentIndex < parentDoc.childIds.length - 1) {
      return block.repo.find(parentDoc.childIds[currentIndex + 1])
    }

    // No next sibling, move up to parent and try again
    currentBlock = parent
  }
}

/**
 * Helper function to get the last visible descendant of a block
 * If block is collapsed or has no children, returns the block itself
 */
const getLastVisibleDescendant = async (block: Block): Promise<Block> => {
  const doc = await block.data()
  if (!doc) throw new Error('Cant get block data')

  if (doc.childIds.length === 0 || doc.properties['system:collapsed']) return block

  const lastChild = block.repo.find(doc.childIds[doc.childIds.length - 1] as string)
  return getLastVisibleDescendant(lastChild)
}

/**
 * Returns the previous visible block in the document
 * Order: previous sibling's last visible descendant, previous sibling, parent
 */
export const previousVisibleBlock = async (block: Block, topLevelBlockId: string): Promise<Block | null> => {
  if (block.id === topLevelBlockId) return null
  const parent = await block.parent()
  if (!parent) return null

  const parentDoc = await parent.data()
  if (!parentDoc) throw new Error(`Can't get parent data`)
  const currentIndex = getChildIndex(parentDoc, block.id)

  // If block has previous sibling
  if (currentIndex > 0) {
    const previousSibling = block.repo.find(parentDoc.childIds[currentIndex - 1])
    // Return the last visible descendant of the previous sibling
    return getLastVisibleDescendant(previousSibling)
  }

  return parent
}

export const getAllChildrenBlocks = async (block: Block): Promise<Block[]> => {
  const directChildren = await block.children()
  const childBlockChildren = await Promise.all(directChildren.map(b => getAllChildrenBlocks(b)))

  return [...directChildren, ...childBlockChildren.flat()]
}

export const useData = (block: Block) => useDocument<BlockData>(block.id)[0]

export function useProperty<T extends BlockPropertyValue>(block: Block, name: string): [T | undefined, (value: T) => void];
export function useProperty<T extends BlockPropertyValue>(block: Block, name: string, initialValue: T, scope?: string): [T, (value: T) => void];
export function useProperty <T extends BlockPropertyValue>(block: Block, name: string, initialValue?: T, scope?: string) {
  const doc = useData(block)
  const value = (doc?.properties[name] ?? initialValue) as T | undefined

  //todo un-hardcode this
  // property should specify the scope
  const propertyScope = scope ?? name.startsWith('system:') ? 'ui-state' : undefined
  const setValue = useCallback((newValue: T) => {
    block.change((doc) => doc.properties[name] = newValue, {scope: propertyScope})
  }, [block, name, scope])

  return [value, setValue]
}

export function useChildren(block: Block): Block[] {
  const doc = useData(block)
  if (!doc?.childIds?.length) return []

  return doc.childIds.map(childId => block.repo.find(childId))
}

