import { useBlockContext } from '@/context/block.tsx'
import { Block } from '@/data/block.ts'
import { use, useCallback } from 'react'
import { BlockProperty, User, BlockContextType } from '@/types.ts'
import { memoize } from 'lodash'
import { useRepo } from '@/context/repo.tsx'
import { useUser } from '@/components/Login.tsx'
import { Repo } from '@/data/repo.ts'

import {
  uiChangeScope,
  selectionStateProp,
  BlockSelectionState,
  focusedBlockIdProp,
  isEditingProp,
} from '@/data/properties.ts'
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
  }, (repo, rootBlock, user, context) =>
    `${repo.instanceId}:${rootBlock.id}:${user.id}:${context.panelId ?? '__root__'}`)

export const getUserBlock = memoize(
  async (rootBlock: Block, user: User): Promise<Block> => rootBlock.childByContent(['system', 'users', user.id], true),
  (rootBlock, user) => `${rootBlock.repo.instanceId}:${rootBlock.id}:${user.id}`)


const panelsPathPart = 'panels'
export const getPanelsBlock = memoize(
  async (uiStateBlock: Block): Promise<Block> => uiStateBlock.childByContent([panelsPathPart], true),
  (uiBlock) => `${uiBlock.repo.instanceId}:${uiBlock.id}`)

export function useSelectionState(): [
  BlockSelectionState,
  (newState: Partial<BlockSelectionState>) => void
] {
  const uiStateBlock = useUIStateBlock()
  const [currentSelectionState, setRawSelectionState] = usePropertyValue(uiStateBlock, selectionStateProp)

  const setSelectionState = useCallback((newState: Partial<BlockSelectionState>) => {
    setRawSelectionState({
      ...(currentSelectionState || selectionStateProp.value!),
      ...newState,
    })
  }, [currentSelectionState, setRawSelectionState])

  return [currentSelectionState || selectionStateProp.value!, setSelectionState]
}

export const getSelectionStateSnapshot = (uiStateBlock: Block): BlockSelectionState =>
  (uiStateBlock.dataSync()?.properties[selectionStateProp.name]?.value as BlockSelectionState | undefined)
  ?? selectionStateProp.value!

export const resetBlockSelection = async (block: Block) => {
  const currentState = await block.getProperty(selectionStateProp)
  if (!currentState?.value?.selectedBlockIds.length && !currentState?.value?.anchorBlockId) return

  block.setProperty({
    ...selectionStateProp,
    value: {
      selectedBlockIds: [],
      anchorBlockId: null,
    },
  })
}

export const useInFocus = (blockId: string) =>
  useDataWithSelector(useUIStateBlock(),
    doc => doc?.properties[focusedBlockIdProp.name]?.value === blockId)

export const useIsSelected = (blockId: string) =>
  useDataWithSelector(useUIStateBlock(), (doc) => {
    const selectionState = doc?.properties[selectionStateProp.name]?.value as BlockSelectionState | undefined
    return selectionState?.selectedBlockIds.includes(blockId) ?? false
  })

export const useInEditMode = (blockId: string) => {
  const uiStateBlock = useUIStateBlock()
  const focusedBlockId = useDataWithSelector(uiStateBlock,
    doc => doc?.properties[focusedBlockIdProp.name]?.value)
  const isEditing = useDataWithSelector(uiStateBlock,
    doc => Boolean(doc?.properties[isEditingProp.name]?.value))
  return focusedBlockId === blockId && isEditing
}
