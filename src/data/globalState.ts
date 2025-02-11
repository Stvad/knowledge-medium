import { useBlockContext } from '@/context/block.tsx'
import { Block } from '@/data/block.ts'
import { use } from 'react'
import { BlockPropertyValue } from '@/types.ts'
import { memoize } from 'lodash'
import { useRepo } from '@/context/repo.tsx'
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
  return block.useProperty(name, initialValue, 'ui-state')
}


/**
 * Gets or creates the UI state block, which is located at root > "system" > "ui-state"
 */
function useUIStateBlock(): Block {
  const { rootBlockId } = useBlockContext()
  const repo = useRepo()
  return use(getUIStateBlock(repo, rootBlockId!))
}

/**
 * Memoized for using with `use` react function
 */
export const getUIStateBlock = memoize(async (repo: Repo, rootBlockId: string): Promise<Block> => {
  const block = repo.find(rootBlockId)
  const systemBlock = await block.childByContent('system', true)
  return systemBlock.childByContent('ui-state', true)
}, (_, rootBlockId) => rootBlockId)
