import { SqliteRepo } from '@/data/sqliteRepo'
import { BlockData, BlockProperty } from '@/types'
import { parseReferences } from '@/utils/referenceParser'
import { fromList, aliasProp, isCollapsedProp } from '@/data/properties'
import { delay } from '@/utils/async'
import { reconcileList } from '@/utils/array'

export const defaultChangeScope = 'block-default'

function ensureDocShape(doc: BlockData): void {
  if (!doc.childIds) doc.childIds = []
  if (!doc.properties) doc.properties = {}
  if (!doc.references) doc.references = []
}

export class SqliteBlock {
  private updatingReferences = false

  constructor(
    readonly repo: SqliteRepo,
    readonly id: string
  ) {}

  get currentUser() {
    return this.repo.currentUser
  }

  async data(): Promise<BlockData | undefined> {
    return this.repo.loadBlockData(this.id)
  }

  async dataSync(): Promise<BlockData | undefined> {
    return this.data()
  }

  async change(changeFn: (doc: BlockData) => void): Promise<void> {
    await this.repo.applyChange(this.id, (doc) => {
      ensureDocShape(doc)
      changeFn(doc)
    })

    if (!this.updatingReferences) {
      void this.updateReferencesFromContent()
    }
  }

  async parent(): Promise<SqliteBlock | null> {
    const doc = await this.data()
    if (!doc?.parentId) return null
    return this.repo.find(doc.parentId)
  }

  async parents(): Promise<SqliteBlock[]> {
    const ancestors: SqliteBlock[] = []
    let current = await this.parent()
    while (current) {
      ancestors.push(current)
      current = await current.parent()
    }
    return ancestors.reverse()
  }

  async hasChildren(): Promise<boolean> {
    const doc = await this.data()
    return (doc?.childIds.length ?? 0) > 0
  }

  async children(): Promise<SqliteBlock[]> {
    const doc = await this.data()
    if (!doc?.childIds?.length) return []
    return doc.childIds.map((childId) => this.repo.find(childId))
  }

  async insertChildren({
    blocks,
    position = 'last',
  }: {
    blocks: SqliteBlock[]
    position?: 'first' | 'last' | number
  }): Promise<void> {
    const blockIds = blocks.map((block) => block.id)
    await this.change((doc) => {
      if (position === 'first') {
        doc.childIds.unshift(...blockIds)
      } else if (typeof position === 'number') {
        doc.childIds.splice(position, 0, ...blockIds)
      } else {
        doc.childIds.push(...blockIds)
      }
    })

    await Promise.all(
      blocks.map((block) =>
        block.change((childDoc) => {
          childDoc.parentId = this.id
        })
      )
    )
  }

  private async createSibling(data: Partial<BlockData> = {}, offset: number): Promise<SqliteBlock | null> {
    const parent = await this.parent()
    if (!parent) return null

    const newBlock = await this.repo.create({
      ...data,
      parentId: parent.id,
    })

    await parent.change((doc) => {
      const index = getChildIndex(doc, this.id)
      if (index >= 0) {
        doc.childIds.splice(index + offset, 0, newBlock.id)
      }
    })

    return newBlock
  }

  async createSiblingBelow(data: Partial<BlockData> = {}): Promise<SqliteBlock | null> {
    return this.createSibling(data, 1)
  }

  async createSiblingAbove(data: Partial<BlockData> = {}): Promise<SqliteBlock | null> {
    return this.createSibling(data, 0)
  }

  async childByContentPath(path: string[], createIfNotExists: boolean): Promise<SqliteBlock | null> {
    if (path.length === 0) return null
    const [currentContent, ...rest] = path

    const doc = await this.data()
    if (!doc) return null

    for (const childId of doc.childIds) {
      const child = this.repo.find(childId)
      const childDoc = await child.data()
      if (childDoc?.content === currentContent) {
        if (rest.length === 0) return child
        return child.childByContentPath(rest, createIfNotExists)
      }
    }

    if (!createIfNotExists) return null

    const newBlock = await this.createChild({ data: { content: currentContent } })
    if (rest.length === 0) return newBlock
    return newBlock.childByContentPath(rest, createIfNotExists)
  }

  async childByContent(contentPath: string | string[], createIfNotExists: true): Promise<SqliteBlock>
  async childByContent(contentPath: string | string[], createIfNotExists?: boolean): Promise<SqliteBlock | null>
  async childByContent(contentPath: string | string[], createIfNotExists = false): Promise<SqliteBlock | null> {
    const path = Array.isArray(contentPath) ? contentPath : [contentPath]
    return this.childByContentPath(path, createIfNotExists)
  }

  async getProperty<T extends BlockProperty>(key: string | T): Promise<T | undefined> {
    const doc = await this.data()
    if (!doc) return undefined
    const propName = typeof key === 'string' ? key : key.name
    return doc.properties[propName] as T | undefined
  }

  async setProperty<T extends BlockProperty>(property: T): Promise<void> {
    await this.change((doc) => {
      doc.properties[property.name] = property
    })
  }

  async updateParentId(newParentId: string | null): Promise<void> {
    await this.change((doc) => {
      doc.parentId = newParentId ?? undefined
    })
  }

  async createChild({
    data = {},
    position = 'last',
  }: {
    data?: Partial<BlockData>
    position?: 'first' | 'last' | number
  } = {}): Promise<SqliteBlock> {
    const newBlock = await this.repo.create({
      ...data,
      parentId: this.id,
    })

    await this.change((doc) => {
      if (position === 'first') {
        doc.childIds.unshift(newBlock.id)
      } else if (typeof position === 'number') {
        doc.childIds.splice(position, 0, newBlock.id)
      } else {
        doc.childIds.push(newBlock.id)
      }
    })

    return newBlock
  }

  async changeOrder(shift: number): Promise<void> {
    const parent = await this.parent()
    if (!parent) return

    await parent.change((doc) => {
      const currentIndex = getChildIndex(doc, this.id)
      const newIndex = currentIndex + shift
      if (newIndex < 0 || newIndex >= doc.childIds.length) return
      doc.childIds.splice(currentIndex, 1)
      doc.childIds.splice(newIndex, 0, this.id)
    })
  }

  async outdent(topLevelBlockId: string): Promise<boolean> {
    if (this.id === topLevelBlockId) return false

    const parent = await this.parent()
    if (!parent || parent.id === topLevelBlockId) return false

    const grandparent = await parent.parent()
    if (!grandparent) return false

    await parent.change((doc) => {
      const index = getChildIndex(doc, this.id)
      if (index >= 0) doc.childIds.splice(index, 1)
    })

    await grandparent.change((doc) => {
      const parentIndex = getChildIndex(doc, parent.id)
      doc.childIds.splice(parentIndex + 1, 0, this.id)
    })

    await this.change((doc) => {
      doc.parentId = grandparent.id
    })

    return true
  }

  async indent(): Promise<boolean> {
    const parent = await this.parent()
    if (!parent) return false

    const parentDoc = await parent.data()
    if (!parentDoc) return false

    const currentIndex = getChildIndex(parentDoc, this.id)
    if (currentIndex <= 0) return false

    const newParentId = parentDoc.childIds[currentIndex - 1]
    const newParent = this.repo.find(newParentId)

    await parent.change((doc) => {
      const idx = getChildIndex(doc, this.id)
      if (idx >= 0) doc.childIds.splice(idx, 1)
    })

    await newParent.change((doc) => {
      doc.childIds.push(this.id)
    })

    await this.change((doc) => {
      doc.parentId = newParentId
    })

    return true
  }

  async delete(): Promise<void> {
    const parent = await this.parent()
    if (parent) {
      await parent.change((doc) => {
        const index = getChildIndex(doc, this.id)
        if (index >= 0) doc.childIds.splice(index, 1)
      })
    }
    await this.repo.deleteBlock(this.id)
  }

  async isDescendantOf(candidate: SqliteBlock): Promise<boolean> {
    let current = await this.parent()
    while (current) {
      if (current.id === candidate.id) return true
      current = await current.parent()
    }
    return false
  }

  async updateReferencesFromContent(): Promise<void> {
    const blockData = await this.data()
    if (!blockData) return

    const aliases = parseReferences(blockData.content).map((ref) => ref.alias)

    this.updatingReferences = true
    try {
      if (aliases.length === 0) {
        if (blockData.references.length > 0) {
          await this.repo.applyChange(this.id, (doc) => {
            ensureDocShape(doc)
            doc.references = []
          })
        }
        return
      }

      const rootBlock = await getRootBlock(this)
      const referenceEntries = await Promise.all(
        aliases.map(async (alias) => {
          const existingBlock = await findBlockByAliasSqlite(rootBlock, alias)
          if (existingBlock) {
            return { id: existingBlock.id, alias }
          }

          const newBlock = await createSelfDestructingBlockForAlias(rootBlock, alias, async (block) => {
            const data = await block.data()
            return !(data?.references.some((ref) => ref.alias === alias))
          })

          return { id: newBlock.id, alias }
        })
      )

      await this.repo.applyChange(this.id, (doc) => {
        ensureDocShape(doc)
        reconcileList(doc.references, referenceEntries, (ref) => ref.id)
      })
    } finally {
      this.updatingReferences = false
    }
  }
}

const getChildIndex = (parent: BlockData, childId: string): number => {
  return parent.childIds.indexOf(childId)
}

export const getRootBlock = async (block: SqliteBlock): Promise<SqliteBlock> => {
  const parent = await block.parent()
  if (!parent) return block
  return getRootBlock(parent)
}

export const getLastVisibleDescendant = async (block: SqliteBlock, ignoreTopLevelCollapsed = false): Promise<SqliteBlock> => {
  const doc = await block.data()
  if (!doc) throw new Error('Block not found')

  const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
  if (doc.childIds.length === 0 || (isCollapsed && !ignoreTopLevelCollapsed)) return block

  const lastChild = block.repo.find(doc.childIds[doc.childIds.length - 1])
  return getLastVisibleDescendant(lastChild, ignoreTopLevelCollapsed)
}

export const nextVisibleBlock = async (block: SqliteBlock, topLevelBlockId: string): Promise<SqliteBlock | null> => {
  const doc = await block.data()
  if (!doc) return null

  const blockIsTopLevel = block.id === topLevelBlockId
  const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
  if (doc.childIds.length > 0 && (!isCollapsed || blockIsTopLevel)) {
    return block.repo.find(doc.childIds[0])
  }

  let current: SqliteBlock | null = block
  while (current) {
    const parent = await current.parent()
    if (!parent || current.id === topLevelBlockId) return null

    const parentDoc = await parent.data()
    if (!parentDoc) return null

    const currentIndex = getChildIndex(parentDoc, current.id)
    if (currentIndex < parentDoc.childIds.length - 1) {
      return block.repo.find(parentDoc.childIds[currentIndex + 1])
    }

    current = parent
  }

  return null
}

export const previousVisibleBlock = async (block: SqliteBlock, topLevelBlockId: string): Promise<SqliteBlock | null> => {
  if (block.id === topLevelBlockId) return null

  const parent = await block.parent()
  if (!parent) return null

  const parentDoc = await parent.data()
  if (!parentDoc) return null

  const index = getChildIndex(parentDoc, block.id)
  if (index > 0) {
    const previousSibling = block.repo.find(parentDoc.childIds[index - 1])
    return getLastVisibleDescendant(previousSibling)
  }

  return parent
}

export const getAllChildrenBlocks = async (block: SqliteBlock): Promise<SqliteBlock[]> => {
  const directChildren = await block.children()
  const descendants = await Promise.all(directChildren.map((child) => getAllChildrenBlocks(child)))
  return [...directChildren, ...descendants.flat()]
}

const createNewBlockForAlias = async (rootBlock: SqliteBlock, alias: string) => {
  const library = await rootBlock.childByContent('library', true)
  return library.createChild({ data: { content: alias, properties: fromList(aliasProp([alias])) } })
}

const findBlockByAliasSqlite = async (rootBlock: SqliteBlock, alias: string): Promise<SqliteBlock | null> => {
  const visited = new Set<string>()

  const visit = async (block: SqliteBlock): Promise<SqliteBlock | null> => {
    if (visited.has(block.id)) return null
    visited.add(block.id)

    try {
      const aliasProperty = await block.getProperty(aliasProp())
      if (aliasProperty?.value && Array.isArray(aliasProperty.value) && aliasProperty.value.includes(alias)) {
        return block
      }

      const children = await block.children()
      for (const child of children) {
        const found = await visit(child)
        if (found) return found
      }
    } catch (error) {
      console.warn('Error traversing block for alias lookup', block.id, error)
    }

    return null
  }

  return visit(rootBlock)
}

const createSelfDestructingBlockForAlias = async (
  rootBlock: SqliteBlock,
  alias: string,
  condition: (block: SqliteBlock) => Promise<boolean>
): Promise<SqliteBlock> => {
  const newBlock = await createNewBlockForAlias(rootBlock, alias)
  void selfDestructIf(newBlock, 4000, condition)
  return newBlock
}

const selfDestructIf = async (block: SqliteBlock, ms: number, condition: (block: SqliteBlock) => Promise<boolean>) => {
  await delay(ms)
  if (await condition(block)) {
    await block.delete()
  }
}
