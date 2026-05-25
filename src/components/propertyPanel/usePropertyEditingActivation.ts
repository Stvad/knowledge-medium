import { useCallback, useMemo, useState, type FocusEvent } from 'react'
import { usePropertyEditingShortcuts } from '@/shortcuts/useActionContext.js'
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
 * activation is skipped (the standard hook chain's `enabled=false` path).
 *
 * Inputs already wired with their own `onFocus`/`onBlur` should compose
 * with these handlers — call both, the order doesn't matter.
 */
export function usePropertyEditingActivation(block: unknown): PropertyEditingFocusHandlers {
  const targetBlock = block instanceof Block ? block : null
  const [input, setInput] = useState<HTMLInputElement | null>(null)
  // `targetBlock!` / `input!` are lies when either is null, but `enabled`
  // is false in that case so `useActionContextActivations` filters the
  // activation out before any dependency read.
  const dependencies = useMemo(
    () => ({block: targetBlock!, input: input!}),
    [targetBlock, input],
  )
  usePropertyEditingShortcuts(dependencies, targetBlock !== null && input !== null)

  const onFocus = useCallback((event: FocusEvent<HTMLInputElement>) => {
    setInput(event.currentTarget)
  }, [])
  const onBlur = useCallback(() => setInput(null), [])

  return {onFocus, onBlur}
}
