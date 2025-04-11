import { useBlockContext } from '@/context/block.tsx'
import { Block, useProperty } from '@/data/block.ts'
import { use } from 'react'
import { BlockPropertyValue, User, BlockContextType } from '@/types.ts'
import { memoize } from 'lodash'
import { useRepo } from '@/context/repo.tsx'
import { useUser } from '@/components/Login.tsx'
import { Repo } from '@/data/repo.ts'

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
  return useProperty(block, name, initialValue, 'ui-state')
}


/**
 * Gets or creates the UI state block, which is located at root > "system" > "ui-state"
 */
export function useUIStateBlock(): Block {
  const context = useBlockContext()
  const repo = useRepo()
  const user = useUser()

  return use(getUIStateBlock(repo, repo.find(context.rootBlockId!), user, context))
}

/**
 * Memoized for using with `use` react function
 */
export const getUIStateBlock = memoize(
  async (repo: Repo, rootBlock: Block, user: User, context: BlockContextType): Promise<Block> => {
    const userBlock = await getUserBlock(rootBlock, user)

    if (context.panelId) {
      return repo.find(context.panelId)
    }

    return userBlock.childByContent('ui-state', true)
  }, (_, rootBlock, user, context) => rootBlock.id + user.id + context.panelId)

export const getUserBlock = memoize(
  async (rootBlock: Block, user: User): Promise<Block> => rootBlock.childByContent(['system', 'users', user.id], true),
  (rootBlock, user) => rootBlock.id + user.id)


const panelsPathPart = 'panels'
export const getPanelsBlock = memoize(
  async (uiStateBlock: Block): Promise<Block> => uiStateBlock.childByContent([panelsPathPart], true),
  (uiBlock) => uiBlock.id)
