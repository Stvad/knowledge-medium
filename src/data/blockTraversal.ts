import { memoize } from 'lodash'
import type { Block } from '@/data/block'
import type { BlockData } from '@/types'
import { isCollapsedProp } from '@/data/properties.ts'

type MaybePromise<T> = T | Promise<T>

interface VisitBlocksOptions {
  protectCycles?: boolean
  catchErrors?: boolean
  shouldVisitChildren?: (block: Block) => MaybePromise<boolean>
  onError?: (block: Block, error: unknown) => void
}

const getChildIndex = (parent: BlockData, childId: string) =>
  parent.childIds.indexOf(childId)

const defaultTraversalErrorHandler = (block: Block, error: unknown) => {
  console.warn('Error visiting block:', block.id, error)
}

export async function visitBlocks<T>(
  rootBlock: Block,
  visitor: (block: Block) => MaybePromise<T | undefined>,
  {
    protectCycles = true,
    catchErrors = false,
    shouldVisitChildren,
    onError = defaultTraversalErrorHandler,
  }: VisitBlocksOptions = {},
): Promise<T | undefined> {
  const visitedBlocks = new Set<string>()

  const traverse = async (block: Block): Promise<T | undefined> => {
    if (protectCycles) {
      if (visitedBlocks.has(block.id)) return undefined
      visitedBlocks.add(block.id)
    }

    const visitCurrent = async (): Promise<T | undefined> => {
      const result = await visitor(block)
      if (result !== undefined) return result

      if (shouldVisitChildren && !(await shouldVisitChildren(block))) {
        return undefined
      }

      const children = await block.children()
      for (const child of children) {
        const childResult = await traverse(child)
        if (childResult !== undefined) return childResult
      }

      return undefined
    }

    if (!catchErrors) {
      return visitCurrent()
    }

    try {
      return await visitCurrent()
    } catch (error) {
      onError(block, error)
      return undefined
    }
  }

  try {
    return await traverse(rootBlock)
  } catch (error) {
    if (!catchErrors) throw error
    console.warn('Error in block traversal:', error)
    return undefined
  }
}

export async function getVisibleBlockIdsInOrder(
  topLevelBlock: Block,
): Promise<string[]> {
  const visibleBlockIds: string[] = []

  await visitBlocks<void>(
    topLevelBlock,
    (block) => {
      visibleBlockIds.push(block.id)
      return undefined
    },
    {
      shouldVisitChildren: async (block) => {
        const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
        return !isCollapsed || block.id === topLevelBlock.id
      },
    },
  )

  return visibleBlockIds
}

export const getRootBlock = memoize(async (block: Block): Promise<Block> => {
  const parent = await block.parent()

  if (!parent) return block

  return getRootBlock(parent)
}, (block) => `${block.repo.instanceId}:${block.id}`)

export const nextVisibleBlock = async (block: Block, topLevelBlockId: string): Promise<Block | null> => {
  const doc = await block.data()
  if (!doc) return null

  const blockIsTopLevel = block.id === topLevelBlockId

  const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
  if (doc.childIds.length > 0 && (!isCollapsed || blockIsTopLevel)) {
    return block.repo.find(doc.childIds[0])
  }

  let currentBlock = block
  while (true) {
    const parent = await currentBlock.parent()
    if (!parent || currentBlock.id === topLevelBlockId) return null

    const parentDoc = await parent.data()
    if (!parentDoc) return null

    const currentIndex = getChildIndex(parentDoc, currentBlock.id)
    if (currentIndex < parentDoc.childIds.length - 1) {
      return block.repo.find(parentDoc.childIds[currentIndex + 1])
    }

    currentBlock = parent
  }
}

export const getLastVisibleDescendant = async (block: Block, ignoreTopLevelCollapsed?: boolean): Promise<Block> => {
  const doc = await block.data()
  if (!doc) throw new Error('Cant get block data')

  const isCollapsed = (await block.getProperty(isCollapsedProp))?.value
  if (doc.childIds.length === 0 || isCollapsed && !(ignoreTopLevelCollapsed === true)) return block

  const lastChild = block.repo.find(doc.childIds[doc.childIds.length - 1])
  return getLastVisibleDescendant(lastChild)
}

export const previousVisibleBlock = async (block: Block, topLevelBlockId: string): Promise<Block | null> => {
  if (block.id === topLevelBlockId) return null
  const parent = await block.parent()
  if (!parent) return null

  const parentDoc = await parent.data()
  if (!parentDoc) throw new Error(`Can't get parent data`)
  const currentIndex = getChildIndex(parentDoc, block.id)

  if (currentIndex > 0) {
    const previousSibling = block.repo.find(parentDoc.childIds[currentIndex - 1])
    return getLastVisibleDescendant(previousSibling)
  }

  return parent
}
