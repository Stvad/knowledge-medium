/**
 * UI-state plumbing — per-user "user page" + per-panel ui-state child
 * tree, plus the React hooks that read/write properties on those
 * blocks. Persists app-shell state (focus, selection, edit-mode,
 * recents, top-level block) inside the same block tree as content,
 * scoped to `ChangeScope.UiState` so the writes are routed to local-
 * ephemeral storage and never enter the upload queue.
 *
 * Migration note (1.6): legacy callers used `repo.find(...)` /
 * `block.childByContent(name, createIfMissing, {scope})` /
 * `block.change(callback)` — all gone. The new shape composes with:
 *   - `repo.block(id)` for a Block facade (sync, identity-stable)
 *   - `repo.load(id, {...})` to populate cache neighborhoods
 *   - `repo.tx(fn, {scope: ChangeScope.UiState})` for writes
 *   - `tx.createOrGet({id, ...})` for idempotent bootstrap
 * Deterministic ids derived from (workspace, user, ...) keep two
 * offline clients converging on the same row when they later sync.
 */

import { use, useCallback } from 'react'
import { useBlockContext } from '@/context/block.tsx'
import { useUser } from '@/components/Login.tsx'
import { useRepo } from '@/context/repo.tsx'
import { memoize } from 'lodash'
import { v5 as uuidv5 } from 'uuid'
import {
  ChangeScope,
  type PropertySchema,
  type User,
} from '@/data/api'
import { Block } from './block'
import type { Repo } from './repo'
import type { BlockContextType } from '@/types'
import {
  aliasesProp,
  selectionStateProp,
  type BlockSelectionState,
  focusedBlockIdProp,
  isEditingProp,
} from '@/data/properties'
import { usePropertyValue, useHandle } from '@/hooks/block'

/**
 * One of core principles of the system is to store all state within the system.
 */

// ──── Deterministic-id namespaces ────

// Per-user "user page" — parent-less alias-bearing block hosting the
// user's UI-state subtree for a given workspace. Same pattern as
// DAILY_NOTE_NS: two offline clients converge on the same row when
// they sync, so we never end up with duplicate user pages.
const USER_PAGE_NS = '4d9d2a73-3e5a-4f43-95e3-2a76b1b7e6d7'
// Per-(parent, content) UI-state child — used by the bootstrap below
// (ui-state, panels, panel/main, etc.) so each name resolves to the
// same block id across clients.
const UI_CHILD_NS = '8f6c2c84-1c12-4e4a-8b9e-9b0f87a7e1d2'

const userPageBlockId = (workspaceId: string, userId: string): string =>
  uuidv5(`${workspaceId}:${userId}`, USER_PAGE_NS)

const uiChildBlockId = (parentId: string, content: string): string =>
  uuidv5(`${parentId}:${content}`, UI_CHILD_NS)

// ──── Helpers ────

const requireWorkspaceId = (repo: Repo, caller: string): string => {
  const workspaceId = repo.activeWorkspaceId
  if (!workspaceId) {
    throw new Error(`${caller} requires an active workspace; call repo.setActiveWorkspaceId() first`)
  }
  return workspaceId
}

/** Idempotent UI-state child creation. Returns the Block facade for
 *  the child whose content equals `content` under `parent`. The id
 *  comes from `uiChildBlockId(parentId, content)` so repeat calls hit
 *  the same row deterministically. Restores soft-deleted rows in the
 *  same scope. */
const ensureUiChild = async (
  repo: Repo,
  parent: Block,
  content: string,
): Promise<Block> => {
  const parentData = parent.peek() ?? await parent.load()
  if (!parentData) throw new Error(`ensureUiChild: parent ${parent.id} not loaded`)
  const childId = uiChildBlockId(parent.id, content)

  await repo.tx(async tx => {
    const existing = await tx.get(childId)
    if (existing && !existing.deleted) {
      return
    }
    if (existing && existing.deleted) {
      await tx.restore(childId, {content})
      return
    }
    // Fresh insert. Use 'a0' as a starter order key — fine because
    // UI-state children don't compete for ordering with other
    // siblings beyond the bootstrap bucket; if we ever add multiple
    // ui-state children with stable order, swap to keyAtEnd.
    await tx.create({
      id: childId,
      workspaceId: parentData.workspaceId,
      parentId: parent.id,
      orderKey: 'a0',
      content,
    })
  }, {scope: ChangeScope.UiState})

  return repo.block(childId)
}

// ──── Bootstrap blocks ────

/** Per-user "user page" block — created (or restored) on first access.
 *  The alias matches the user's display name so QuickFind / wiki-link
 *  resolution can target it directly. Memoized per (repo, workspaceId,
 *  userId) — `use()` requires a stable promise per render.
 *
 *  The fast path uses `repo.load` to skip the tx entirely when the row
 *  is already live in cache or in SQL. Tombstone branch lives INSIDE
 *  the tx because `repo.load` filters `deleted = 0` (so tombstones
 *  always come back as `null`); we have to use `tx.get` to see them. */
export const getUserBlock = memoize(
  async (repo: Repo, workspaceId: string, user: User): Promise<Block> => {
    const id = userPageBlockId(workspaceId, user.id)
    const live = await repo.load(id)
    if (live && !live.deleted) return repo.block(id)

    // User.name is optional in the data-layer User shape; fall back
    // to the id so the user-page block always has *some* content
    // and an addressable alias.
    const displayName = user.name ?? user.id

    await repo.tx(async tx => {
      // Re-read inside the tx with the unfiltered `tx.get` so we see
      // tombstones. (`repo.load` returned null in that case, so the
      // outer `live` is no signal here.) Three outcomes:
      //   1. live row appeared between load and tx open  → no-op
      //   2. tombstoned row                              → restore
      //   3. truly missing                               → create
      const existing = await tx.get(id)
      if (existing && !existing.deleted) return
      if (existing && existing.deleted) {
        await tx.restore(id, {content: displayName})
        await tx.setProperty(id, aliasesProp, [displayName])
        return
      }
      await tx.create({
        id,
        workspaceId,
        parentId: null,
        orderKey: 'a0',
        content: displayName,
        properties: {[aliasesProp.name]: aliasesProp.codec.encode([displayName])},
      })
    }, {scope: ChangeScope.UiState})

    return repo.block(id)
  },
  (repo, workspaceId, user) => `${repoIdentity(repo)}:${workspaceId}:${user.id}`,
)

/** Resolve the UI-state block scoped to the current panel context.
 *  In a panel context (`context.panelId`), returns the panel's own
 *  block — per-panel UI state lives directly on it. Outside a panel,
 *  returns the user-level `ui-state` child of the user page. */
export const getUIStateBlock = memoize(
  async (
    repo: Repo,
    workspaceId: string,
    user: User,
    context: BlockContextType,
  ): Promise<Block> => {
    if (context.panelId) {
      await repo.load(context.panelId)
      return repo.block(context.panelId)
    }

    const userBlock = await getUserBlock(repo, workspaceId, user)
    return ensureUiChild(repo, userBlock, 'ui-state')
  },
  (repo, workspaceId, user, context) =>
    `${repoIdentity(repo)}:${workspaceId}:${user.id}:${context.panelId ?? '__root__'}`,
)

const PANELS_PATH_PART = 'panels'
export const getPanelsBlock = memoize(
  async (uiStateBlock: Block): Promise<Block> =>
    ensureUiChild(uiStateBlock.repo, uiStateBlock, PANELS_PATH_PART),
  (uiBlock) => `${repoIdentity(uiBlock.repo)}:${uiBlock.id}`,
)

export const MAIN_PANEL_NAME = 'main'

export const isMainPanel = (panel: Block): boolean =>
  panel.peek()?.content === MAIN_PANEL_NAME

// ──── React hooks ────

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

/** Hook to access and modify a UI-state property on the active UI-state
 *  block. The property's schema dictates codec + default; writes are
 *  scoped via the schema's `changeScope` (typically `UiState`). */
export function useUIStateProperty<T>(
  schema: PropertySchema<T>,
): [T, (value: T) => void] {
  const block = useUIStateBlock()
  return usePropertyValue(block, schema)
}

export const useUserProperty = <T>(
  schema: PropertySchema<T>,
): [T, (value: T) => void] => usePropertyValue(useUserBlock(), schema)

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

/** Sync selection-state read; doesn't subscribe — for use in
 *  imperative shortcut handlers. Returns the schema default when
 *  nothing's stored. */
export const getSelectionStateSnapshot = (uiStateBlock: Block): BlockSelectionState =>
  uiStateBlock.peekProperty(selectionStateProp) ?? selectionStateProp.defaultValue

export const resetBlockSelection = async (uiStateBlock: Block): Promise<void> => {
  const current = uiStateBlock.peekProperty(selectionStateProp)
  if (!current?.selectedBlockIds.length && !current?.anchorBlockId) return
  await uiStateBlock.set(selectionStateProp, {selectedBlockIds: [], anchorBlockId: null})
}

export const useInFocus = (blockId: string): boolean =>
  useHandle(useUIStateBlock(), {
    selector: doc => doc?.properties[focusedBlockIdProp.name] === blockId,
  })

export const useIsSelected = (blockId: string): boolean =>
  useHandle(useUIStateBlock(), {
    selector: doc => {
      const stored = doc?.properties[selectionStateProp.name]
      if (stored === undefined) return false
      const sel = selectionStateProp.codec.decode(stored)
      return sel.selectedBlockIds.includes(blockId)
    },
  })

export const useInEditMode = (blockId: string): boolean =>
  // Combined into a single selector returning a per-block boolean so
  // unaffected DefaultBlockRenderer instances bail out via
  // useSyncExternalStore's Object.is check on focus changes. Splitting
  // it into two `useHandle` calls (one returning the global focused id,
  // one returning the editing flag) made every subscriber re-render on
  // every focus change because the focused-id value changed for all
  // subscribers, not just the two whose membership in "is focused" flipped.
  useHandle(useUIStateBlock(), {
    selector: doc =>
      doc?.properties[focusedBlockIdProp.name] === blockId &&
      Boolean(doc?.properties[isEditingProp.name]),
  })

// ──── Internal: shorthand for instance-scoped memo keys ────
const repoIdentity = (repo: Repo): number => repo.instanceId
