import { useBlockContext } from '@/context/block.tsx'
import { Block } from '@/data/block.ts'
import { use, useCallback } from 'react'
import { BlockProperty, User, BlockContextType } from '@/types.ts'
import { memoize } from 'lodash'
import { v5 as uuidv5 } from 'uuid'
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
  aliasProp,
  fromList,
} from '@/data/properties.ts'
import { usePropertyValue, useDataWithSelector } from '@/hooks/block.ts'

/**
 * One of core principles of the system is to store all state within the system
 */

// Deterministic id for the per-user "user page" — a parent-less alias-bearing
// block that hosts the user's `ui-state` subtree for a given workspace. Same
// pattern as DAILY_NOTE_NS in dailyNotes.ts: two clients booting offline
// converge on the same row when they later sync, so we don't end up with
// duplicate user pages competing for alias resolution.
const USER_PAGE_NS = '4d9d2a73-3e5a-4f43-95e3-2a76b1b7e6d7'

const userPageBlockId = (workspaceId: string, userId: string): string =>
  uuidv5(`${workspaceId}:${userId}`, USER_PAGE_NS)

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

const requireWorkspaceId = (repo: Repo, caller: string): string => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) {
    throw new Error(`${caller} requires an active workspace; call repo.setActiveWorkspaceId() first`)
  }
  return workspaceId
}

export function useUIStateBlock(): Block {
  const context = useBlockContext()
  const repo = useRepo()
  const user = useUser()
  const workspaceId = requireWorkspaceId(repo, 'useUIStateBlock')

  return use(getUIStateBlock(repo, workspaceId, user, context))
}

export function useUserBlock(): Block {
  const repo = useRepo()
  const user = useUser()
  const workspaceId = requireWorkspaceId(repo, 'useUserBlock')

  return use(getUserBlock(repo, workspaceId, user))
}

export const useUserProperty = <T extends BlockProperty>(
  config: T,
): [T['value'], (value: T['value']) => void] =>
  usePropertyValue(useUserBlock(), config)

/**
 * Memoized for using with \`use\` react function
 */
// Per-user UI state is stored under a parent-less "user page" block addressed
// by a deterministic id derived from (workspaceId, user.id). Both the create
// and any resurrect-from-soft-delete go through uiChangeScope so they're
// tolerated in read-only workspaces (routed to ephemeral storage there — UI
// state lives session-only for viewers, never escapes locally).
export const getUIStateBlock = memoize(
  async (repo: Repo, workspaceId: string, user: User, context: BlockContextType): Promise<Block> => {
    if (context.panelId) {
      return repo.find(context.panelId)
    }

    const userBlock = await getUserBlock(repo, workspaceId, user)
    return userBlock.childByContent('ui-state', true, {scope: uiChangeScope})
  }, (repo, workspaceId, user, context) =>
    `${repo.instanceId}:${workspaceId}:${user.id}:${context.panelId ?? '__root__'}`)

export const getUserBlock = memoize(
  async (repo: Repo, workspaceId: string, user: User): Promise<Block> => {
    const id = userPageBlockId(workspaceId, user.id)
    const existing = await repo.loadBlockData(id)

    if (existing && !existing.deleted) return repo.find(id)

    if (existing && existing.deleted) {
      const block = repo.find(id)
      block.change((doc) => { doc.deleted = false }, {scope: uiChangeScope})
      return block
    }

    return repo.create({
      id,
      workspaceId,
      content: user.name,
      properties: fromList(aliasProp([user.name])),
    }, {scope: uiChangeScope})
  },
  (repo, workspaceId, user) => `${repo.instanceId}:${workspaceId}:${user.id}`)


const panelsPathPart = 'panels'
export const getPanelsBlock = memoize(
  async (uiStateBlock: Block): Promise<Block> =>
    uiStateBlock.childByContent([panelsPathPart], true, {scope: uiChangeScope}),
  (uiBlock) => `${uiBlock.repo.instanceId}:${uiBlock.id}`)

export const MAIN_PANEL_NAME = 'main'
export const isMainPanel = (panel: Block) => panel.dataSync()?.content === MAIN_PANEL_NAME

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
