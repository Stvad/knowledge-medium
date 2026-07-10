/**
 * Key interception for the shortcut-help overlay.
 *
 * While the overlay is open a capture-phase window listener swallows every
 * keydown (`stopPropagation` before the coordinator's bubble-phase
 * listeners, `preventDefault` against native fallbacks), so pressing a
 * chord INSPECTS it instead of running it — including chords the modal
 * shadowing would otherwise let through (global Cmd+K etc.). This is the
 * same "raw window listener for a keyboard-capture surface" pattern the
 * reconciler's hold-binding observer uses; it is not a new UI event bus.
 *
 * Keyups are swallowed ONLY for keys pressed while the overlay was open.
 * A release of a key held from BEFORE opening propagates on purpose: it
 * terminates a gesture already in flight — a `phase: 'keyup'` commit (date
 * scrub) or a hold observer's cancel-on-release — which would otherwise
 * wedge. Armed-but-unfired hold timers can't be cancelled by a keyup we
 * never see, so opening also cancels them explicitly via the reconciler's
 * hold registry.
 *
 * Each binding gets its OWN `createSequenceMatcher` — the same per-binding
 * sequence matcher the dispatcher installs, so a verdict here is the verdict
 * dispatch would reach. Every inspected keydown is fed to all matchers:
 * completions surface as `matches`, matchers left mid-sequence narrow the
 * overlay to `pendingMatches` (which-key), and a chord bound to nothing
 * flashes as `unmatched`. Per-binding state is what lets `g` then `$mod+k`
 * open the palette (the `g g` matcher resets while the palette matches fresh)
 * without the old drop-oldest buffer retry. Escape clears any of that first,
 * then closes. The matchers use an infinite timeout — the popup holds a
 * sequence prefix so you can read its continuations, where the dispatcher
 * would time out after ~1s.
 *
 * One escape hatch from the swallow: the platform copy chord with a live
 * text selection keeps its native default, so the handler-source panel is
 * copyable.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  chordFromEvent,
  isMacPlatform,
  isModifierOnly,
  modifierPreview,
} from '@/plugins/keybindings-settings/keyCapture.ts'
import { cancelArmedHolds } from '@/shortcuts/holdRegistry.js'
import { createSequenceMatcher, type SequenceMatcher } from '@/shortcuts/sequenceMatcher.js'
import { withRecoveredLetterKey } from '@/shortcuts/utils.js'
import type { HelpBinding } from './model.ts'

/** One captured press: the (recovered) event for matching, and its
 *  canonical chord string for display. */
export interface PressedKey {
  readonly event: KeyboardEvent
  readonly display: string
}

export interface InspectorState {
  /** Presses so far that form a live sequence prefix. */
  readonly pressed: readonly PressedKey[]
  /** Exact matches of the last completed lookup, best-first. */
  readonly matches: readonly HelpBinding[] | null
  /** Bindings the pressed buffer is a prefix of (narrows the list). */
  readonly pendingMatches: readonly HelpBinding[] | null
  /** Chords (display form) that matched nothing — feedback until the next press. */
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
}

/** Rebind-capture mode. When supplied (non-null), the next chord the user
 *  presses is NOT inspected — it's resolved to a tinykeys chord string and
 *  handed to `onChord` (Escape → `onCancel`). Same swallow rules as
 *  inspection, so the chord being captured can't fire the action it's about
 *  to be bound to. Read through a ref so toggling capture doesn't
 *  re-subscribe the window listeners mid-hold. */
export interface CaptureMode {
  readonly onChord: (chord: string) => void
  readonly onCancel: () => void
}

/** The platform copy chord (⌘C / Ctrl+C), with no other modifiers. */
const isCopyChord = (event: KeyboardEvent): boolean =>
  event.key.toLowerCase() === 'c' &&
  !event.shiftKey && !event.altKey &&
  (isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)

const hasTextSelection = (): boolean => {
  const selection = window.getSelection()
  return Boolean(selection && !selection.isCollapsed)
}

/** Stable physical id for pairing a keyup with its keydown. `code` is
 *  layout- and modifier-independent; `key` is the fallback where `code`
 *  is unavailable (some test environments). */
const physicalKeyId = (event: KeyboardEvent): string => event.code || event.key

const OVERLAY_CONTROL_SELECTOR =
  'button, [role="button"], a[href], summary, input, select, textarea'

const DIALOG_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'

/** Keys that operate the dialog's OWN focus/controls rather than naming a
 *  shortcut: unmodified Tab/Shift+Tab (focus traversal within the modal)
 *  always, and unmodified Enter/Space when a focusable control holds focus.
 *  These are handled explicitly (not passed through) so the Rebind/Reset/
 *  Cancel buttons and the handler-source `<summary>` are keyboard-operable
 *  WITHOUT the still-live app coordinator also seeing them. Modified variants
 *  ($mod+Enter, Ctrl+Tab, …) fall through to normal inspection — they don't
 *  activate a control anyway. Not consulted in capture mode: there every key
 *  is a candidate chord. */
const isOverlayControlKey = (event: KeyboardEvent): boolean => {
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  if (event.key === 'Tab') return true
  if (event.shiftKey) return false
  if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return false
  const target = event.target
  return target instanceof HTMLElement && target.closest(OVERLAY_CONTROL_SELECTOR) !== null
}

/** The open dialog containing the event target (falls back to the first
 *  dialog on the page when focus sits on a non-dialog node). */
const dialogRootOf = (event: KeyboardEvent): HTMLElement | null => {
  const target = event.target
  const fromTarget = target instanceof Element ? target.closest('[role="dialog"]') : null
  const root = fromTarget ?? document.querySelector('[role="dialog"]')
  return root instanceof HTMLElement ? root : null
}

/** Roving focus within the open dialog. We swallow Tab to keep it away from
 *  the app coordinator, which also bypasses Radix's own focus trap — so wrap
 *  focus across the dialog's focusables here (Shift+Tab reverses). */
const moveDialogFocus = (event: KeyboardEvent): void => {
  const root = dialogRootOf(event)
  if (!root) return
  const items = Array.from(root.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE))
  if (items.length === 0) return
  const dir = event.shiftKey ? -1 : 1
  const active = document.activeElement
  const at = active instanceof HTMLElement ? items.indexOf(active) : -1
  const next = at === -1
    ? (dir === 1 ? 0 : items.length - 1)
    : (at + dir + items.length) % items.length
  items[next]?.focus()
}

/** Activate the focused control (button click / `<summary>` toggle) — the
 *  native default we suppressed by swallowing the key. */
const clickFocusedControl = (event: KeyboardEvent): void => {
  const target = event.target
  const control = target instanceof Element
    ? target.closest<HTMLElement>(OVERLAY_CONTROL_SELECTOR)
    : null
  control?.click()
}

export const useKeyInspector = (
  open: boolean,
  bindings: readonly HelpBinding[],
  onClose: () => void,
  capture?: CaptureMode | null,
): KeyInspector => {
  const [state, setState] = useState<InspectorState>(EMPTY)
  // Capture handlers are read synchronously inside the keydown listener;
  // mirror into a ref (layout effect, not render, per react-hooks/refs) so
  // entering/leaving capture mode doesn't tear down and re-add the window
  // listeners — key events fire after commit, so the ref is current by then.
  const captureRef = useRef<CaptureMode | null>(capture ?? null)
  useLayoutEffect(() => {
    captureRef.current = capture ?? null
  }, [capture])
  // The keydown handler needs the CURRENT buffer synchronously (to decide
  // clear-vs-close on Escape and to extend the sequence), so mirror state
  // into a ref rather than smuggling side effects into setState updaters.
  // Written in a layout effect (not during render) per the react-hooks/refs
  // rule; key events fire after commit, so the ref is current by then.
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

  // Read `onClose` through a ref so the keydown effect below depends only on
  // the binding set, not on the callback's identity. Callers routinely pass a
  // fresh closure each render; keeping it out of the effect deps stops the
  // per-binding matchers from being torn down and rebuilt mid-sequence (which
  // would drop a live `g g` prefix).
  const onCloseRef = useRef(onClose)
  useLayoutEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  // Keys pressed while the overlay is open, so keyups can be swallowed
  // selectively (see module header). Cleared on each open.
  const downWhileOpenRef = useRef<Set<string>>(new Set())

  // One stateful sequence matcher per binding, rebuilt when the binding set
  // changes (the keydown effect below owns the build). Held in a ref so
  // `selectBinding` and the Escape-clear can abandon in-flight sequences
  // without the display buffer and matcher state drifting apart.
  const matchersRef = useRef<Map<HelpBinding, SequenceMatcher>>(new Map())
  const resetMatchers = useCallback(() => {
    for (const matcher of matchersRef.current.values()) matcher.reset()
  }, [])

  // Reset synchronously during render when the overlay opens/closes or the
  // binding set is rebuilt (active contexts / runtime changed) — pending
  // matches hold model objects by identity, so a stale buffer would filter
  // the new model to nothing. setState in the effect body below would be
  // the cascading-render anti-pattern `react-hooks/set-state-in-effect`
  // forbids.
  const [prevOpen, setPrevOpen] = useState(open)
  const [prevBindings, setPrevBindings] = useState(bindings)
  if (prevOpen !== open || prevBindings !== bindings) {
    setPrevOpen(open)
    setPrevBindings(bindings)
    setState(EMPTY)
  }

  // Opening takes over the keyboard: cancel any armed-but-unfired hold
  // timers (their cancelling keyup would be swallowed) and start a fresh
  // pressed-while-open ledger.
  useEffect(() => {
    if (!open) return
    downWhileOpenRef.current = new Set()
    cancelArmedHolds()
  }, [open])

  useEffect(() => {
    if (!open) return

    // One matcher per binding for this binding set. Infinite timeout so the
    // popup holds a sequence prefix indefinitely (see module header).
    const matchers = new Map<HelpBinding, SequenceMatcher>(
      bindings.map(b => [b, createSequenceMatcher(b.chord, {timeoutMs: Infinity})]),
    )
    matchersRef.current = matchers

    const clearPartial = (): void => {
      setState(s => (s.partial ? {...s, partial: null} : s))
    }

    const onKeydown = (rawEvent: KeyboardEvent): void => {
      // Always keep the app coordinator out; inspection replaces dispatch.
      rawEvent.stopPropagation()
      // Ledger every fresh press BEFORE any early-return below, so the
      // matching keyup is swallowed no matter how the keydown was handled.
      // OS auto-repeats are not new presses — and skipping them keeps keys
      // held from BEFORE opening out of the ledger, so their release still
      // propagates (see keyup below).
      if (!rawEvent.repeat) downWhileOpenRef.current.add(physicalKeyId(rawEvent))

      const capturing = captureRef.current

      // Accessibility: operate the overlay's OWN focus/controls. The swallow
      // (stopPropagation above + preventDefault here) is what keeps a chord
      // from firing the action it names — but it also blocks the app
      // coordinator, which the edit-mode keepalive keeps live with
      // Enter=create-block / Tab=indent bindings, AND Radix's focus trap. So
      // rather than let these through (which would create/indent a block
      // behind the dialog), drive focus traversal + activation ourselves.
      // Off in capture mode (every key is a candidate chord) and for modified
      // variants (they don't operate a control and stay inspectable).
      if (!capturing && isOverlayControlKey(rawEvent)) {
        rawEvent.preventDefault()
        if (rawEvent.key === 'Tab') moveDialogFocus(rawEvent)
        else clickFocusedControl(rawEvent)
        return
      }

      // Rebind capture: the next resolved chord is bound, not inspected.
      // Mirrors KeyCaptureInput — build the chord from the raw event (its
      // own keyCode recovery handles Alt-transforms), Escape cancels,
      // modifiers alone show the "⌘…" preview. No copy escape-hatch here:
      // while recording, ⌘C is a bindable chord, not a copy.
      if (capturing) {
        rawEvent.preventDefault()
        if (rawEvent.repeat) return
        if (rawEvent.key === 'Escape') {
          capturing.onCancel()
          return
        }
        if (isModifierOnly(rawEvent)) {
          const partial = modifierPreview(rawEvent)
          setState(s => ({...s, partial}))
          return
        }
        const chord = chordFromEvent(rawEvent)
        if (chord) capturing.onChord(chord)
        return
      }

      // Copy with a live selection keeps its native default (and is not
      // treated as an inspected chord) so the handler source is copyable.
      if (isCopyChord(rawEvent) && hasTextSelection()) return
      rawEvent.preventDefault()
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
        if (dirty) {
          resetMatchers()
          setState(EMPTY)
        } else {
          onCloseRef.current()
        }
        return
      }

      const display = chordFromEvent(event)
      if (!display) return
      // Feed the press to every binding's own matcher. Per-binding sequence
      // state is what lets a press that breaks one binding's sequence fire
      // another fresh (press `g`, then `$mod+k` — the palette opens): the
      // `g g` matcher resets while the palette matcher matches from scratch.
      const nextPressed = [...stateRef.current.pressed, {event, display}]
      const matches: HelpBinding[] = []
      const pending: HelpBinding[] = []
      for (const binding of bindings) {
        const verdict = matchers.get(binding)?.next(event)
        if (!verdict) continue
        if (verdict.completed) matches.push(binding)
        if (verdict.pending) pending.push(binding)
      }
      if (matches.length === 0 && pending.length === 0) {
        // Nothing live — surface the dead buffer. Every matcher missed and
        // reset itself, so no state lingers to desync from the cleared buffer.
        setState({...EMPTY, unmatched: nextPressed.map(p => p.display)})
        return
      }
      setState({
        pressed: pending.length > 0 ? nextPressed : [],
        matches: matches.length > 0 ? matches : null,
        pendingMatches: pending.length > 0 ? pending : null,
        unmatched: null,
        partial: null,
      })
    }

    const onKeyup = (event: KeyboardEvent): void => {
      // Swallow releases of keys pressed while open (keeps keyup-phase
      // bindings from firing off inspected presses). A release of a key
      // held from before opening propagates — it terminates a gesture
      // already in flight (keyup-phase commit, hold cancel).
      if (downWhileOpenRef.current.delete(physicalKeyId(event))) {
        event.stopPropagation()
      }
      if (isModifierOnly(event)) clearPartial()
    }

    // Modifier releases are delivered elsewhere when the window loses
    // focus mid-hold (Cmd+Tab); drop the preview so it can't stick.
    const onBlur = (): void => clearPartial()

    window.addEventListener('keydown', onKeydown, {capture: true})
    window.addEventListener('keyup', onKeyup, {capture: true})
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeydown, {capture: true})
      window.removeEventListener('keyup', onKeyup, {capture: true})
      window.removeEventListener('blur', onBlur)
    }
  }, [open, bindings, resetMatchers])

  const selectBinding = useCallback((binding: HelpBinding) => {
    // A pointer pick abandons any in-flight sequence, so clear matcher state
    // too or a stale prefix could complete on the next keypress.
    resetMatchers()
    setState({...EMPTY, matches: [binding]})
  }, [resetMatchers])

  return {state, selectBinding}
}
