import { useCallback, useEffect, useState, type FocusEvent } from 'react'
import { useActiveContextsDispatchOptional } from '@/shortcuts/ActiveContexts.js'
import {
  ActionContextTypes,
  type BaseShortcutDependencies,
  type PropertyEditingDependencies,
} from '@/shortcuts/types.js'
import { Block } from '@/data/block'

interface PropertyEditingFocusHandlers {
  onFocus: (event: FocusEvent<HTMLInputElement>) => void
  onBlur: () => void
}

/**
 * Activate the `PROPERTY_EDITING` shortcut context while the returned
 * handlers' input has focus. PROPERTY_EDITING is `modal: true`, so once
 * active it shadows underlying block-scoped bindings — typing into a
 * property input no longer fires vim-normal-mode's `shift+p` / `cmd+d`
 * etc. on the surrounding block. Deactivates on blur.
 *
 * Accepts `unknown` for `block` so per-shape editor signatures
 * (`PropertyEditorProps.block: unknown`) can call this hook without
 * narrowing at every call site. When `block` isn't a `Block` instance
 * the hook stays inert.
 *
 * Stays inert when no `ActiveContextsProvider` is mounted (isolated
 * component tests, storybook). Goes through the dispatch directly
 * instead of `usePropertyEditingShortcuts` to avoid pulling in `useRepo`
 * via `useUIStateBlock` for every component that renders a property
 * input — the `block` we already have doubles as `uiStateBlock` for the
 * deps validator's purposes (it just requires `Block` instances).
 *
 * Inputs already wired with their own `onFocus`/`onBlur` should compose
 * with these handlers — call both, the order doesn't matter.
 */
export function usePropertyEditingActivation(block: unknown): PropertyEditingFocusHandlers {
  const targetBlock = block instanceof Block ? block : null
  const dispatch = useActiveContextsDispatchOptional()
  const [input, setInput] = useState<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!dispatch || !targetBlock || !input) return
    const deps: PropertyEditingDependencies = {
      block: targetBlock,
      input,
      uiStateBlock: targetBlock,
    }
    dispatch.activate(
      ActionContextTypes.PROPERTY_EDITING,
      deps as BaseShortcutDependencies,
    )
    return () => dispatch.deactivate(ActionContextTypes.PROPERTY_EDITING)
  }, [dispatch, targetBlock, input])

  const onFocus = useCallback((event: FocusEvent<HTMLInputElement>) => {
    setInput(event.currentTarget)
  }, [])
  const onBlur = useCallback(() => setInput(null), [])

  return {onFocus, onBlur}
}
