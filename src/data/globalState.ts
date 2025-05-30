import { useBlockContext } from '@/context/block.tsx'
import { Block } from '@/data/block.ts'
import { use, useCallback } from 'react'
import { BlockProperty, User, BlockContextType } from '@/types.ts'
import { memoize } from 'lodash'
import { useRepo } from '@/context/repo.tsx'
import { useUser } from '@/components/Login.tsx'
import { Repo } from '@/data/repo.ts'

import { uiChangeScope, selectionStateProp, BlockSelectionState, focusedBlockIdProp } from '@/data/properties.ts'
import { usePropertyValue, useDataWithSelector } from '@/hooks/block.ts'

/**
 * One of core principles of the system is to store all state within the system
 */

/**
 * Hook to access and modify UI state properties
 * @param config Property configuration, including name, type, and default value.
 */
export function useUIStateProperty<T extends BlockProperty>(
  config: T,
): [T['value'], (value: T['value']) => void] {
  const block = useUIStateBlock()
  // Force uiChangeScope for UI state properties
  const uiConfig: T = { ...config, changeScope: uiChangeScope }

  return usePropertyValue(block, uiConfig)
}

export function useUIStateBlock(): Block {
  const context = useBlockContext()
  const repo = useRepo()
  const user = useUser()

  return use(getUIStateBlock(repo, repo.find(context.rootBlockId!), user, context))
}

export function useUserBlock(): Block {
  const context = useBlockContext()
  const repo = useRepo()
  const user = useUser()

  return use(getUserBlock(repo.find(context.rootBlockId!), user))
}

export const useUserProperty = <T extends BlockProperty>(
  config: T,
): [T['value'], (value: T['value']) => void] =>
  usePropertyValue(useUserBlock(), config)

/**
 * Memoized for using with \`use\` react function
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

export function useSelectionState(): [
  BlockSelectionState,
  (newState: Partial<BlockSelectionState>) => void
] {
  const uiStateBlock = useUIStateBlock();
  // Ensure selectionStateProp has its default value correctly typed if usePropertyValue expects it.
  // The defaultValue is part of selectionStateProp definition.
  const [currentSelectionState, setRawSelectionState] = usePropertyValue(uiStateBlock, selectionStateProp);

  const setSelectionState = useCallback((newState: Partial<BlockSelectionState>) => {
    setRawSelectionState({
      // It's important that currentSelectionState is not undefined here.
      // usePropertyValue should handle initializing with defaultValue if the property doesn't exist yet.
      ...(currentSelectionState || selectionStateProp.value!), // Fallback to defaultValue from prop if current is somehow null/undefined initially
      ...newState,
    });
  }, [currentSelectionState, setRawSelectionState]);

  // Ensure the returned currentSelectionState is never undefined, falling back to default if necessary.
  // This aligns with the hook's return type [SelectionStateValue, ...]
  return [currentSelectionState || selectionStateProp.value!, setSelectionState];
}

export const useInFocus = (blockId: string) =>
  useDataWithSelector(useUIStateBlock(),
    doc => doc?.properties[focusedBlockIdProp.name]?.value === blockId)
