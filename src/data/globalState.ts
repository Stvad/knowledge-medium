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
  topLevelBlockIdProp,
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
// The user/ui-state subtree under [system]/[users]/{userId} is per-viewer UI
// state. We tag the bootstrap creates with uiChangeScope so they're allowed
// (and routed to ephemeral storage) when the active workspace is read-only.
export const getUIStateBlock = memoize(
  async (repo: Repo, rootBlock: Block, user: User, context: BlockContextType): Promise<Block> => {
    const userBlock = await getUserBlock(rootBlock, user)

    if (context.panelId) {
      return repo.find(context.panelId)
    }

    return userBlock.childByContent('ui-state', true, {scope: uiChangeScope})
  }, (repo, rootBlock, user, context) =>
    `${repo.instanceId}:${rootBlock.id}:${user.id}:${context.panelId ?? '__root__'}`)

export const getUserBlock = memoize(
  async (rootBlock: Block, user: User): Promise<Block> =>
    rootBlock.childByContent(['system', 'users', user.id], true, {scope: uiChangeScope}),
  (rootBlock, user) => `${rootBlock.repo.instanceId}:${rootBlock.id}:${user.id}`)


const panelsPathPart = 'panels'
export const getPanelsBlock = memoize(
  async (uiStateBlock: Block): Promise<Block> =>
    uiStateBlock.childByContent([panelsPathPart], true, {scope: uiChangeScope}),
  (uiBlock) => `${uiBlock.repo.instanceId}:${uiBlock.id}`)

/**
 * Resolve the panel ui-state block the user is most likely working in.
 *
 * GLOBAL action handlers receive the user-level ui-state block, where
 * per-panel state — focusedBlockId, topLevelBlockId — is *not* stored.
 * Panel state lives on each panel's own block under ui-state/panels,
 * so any GLOBAL handler that wants to act on "the current view" needs
 * to walk to the right panel first.
 *
 * Picks the first panel with a focused block; falls back to the first
 * panel that has a topLevelBlockId so the helper still resolves on a
 * fresh page where the user hasn't focused anything yet. Returns
 * undefined only if no panels exist.
 */
export const getActivePanelBlock = async (uiStateBlock: Block): Promise<Block | undefined> => {
  const panelsBlock = await getPanelsBlock(uiStateBlock)
  const panels = await panelsBlock.children()
  let fallback: Block | undefined
  for (const panel of panels) {
    const data = await panel.data()
    if (data?.properties[focusedBlockIdProp.name]?.value) return panel
    if (!fallback && data?.properties[topLevelBlockIdProp.name]?.value) fallback = panel
  }
  return fallback
}

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
