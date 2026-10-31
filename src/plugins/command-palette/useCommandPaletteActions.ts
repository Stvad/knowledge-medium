import { useLayoutEffect, useState } from 'react'
import { useActionDiscovery } from '@/shortcuts/useActionDiscovery.js'
import type {
  ActionConfig,
  ActiveContextInfo,
  ShortcutBinding,
} from '@/shortcuts/types.js'
import {
  COMMAND_PALETTE_ACTION_ID,
  COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
} from './context.ts'
import { withSelection, type SavedSelection } from './selection.ts'

// Hide the palette-opening actions from the palette's own list. Both
// would just toggle the dialog when selected (the block variant also
// re-focuses the already-focused block) — a confusing no-op surface.
const PALETTE_HIDDEN_FROM_PALETTE = new Set<string>([
  COMMAND_PALETTE_ACTION_ID,
  COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
])

export interface CommandPaletteActionsResult {
  actions: readonly ActionConfig[]
  activeContexts: ActiveContextInfo[]
  bindingsFor: (action: Pick<ActionConfig, 'context' | 'id'>) => readonly ShortcutBinding[]
}

export function useCommandPaletteActions(selection?: SavedSelection | null): CommandPaletteActionsResult {
  const {actions: allActions, active, activeContexts, bindingsFor} = useActionDiscovery()

  const [actions, setActions] = useState<readonly ActionConfig[]>([])

  // Selection restoration mutates the DOM, so predicates run after commit,
  // outside React render. Keep the search input's selection between reads.
  useLayoutEffect(() => {
    const visibleActions = () => allActions.filter(action => {
      if (!active.has(action.context)) return false
      if (PALETTE_HIDDEN_FROM_PALETTE.has(action.id)) return false
      if (!action.isVisible) return true
      // The shortcut system stores the active context's dependencies
      // exactly as the handler will receive them, so isVisible can run
      // against them directly. An action whose isVisible returns false
      // would silently no-op if shown — hide it instead.
      const deps = active.get(action.context)
      if (!deps) return true
      return action.isVisible(deps as never)
    })
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM selection predicates must run after commit.
    setActions(selection === undefined ? visibleActions() : withSelection(selection, visibleActions))
  }, [allActions, active, selection])

  return {actions, activeContexts, bindingsFor}
}
