/**
 * Key interception for the shortcut-help overlay.
 *
 * While the overlay is open a capture-phase window listener swallows every
 * keydown/keyup (`stopPropagation` before the coordinator's bubble-phase
 * listeners, `preventDefault` against native fallbacks), so pressing a
 * chord INSPECTS it instead of running it — including chords the modal
 * shadowing would otherwise let through (global Cmd+K etc.). This is the
 * same "raw window listener for a keyboard-capture surface" pattern the
 * reconciler's hold-binding observer uses; it is not a new UI event bus.
 *
 * Pressed chords accumulate into a sequence buffer matched via
 * `matchPressedSequence`: exact completions surface as `matches`, live
 * prefixes narrow the overlay to `pendingMatches` (which-key), and a chord
 * bound to nothing flashes as `unmatched`. Escape clears any of that
 * first, then closes the overlay.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  chordFromEvent,
  isMacPlatform,
  isModifierOnly,
} from '@/plugins/keybindings-settings/keyCapture.ts'
import { withRecoveredLetterKey } from '@/shortcuts/utils.js'
import { matchPressedSequence, type HelpBinding } from './model.ts'

export interface InspectorState {
  /** Canonical chords pressed so far that form a live sequence prefix. */
  readonly pressed: readonly string[]
  /** Exact matches of the last completed lookup, best-first. */
  readonly matches: readonly HelpBinding[] | null
  /** Bindings the pressed buffer is a prefix of (narrows the list). */
  readonly pendingMatches: readonly HelpBinding[] | null
  /** Chord buffer that matched nothing (feedback until the next press). */
  readonly unmatched: readonly string[] | null
  /** Modifier-only preview ('$mod+Shift') while modifiers are held. */
  readonly partial: string | null
}

const EMPTY: InspectorState = {
  pressed: [],
  matches: null,
  pendingMatches: null,
  unmatched: null,
  partial: null,
}

export interface KeyInspector {
  readonly state: InspectorState
  /** Show the detail panel for a binding picked by pointer instead of keys. */
  readonly selectBinding: (binding: HelpBinding) => void
  readonly reset: () => void
}

/** Mirrors `chordFromEvent`'s $mod/Control/Meta normalisation for the
 *  held-modifier preview (same shape KeyCaptureInput shows). */
const modifierPreview = (event: KeyboardEvent): string | null => {
  const onMac = isMacPlatform()
  const primary = onMac ? event.metaKey : event.ctrlKey
  const secondary = onMac ? event.ctrlKey : event.metaKey
  const parts: string[] = []
  if (primary) parts.push('$mod')
  if (secondary) parts.push(onMac ? 'Control' : 'Meta')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  return parts.length ? parts.join('+') : null
}

export const useKeyInspector = (
  open: boolean,
  bindings: readonly HelpBinding[],
  onClose: () => void,
): KeyInspector => {
  const [state, setState] = useState<InspectorState>(EMPTY)
  // The keydown handler needs the CURRENT buffer synchronously (to decide
  // clear-vs-close on Escape and to extend the sequence), so mirror state
  // into a ref rather than smuggling side effects into setState updaters.
  // Written in a layout effect (not during render) per the react-hooks/refs
  // rule; key events fire after commit, so the ref is current by then.
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

  // Reset synchronously during render when the overlay opens/closes —
  // setState in the effect body below would be the cascading-render
  // anti-pattern `react-hooks/set-state-in-effect` forbids.
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    setState(EMPTY)
  }

  useEffect(() => {
    if (!open) return

    const onKeydown = (rawEvent: KeyboardEvent): void => {
      // Swallow everything: inspection replaces dispatch while open.
      rawEvent.preventDefault()
      rawEvent.stopPropagation()
      if (rawEvent.repeat) return

      const event = withRecoveredLetterKey(rawEvent)
      if (isModifierOnly(event)) {
        const partial = modifierPreview(event)
        setState(s => ({...s, partial}))
        return
      }

      if (event.key === 'Escape') {
        const s = stateRef.current
        const dirty = s.pressed.length > 0 || s.matches || s.pendingMatches || s.unmatched || s.partial
        if (dirty) setState(EMPTY)
        else onClose()
        return
      }

      const chord = chordFromEvent(event)
      if (!chord) return
      const nextPressed = [...stateRef.current.pressed, chord]
      const {exact, pending} = matchPressedSequence(bindings, nextPressed)
      if (exact.length === 0 && pending.length === 0) {
        setState({...EMPTY, unmatched: nextPressed})
        return
      }
      setState({
        pressed: pending.length > 0 ? nextPressed : [],
        matches: exact.length > 0 ? exact : null,
        pendingMatches: pending.length > 0 ? pending : null,
        unmatched: null,
        partial: null,
      })
    }

    const onKeyup = (event: KeyboardEvent): void => {
      // Keep keyup-phase bindings from firing off releases we captured.
      event.stopPropagation()
      if (isModifierOnly(event)) {
        setState(s => (s.partial ? {...s, partial: null} : s))
      }
    }

    window.addEventListener('keydown', onKeydown, {capture: true})
    window.addEventListener('keyup', onKeyup, {capture: true})
    return () => {
      window.removeEventListener('keydown', onKeydown, {capture: true})
      window.removeEventListener('keyup', onKeyup, {capture: true})
    }
  }, [open, bindings, onClose])

  const selectBinding = useCallback((binding: HelpBinding) => {
    setState({...EMPTY, matches: [binding]})
  }, [])

  const reset = useCallback(() => setState(EMPTY), [])

  return {state, selectBinding, reset}
}
