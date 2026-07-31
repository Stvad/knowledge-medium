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
import { useActiveWorkspaceId } from '@/hooks/useWorkspaces.js'
import {
  ChangeScope,
  isSystemAuthor,
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
import {
  getLayoutSessionBlock,
  getPluginPrefsBlock,
  getPluginUIStateBlock,
  getPluginUIStateChild,
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

export function useLayoutSessionBlock(layoutSessionId?: string): Block {
  const repo = useRepo()
  return use(getLayoutSessionBlock(useRootUIStateBlock(), layoutSessionId ?? repo.activeLayoutSessionId))
}

export function usePanelsForLayoutSession(layoutSessionId?: string): Block[] {
  return useChildren(useLayoutSessionBlock(layoutSessionId))
}

export function useUserBlock(): Block {
  const repo = useRepo()
  const user = useUser()
  // `useActiveWorkspaceId` re-renders this hook on a workspace switch (via its
  // hash subscription) while resolving the *committed* active workspace (the
  // pin) — so persistent surfaces that hold the user block (the left sidebar's
  // shortcuts) follow a switch instead of staying pinned to the previous
  // workspace, without ever resolving a not-yet-validated URL workspace (which
  // would have getUserBlock write a user-page row into it). The pin alone is
  // non-reactive, so reading it without the subscription left those surfaces
  // stale after a switch.
  const workspaceId = useActiveWorkspaceId()
  if (!workspaceId) {
    throw new Error('useUserBlock requires an active workspace')
  }

  return use(getUserBlock(repo, workspaceId, user))
}

/** Resolve a `userId` (as stored in `created_by` / `updated_by`) to its
 *  user page: the display name plus — only when the page block actually
 *  exists in this workspace — its block id, so callers can link to it.
 *
 *  Reads the user-page block's content (which the page's owning client
 *  keeps in sync with their name) via its deterministic id, so it works
 *  for any user whose page has synced here, not just the current one.
 *  While the page is loading or absent (e.g. a peer who hasn't synced
 *  yet) `name` falls back to the raw id and `blockId` is omitted — so
 *  attribution degrades to the prior plain-text behaviour rather than
 *  rendering a link to a block that doesn't exist. */
export function useUserPage(userId: string, workspaceId?: string): {name: string; blockId?: string} {
  const repo = useRepo()
  // Resolve against the caller-supplied workspace when given (attribution for
  // a block whose workspace may not be the active one — e.g. a non-modal info
  // dialog left open across a workspace switch), else the active workspace.
  const resolvedWorkspaceId = workspaceId ?? requireWorkspaceId(repo, 'useUserPage')
  const id = userPageBlockId(resolvedWorkspaceId, userId)
  const block = repo.block(id)
  const resolved = useHandle(block, {
    selector: doc => doc
      ? {name: doc.content || userId, blockId: id}
      : {name: userId},
  })
  // A system author (`system:<userId>`, written to `updated_by` on a pristine
  // deterministic-id mint) is not a user — render it as "System" with no link
  // rather than leaking the raw prefixed id into attribution surfaces. (The
  // useHandle subscription above runs unconditionally per the rules of hooks;
  // its result is simply unused for system authors.)
  if (isSystemAuthor(userId)) return {name: 'System'}
  return resolved
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
 *  ui-state — the block lives under the root ui-state subtree. Like all
 *  `ChangeScope.UiState` writes it is non-undoable but still uploads and
 *  syncs through the normal queue, so the state is restored across
 *  devices (a deliberate uniform-substrate decision). */
export function usePluginUIStateBlock(type: TypeContribution): Block {
  const repo = useRepo()
  const user = useUser()
  const workspaceId = requireWorkspaceId(repo, 'usePluginUIStateBlock')

  return use(getPluginUIStateBlock(repo, workspaceId, user, type))
}

/** Resolve a per-`key` child of the plugin's ui-state sub-block, for
 *  plugins that partition their ui-state (e.g. one frozen review session
 *  per deck, keyed by deck id) instead of overloading a single block. The
 *  child is bootstrapped on first access. */
export function usePluginUIStateChildBlock(type: TypeContribution, key: string): Block {
  return use(getPluginUIStateChild(usePluginUIStateBlock(type), key))
}

/** Read/write a ui-state property on the plugin's own ui-state
 *  sub-block. The schema must declare `changeScope: ChangeScope.UiState`
 *  so writes route into the ui-state subtree (and stay undo-segregated
 *  from document edits). They still upload and sync through the normal
 *  queue. */
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
