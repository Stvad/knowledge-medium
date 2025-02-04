import { DocHandle, Repo, AutomergeUrl, isValidAutomergeUrl } from '@automerge/automerge-repo'
import { BlockData as BlockData, BlockPropertyValue } from '@/types.ts'
import { ChangeOptions as AutomergeCahngeOptions, insertAt, deleteAt } from '@automerge/automerge'
import { useDocument } from '@automerge/automerge-repo-react-hooks'
import { memoize } from 'lodash'

export type ChangeFn<T> = (doc: T) => void;
export type ChangeOptions<T> = AutomergeCahngeOptions<T>;

/**
 * I want to abstract away the details of the storage lay away from the component, so i can plug in jazz.tools or similar later
 *
 * There is also whole undo/redo stuff on the app level.
 * https://github.com/onsetsoftware/automerge-repo-undo-redo/ seems to do it in a good way for Automerge
 */
export class Block {
  static new(repo: Repo, data: Partial<BlockData>) {
    const doc = createBlockDoc(repo, data)
    return new Block(repo, doc.url)
  }

  id: AutomergeUrl
  handle: DocHandle<BlockData>

  constructor(
    readonly repo: Repo,
    id: string,
  ) {
    if (!isValidAutomergeUrl(id)) throw new Error('Invalid block id')

    this.id = id
    this.handle = repo.find<BlockData>(id)
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
    return new Block(this.repo, doc.parentId)
  }

  change(
    callback: ChangeFn<BlockData>,
    options: ChangeOptions<BlockData> = {},
  ) {
    this.handle.change(callback, options)
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

    parent.change((parent) => {
      const index = getChildIndex(parent, this.id)
      deleteAt(parent.childIds, index)
    })

    // 2. Add this block to grandparent's children after the parent
    grandparent.change((grandparent) => {
      const parentIndex = getChildIndex(grandparent, parent.id)
      insertAt(grandparent.childIds, parentIndex + 1, this.id)
    })

    this.updateParentId(grandparent.id)
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
    const newParent = this.repo.find<BlockData>(newParentId as AutomergeUrl)

    // 1. Remove from current parent's children
    parent.change((parent) => deleteAt(parent.childIds, currentIndex))

    // 2. Add to new parent's children
    newParent.change((newParent) => newParent.childIds.push(this.id))

    this.updateParentId(newParentId)
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

  private async createSibling(data: Partial<BlockData> = {}, offset: number = 1) {
    const parent = await this.parent()
    if (!parent) return

    const newBlock = Block.new(this.repo, {
      ...data,
      parentId: parent.id,
    })

    parent.change((parent) => {
      insertAt(parent.childIds, getChildIndex(parent, this.id) + offset, newBlock.id)
    })

    return new Block(this.repo, newBlock.id)
  }

  async createSiblingBelow(data: Partial<BlockData> = {}) {
    return this.createSibling(data, 1)
  }

  async createSiblingAbove(data: Partial<BlockData> = {}) {
    return this.createSibling(data, 0) 
  }

  /**
   * Find a child block by its content, optionally creating it if it doesn't exist
   * @param content Content to match against
   * @param createIfNotExists If true and no matching child is found, creates a new child with the given content
   * @returns The found or created child block, or null if not found and creation not requested
   * Todo: rebuild with future data access layer for perf
   */
  async childByContent(content: string, createIfNotExists: true): Promise<Block> ;
  async childByContent(content: string, createIfNotExists: boolean = false): Promise<Block | null> {
    const doc = await this.getDocOrThrow()

    for (const childId of doc.childIds) {
      const child = new Block(this.repo, childId)
      const childData = await child.data()

      if (childData?.content === content) {
        return child
      }
    }

    return createIfNotExists ? this.createChild({data: {content}}) : null
  }

  use() {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useDocument<BlockData>(this.id)[0]
  }

  useProperty<T extends BlockPropertyValue>(name: string): [T | undefined, (value: T) => void];
  useProperty<T extends BlockPropertyValue>(name: string, initialValue: T): [T, (value: T) => void];
  useProperty<T extends BlockPropertyValue>(name: string, initialValue?: T) {
    const doc = this.use()
    const value = (doc?.properties[name] ?? initialValue) as T | undefined

    const setValue = (newValue: T) => {
      this.change((doc) => doc.properties[name] = newValue)
    }

    return [value, setValue]
  }

  private updateParentId = (newParentId: string) =>
    this.change((doc) => {
      doc.parentId = newParentId
    })

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
    const newBlock = Block.new(this.repo, {
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
  
  // If block has children and is not collapsed, return first child
  if (doc.childIds.length > 0 && !doc.properties['system:collapsed']) {
    return new Block(block.repo, doc.childIds[0])
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
      return new Block(block.repo, parentDoc.childIds[currentIndex + 1])
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
  if(!doc) throw new Error('Cant get block data')
  
  if (doc.childIds.length === 0 || doc.properties['system:collapsed']) return block
  
  const lastChild = new Block(block.repo, doc.childIds[doc.childIds.length - 1] as string)
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
    const previousSibling = new Block(block.repo, parentDoc.childIds[currentIndex - 1] as string)
    // Return the last visible descendant of the previous sibling
    return getLastVisibleDescendant(previousSibling)
  }

  return parent
}


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
