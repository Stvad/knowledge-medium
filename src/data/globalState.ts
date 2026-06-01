/**
 * React hooks for the per-user "user page", synced user prefs,
 * per-plugin sub-blocks, and per-panel ui-state child tree. The
 * non-React resolvers / mutators live in `stateBlocks.ts`; this file
 * is the React-aware façade over them.
 *
 * Transient app-shell and plugin UI state (focus, selection, edit-mode,
 * top-level block, etc.) uses `ChangeScope.UiState`; user preferences
 * use `ChangeScope.UserPrefs` and live on their own child rows so
 * unrelated properties never share a row-level UPDATE payload. Both
 * scopes upload through the normal queue — the scope identity is what
 * drives undo bucketing and schema validation, not the upload routing.
 */

import { use, useCallback } from 'react'
import { useBlockContext } from '@/context/block.js'
import { useUser } from '@/components/Login.js'
import { useRepo } from '@/context/repo.js'
import {
  ChangeScope,
  type PropertySchema,
  type TypeContribution,
} from '@/data/api'
import type { Block } from './block'
import {
  activePanelIdProp,
  focusedBlockLocationFromProperties,
  selectionStateProp,
  type BlockSelectionState,
  isEditingProp,
} from '@/data/properties'
import { usePropertyValue, useHandle, useChildren } from '@/hooks/block'
import { getLayoutSessionId } from '@/utils/layoutSessionId'
import {
  getLayoutSessionBlock,
  getPluginPrefsBlock,
  getPluginUIStateBlock,
  getUIStateBlock,
  getUserBlock,
  requireSchemaScope,
  requireWorkspaceId,
  userPageBlockId,
} from '@/data/stateBlocks.js'
export { USER_PREFS_PATH_PART } from '@/data/userPrefs.js'

export function useUIStateBlock(): Block {
  const context = useBlockContext()
  const repo = useRepo()
  const user = useUser()
  const workspaceId = requireWorkspaceId(repo, 'useUIStateBlock')

  return use(getUIStateBlock(repo, workspaceId, user, context))
}

/** Root app-shell UI state, independent of the current panel context. */
export function useRootUIStateBlock(): Block {
  const repo = useRepo()
  const user = useUser()
  const workspaceId = requireWorkspaceId(repo, 'useRootUIStateBlock')

  return use(getUIStateBlock(repo, workspaceId, user, {}))
}

export function useLayoutSessionBlock(layoutSessionId = getLayoutSessionId()): Block {
  return use(getLayoutSessionBlock(useRootUIStateBlock(), layoutSessionId))
}

export function usePanelsForLayoutSession(layoutSessionId = getLayoutSessionId()): Block[] {
  return useChildren(useLayoutSessionBlock(layoutSessionId))
}

export function useUserBlock(): Block {
  const repo = useRepo()
  const user = useUser()
  const workspaceId = requireWorkspaceId(repo, 'useUserBlock')

  return use(getUserBlock(repo, workspaceId, user))
}

/** Resolve a `userId` (as stored in `created_by` / `updated_by`) to that
 *  user's display name for attribution surfaces ("Changed by", update
 *  tooltips, …). Reads the user-page block's content — which the page's
 *  owning client keeps in sync with their name — via its deterministic
 *  id, so it works for any user whose page has synced into this
 *  workspace, not just the current one. Falls back to the raw id while
 *  the page is loading or absent (e.g. a peer who hasn't synced yet),
 *  which is exactly the prior behaviour, so the worst case degrades
 *  gracefully rather than rendering blank. */
export function useUserName(userId: string): string {
  const repo = useRepo()
  const workspaceId = requireWorkspaceId(repo, 'useUserName')
  const block = repo.block(userPageBlockId(workspaceId, userId))
  return useHandle(block, {selector: doc => doc?.content || userId})
}

/** Hook to access and modify a UI-state property on the active UI-state
 *  block. The property's schema dictates codec + default; writes are
 *  scoped via the schema's `changeScope` (typically `UiState`). */
export function useUIStateProperty<T>(
  schema: PropertySchema<T>,
): [T, (value: T) => void] {
  const block = useUIStateBlock()
  return usePropertyValue(block, requireSchemaScope(schema, ChangeScope.UiState, 'useUIStateProperty'))
}

export function useRootUIStateProperty<T>(
  schema: PropertySchema<T>,
): [T, (value: T) => void] {
  const block = useRootUIStateBlock()
  return usePropertyValue(block, requireSchemaScope(schema, ChangeScope.UiState, 'useRootUIStateProperty'))
}

/** Resolve the per-plugin user-prefs sub-block for a given type
 *  contribution. The block is bootstrapped on first access via
 *  `getPluginPrefsBlock`; subsequent calls return the same Block facade. */
export function usePluginPrefsBlock(type: TypeContribution): Block {
  const repo = useRepo()
  const user = useUser()
  const workspaceId = requireWorkspaceId(repo, 'usePluginPrefsBlock')

  return use(getPluginPrefsBlock(repo, workspaceId, user, type))
}

/** Read/write a user-pref property on the plugin's own sub-block. The
 *  schema must declare `changeScope: ChangeScope.UserPrefs` so reads and
 *  writes route through the synced (and read-only-aware) pref pipeline. */
export const usePluginPrefsProperty = <T>(
  type: TypeContribution,
  schema: PropertySchema<T>,
): [T, (value: T) => void] =>
  usePropertyValue(
    usePluginPrefsBlock(type),
    requireSchemaScope(schema, ChangeScope.UserPrefs, 'usePluginPrefsProperty'),
  )

/** Resolve the per-plugin ui-state sub-block for a given type
 *  contribution. The mirror of `usePluginPrefsBlock` for persistent
 *  per-device state — the block lives under the root ui-state subtree
 *  and never enters the upload queue. */
export function usePluginUIStateBlock(type: TypeContribution): Block {
  const repo = useRepo()
  const user = useUser()
  const workspaceId = requireWorkspaceId(repo, 'usePluginUIStateBlock')

  return use(getPluginUIStateBlock(repo, workspaceId, user, type))
}

/** Read/write a ui-state property on the plugin's own ui-state
 *  sub-block. The schema must declare `changeScope: ChangeScope.UiState`
 *  so writes route into the device-local ui-state subtree (and stay
 *  undo-segregated from document edits). They still upload through the
 *  normal queue. */
export const usePluginUIStateProperty = <T>(
  type: TypeContribution,
  schema: PropertySchema<T>,
): [T, (value: T) => void] =>
  usePropertyValue(
    usePluginUIStateBlock(type),
    requireSchemaScope(schema, ChangeScope.UiState, 'usePluginUIStateProperty'),
  )

/** Sugar for the global editing flag — `[isEditing, setIsEditing]`. */
export const useIsEditing = (): [boolean, (value: boolean) => void] =>
  useUIStateProperty(isEditingProp)

/** Selection state — sticky on the UI-state block. The setter merges
 *  partial updates into the current snapshot. */
export function useSelectionState(): [
  BlockSelectionState,
  (newState: Partial<BlockSelectionState>) => void,
] {
  const uiStateBlock = useUIStateBlock()
  const [current, setRaw] = usePropertyValue(uiStateBlock, selectionStateProp)

  const setSelectionState = useCallback(
    (newState: Partial<BlockSelectionState>) => {
      setRaw({...current, ...newState})
    },
    [current, setRaw],
  )

  return [current, setSelectionState]
}

export const useInFocus = (blockId: string, explicitRenderScopeId?: string): boolean => {
  const context = useBlockContext()
  const renderScopeId = explicitRenderScopeId
    ?? (typeof context.renderScopeId === 'string' ? context.renderScopeId : undefined)
  return useHandle(useUIStateBlock(), {
    selector: doc => {
      const location = focusedBlockLocationFromProperties(doc?.properties)
      if (!location || location.blockId !== blockId) return false
      return renderScopeId ? location.renderScopeId === renderScopeId : true
    },
  })
}

export const useIsSelected = (blockId: string): boolean =>
  useHandle(useUIStateBlock(), {
    selector: doc => {
      const stored = doc?.properties[selectionStateProp.name]
      if (stored === undefined) return false
      const sel = selectionStateProp.codec.decode(stored)
      return sel.selectedBlockIds.includes(blockId)
    },
  })

export const useInEditMode = (blockId: string, explicitRenderScopeId?: string): boolean => {
  const context = useBlockContext()
  const renderScopeId = explicitRenderScopeId
    ?? (typeof context.renderScopeId === 'string' ? context.renderScopeId : undefined)
  // Combined into a single selector returning a per-block boolean so
  // unaffected DefaultBlockRenderer instances bail out via
  // useSyncExternalStore's Object.is check on focus changes. Splitting
  // it into two `useHandle` calls (one returning the global focused location,
  // one returning the editing flag) made every subscriber re-render on
  // every focus change because the focused-id value changed for all
  // subscribers, not just the two whose membership in "is focused" flipped.
  return useHandle(useUIStateBlock(), {
    selector: doc => {
      const location = focusedBlockLocationFromProperties(doc?.properties)
      if (!location || location.blockId !== blockId) return false
      if (renderScopeId && location.renderScopeId !== renderScopeId) return false
      return Boolean(doc?.properties[isEditingProp.name])
    },
  })
}

/**
 * Whether `panelBlock` is the currently-active panel in its layout
 * session. Per-panel boolean (same selector pattern as `useInFocus`):
 * when activePanelId hops between panels, only the two whose membership
 * flips re-render — the rest bail via `useSyncExternalStore`'s Object.is.
 *
 * When the panel renders OUTSIDE a layout session (no
 * `layoutSessionBlockId` in context — e.g. a standalone embedded or
 * preview surface) the concept of "active panel" doesn't apply, so we
 * return `true`. Consumers that gate UI on "this surface owns
 * keystrokes" treat non-layout surfaces as trivially active.
 */
export const useIsActivePanel = (panelBlock: Block): boolean => {
  const context = useBlockContext()
  const repo = useRepo()
  const layoutSessionBlockId = typeof context.layoutSessionBlockId === 'string'
    ? context.layoutSessionBlockId
    : null
  const subscriptionTarget = layoutSessionBlockId ? repo.block(layoutSessionBlockId) : panelBlock
  return useHandle(subscriptionTarget, {
    selector: doc =>
      layoutSessionBlockId === null
      || doc?.properties[activePanelIdProp.name] === panelBlock.id,
  })
}
