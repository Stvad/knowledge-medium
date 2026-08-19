import { useCallback, useMemo, useState, type FocusEvent, type SyntheticEvent } from 'react'
import { usePropertyEditingShortcuts } from '@/shortcuts/useActionContext.js'
import type { PropertyEditingField } from '@/shortcuts/types.js'
import { isImeKeyEvent, isPropertyEditingField } from '@/shortcuts/utils.js'
import { Block } from '@/data/block'

interface PropertyEditingFocusHandlers {
  onFocus: (event: FocusEvent<HTMLElement>) => void
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
 *
 * `PropertyRow` puts these on the value cell, so every value editor is
 * activated by the row — including one a plugin registered, whose author
 * never saw this hook. The built-in editors also call it on their own input;
 * that's redundant rather than load-bearing (the row's activation carries the
 * same block and the same focused element, so it dedupes), and it can be
 * collapsed into the row wiring whenever someone wants to.
 */
export function usePropertyEditingActivation(block: unknown): PropertyEditingFocusHandlers {
  const targetBlock = block instanceof Block ? block : null
  const [input, setInput] = useState<PropertyEditingField | null>(null)
  // `targetBlock!` / `input!` are lies when either is null, but `enabled`
  // is false in that case so `useActionContextActivations` filters the
  // activation out before any dependency read.
  const dependencies = useMemo(
    () => ({block: targetBlock!, input: input!}),
    [targetBlock, input],
  )
  usePropertyEditingShortcuts(dependencies, targetBlock !== null && input !== null)

  // `target`, not `currentTarget`: React focus events carry focusin/focusout
  // semantics, so these handlers work on a CONTAINER as well as on the field
  // itself — which is how the property row activates for an editor it doesn't
  // know the shape of. On a field they are the same element.
  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    setInput(isPropertyEditingField(event.target) ? event.target : null)
  }, [])
  const onBlur = useCallback(() => setInput(null), [])

  return {onFocus, onBlur}
}

/**
 * Claim an Escape keypress for a property field's own dismissable UI — an
 * open suggestion dropdown, an add-row that can be cancelled — so it does
 * NOT also reach `exit_property_editing`, which blurs the field.
 *
 * `stopPropagation` is the load-bearing half: the shortcut coordinator
 * listens on `window`, below which React's synthetic handlers run, and it
 * does not consult `defaultPrevented`. Stopping the native event there is
 * what keeps "Escape closes the dropdown, focus stays in the field" from
 * also becoming "…and the field blurs".
 *
 * Call this ONLY when there was something to dismiss. With nothing open,
 * let the event through — Escape exiting the field is the point.
 *
 * The stop is unconditional, including from a picker rendered outside the
 * property panel (`ReferenceSearch` with `propertyField` false, e.g. inside a
 * dialog). That's harmless today rather than intended: Radix dialogs take
 * Escape on a document CAPTURE listener, which has already run by the time
 * this bubble-phase handler fires, and no bubble-phase window Escape listener
 * exists outside the shortcut coordinator. Add such a listener and this would
 * swallow it while the dropdown is open — gate on `propertyField` then.
 */
export const consumeFieldEscape = (event: SyntheticEvent): void => {
  event.preventDefault()
  event.stopPropagation()
}

/**
 * The whole Escape rule for a property field's own dismissable UI, in one
 * place: dismiss what's actually open and claim the key, or report that
 * nothing was claimed so the press falls through to `exit_property_editing`.
 * Pass `undefined`/`false` for "nothing to dismiss".
 *
 * Declines while an IME composition is in flight. Escape belongs to the
 * input method there — it drops the pending candidate — and consuming it
 * would both eat the character and hide the key from the coordinator. Every
 * field routes through here so a new editor can't reintroduce that by
 * hand-rolling `consumeFieldEscape`.
 */
export const dismissOnFieldEscape = (
  event: SyntheticEvent,
  dismiss: (() => void) | false | undefined,
): boolean => {
  if (!dismiss) return false
  if (isImeKeyEvent(event.nativeEvent as Partial<KeyboardEvent>)) return false
  consumeFieldEscape(event)
  dismiss()
  return true
}
