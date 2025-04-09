import { useBlockContext } from '@/context/block.tsx'
import { Block } from '@/data/block.ts'
import { use } from 'react'
import { BlockPropertyValue, User } from '@/types.ts'
import { memoize } from 'lodash'
import { useRepo } from '@/context/repo.tsx'
import { useUser } from '@/components/Login.tsx'

/**
 * One of core principles of the system is to store all state within the system
 */

/**
 * Hook to access and modify UI state properties
 * @param name Property name
 * @param initialValue Optional initial value
 */
export function useUIStateProperty<T extends BlockPropertyValue>(name: string): [T | undefined, (value: T) => void];
export function useUIStateProperty<T extends BlockPropertyValue>(name: string, initialValue: T): [T, (value: T) => void];
export function useUIStateProperty<T extends BlockPropertyValue>(name: string, initialValue?: T) {
  const block = useUIStateBlock()
  // todo properties should supply their own change scope
  return block.useProperty(name, initialValue, 'ui-state')
}


/**
 * Gets or creates the UI state block, which is located at root > "system" > "ui-state"
 */
export function useUIStateBlock(): Block {
  const {rootBlockId, panelId} = useBlockContext()
  const repo = useRepo()
  const user = useUser()

  return use(getUIStateBlock(repo.find(rootBlockId!), user, panelId))
}

const panelsPathPart = 'panels'
/**
 * Memoized for using with `use` react function
 */
export const getUIStateBlock = memoize(async (rootBlock: Block, user: User, panelId?: string): Promise<Block> => {
  const userBlock = await getUserBlock(rootBlock, user)
  const basePath = 'ui-state'
  const contentPath = panelId ? [basePath, panelsPathPart, panelId] : basePath
  return userBlock.childByContent(contentPath, true)
}, (rootBlock, user, panelId) => rootBlock.id + user.id + panelId)

export const getUserBlock = memoize(
  async (rootBlock: Block, user: User): Promise<Block> => rootBlock.childByContent(['system', 'users', user.id], true),
  (rootBlock, user) => rootBlock.id + user.id)

export const getPanelBlocks = memoize(
  async (uiStateBlock: Block, initMainPanel: {name: string, topLevelBlockId: string}): Promise<Block[]> => {
    const panelsBlock = await uiStateBlock.childByContent([panelsPathPart], true)
    const mainPanelBlock = await panelsBlock.childByContent([initMainPanel.name], true)
    mainPanelBlock.setProperty('topLevelBlockId', initMainPanel.topLevelBlockId)

    return panelsBlock.children()
  },
  (_, initMainPanel) => initMainPanel.topLevelBlockId)
