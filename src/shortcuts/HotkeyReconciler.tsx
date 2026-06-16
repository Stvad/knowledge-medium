import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  createKeybindingsHandler,
  matchKeybindingPress,
  parseKeybinding,
  type KeybindingPress,
} from 'tinykeys'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import {
  useActiveContextsDispatch,
  useActiveContextsState,
  ActiveContextsMap,
} from '@/shortcuts/ActiveContexts.js'
import { contextConfigsByTypeFrom, dispatchActiveActionById, setRunActionDispatcher, setActionWithDepsDispatcher } from '@/shortcuts/runAction.js'
import {
  actionRuntimeKey,
  getEffectiveActions,
} from './effectiveActions.ts'
import { keybindingOverridesFacet } from './keybindingOverrides.ts'
import { computeInstallableContexts, resolve, resolveDeps } from './resolve.ts'
import {
  matchesMouseEvent,
  pointerBindingDescriptor,
  type MouseEventLike,
  type PointerBindingSpec,
  type PointerPhase,
  type TouchPhase,
} from './canonicalizeChord.ts'
import { setPointerActionDispatcher, type PointerGestureEvent } from '@/shortcuts/pointerAction.js'
import {
  setGestureActionDispatcher,
  setGestureProgressDispatcher,
  gestureProgressCancelEvent,
} from '@/shortcuts/gestureAction.js'
import {
  gestureBindingDescriptor,
  matchesGestureEvent,
  type GestureBindingSpec,
} from './gestureBinding.ts'
import {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  ActionDispatch,
  ActionHandlerResult,
  ActionTrigger,
  BaseShortcutDependencies,
  EventOptions,
  ShortcutBindingDefaults,
} from '@/shortcuts/types.js'
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react'
import { hasEditableTarget, isTypingKeyEvent, withRecoveredLetterKey } from '@/shortcuts/utils.js'

/**
 * A non-hold keyboard binding's per-candidate tinykeys matcher. Fed every
 * event of its phase so it keeps its own sequence state (`g g`); on a
 * completed match its callback records the candidate for this event rather
 * than running the handler directly — the coordinator picks the winner.
 */
interface KeyboardCandidate {
  action: ActionConfig
  binding: ShortcutBindingDefaults
  phase: 'keydown' | 'keyup'
  matcher: (event: KeyboardEvent) => void
}

/** A binding whose chord completed on the event currently being processed. */
interface CompletedBinding {
  action: ActionConfig
  binding: ShortcutBindingDefaults
}

const normalizeKeys = (keys: string | string[]): readonly string[] =>
  Array.isArray(keys) ? keys : [keys]

const defaultEventFilter = (event: KeyboardEvent) =>
  !(isTypingKeyEvent(event) && hasEditableTarget(event))

// Keyboard-side deps gate: a candidate's context must still be installable
// (modal shadowing / the activation race) AND have resolvable deps. Layers the
// keyboard-only installable filter over the shared resolveDeps.
const getInstallableContextDeps = (
  action: ActionConfig,
  active: ActiveContextsMap,
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>,
) => {
  if (!computeInstallableContexts(active, contextConfigsByType).has(action.context)) return null
  return resolveDeps(action, active, contextConfigsByType)
}

/**
 * Run the same event-filter cascade tinykeys' default `ignore` would do,
 * but extended with per-context eventFilter overrides. An active context's
 * filter returning true means "I want this event even though it'd
 * normally be ignored" (e.g. property-editing needs Escape from inside
 * an <input>). Otherwise we apply the editable-target heuristic.
 */
const shouldHandleEvent = (
  event: KeyboardEvent,
  active: ActiveContextsMap,
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>,
): boolean => {
  for (const type of active.keys()) {
    const config = contextConfigsByType.get(type)
    if (config?.eventFilter?.(event)) return true
  }
  return defaultEventFilter(event)
}

/**
 * Keeps `tinykeys` in sync with the facet runtime's declared actions and the
 * currently-active contexts from `<ActiveContextsProvider>`.
 *
 * - Each enabled action gets its own `tinykeys(window, {...})` subscription
 *   so per-action install/uninstall is just calling the returned
 *   unsubscribe. Many small listeners > one big map: avoids tearing
 *   everything down whenever a single context activates.
 * - When the action set identity changes (runtime regeneration) every
 *   subscription is torn down first; handlers close over the old action
 *   objects and would otherwise become stale.
 * - When active contexts change, subscriptions are added/removed per
 *   action based on whether the action's context is active and installable
 *   (modal stacking). Handlers read deps via refs so intra-context
 *   dependency changes (e.g. new focused block) don't require rebinding.
 * - Per-context eventFilter overrides run inside each handler — tinykeys'
 *   built-in `ignore` is bypassed (`() => false`) so we can layer our
 *   own filter cascade.
 *
 * NOTE: an earlier pass replaced the latest-ref pattern below with
 * `useEffectEvent`. That broke shortcut delivery in the browser (likely
 * because tinykeys fires its handlers from a global keydown listener,
 * not a React-tracked event handler — outside that scope the
 * effect-event indirection doesn't see the latest closure reliably).
 * Reverted to the ref pattern; the refs are written in a useLayoutEffect
 * so we don't trip the new react-hooks/refs rule.
 */
export function HotkeyReconciler(): null {
  const runtime = useAppRuntime()
  const active = useActiveContextsState()
  // `ActiveContextsDispatch` is reference-stable across renders of the
  // same provider, but we still funnel it through a ref so handler
  // closures don't capture a stale value if the provider remounts.
  const dispatch = useActiveContextsDispatch()

  // Keybinding overrides are pushed at runtime via
  // `setRuntimeContributions` (the keybindings-settings effect mirrors
  // the user's prefs block into the facet). Subscribe to the facet's
  // change listener so the memo recomputes when that bucket updates —
  // otherwise the dep array (`[runtime]`) would only fire on a full
  // runtime rebuild and miss in-place contribution changes.
  const [overridesGeneration, setOverridesGeneration] = useState(0)
  useEffect(() => {
    return runtime.onFacetChange(keybindingOverridesFacet.id, () => {
      setOverridesGeneration(g => g + 1)
    })
  }, [runtime])

  const actions = useMemo(
    () => getEffectiveActions(runtime),
    // overridesGeneration is included so in-place facet updates flow
    // through; runtime identity changes still trigger a recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runtime, overridesGeneration],
  )
  const contextConfigsByType = useMemo<ReadonlyMap<ActionContextType, ActionContextConfig>>(
    () => contextConfigsByTypeFrom(runtime),
    [runtime],
  )

  // Refs so handler closures always see the latest state without rebinding.
  // Updated synchronously after each commit via useLayoutEffect, before the
  // browser fires any user input event.
  const activeRef = useRef<ActiveContextsMap>(active)
  const contextConfigsByTypeRef = useRef<ReadonlyMap<ActionContextType, ActionContextConfig>>(contextConfigsByType)
  const dispatchRef = useRef<ActionDispatch>(dispatch)
  useLayoutEffect(() => {
    activeRef.current = active
    contextConfigsByTypeRef.current = contextConfigsByType
    dispatchRef.current = dispatch
  }, [active, contextConfigsByType, dispatch])

  // Install the module-level runActionById dispatcher. Reads refs so it's
  // always current. Torn down on unmount so stray callers fail loudly.
  useEffect(() => {
    setRunActionDispatcher((actionId: string, trigger: ActionTrigger) =>
      dispatchActiveActionById(
        {
          runtime,
          active: activeRef.current,
          contextConfigsByType: contextConfigsByTypeRef.current,
          dispatch: dispatchRef.current,
        },
        actionId,
        trigger,
      ),
    )
    return () => setRunActionDispatcher(null)
  }, [runtime])

  // Install the supplied-deps by-id dispatcher. Same resolve + run-until-handled
  // path as keyboard/pointer, but candidates are matched by action id and deps
  // are SUPPLIED by the caller (the swipe gesture / quick-action menu), so the
  // action's context need not be keyboard-active. The caller owns native
  // default-handling (swipe preventDefaults off the boolean return), so no event
  // options are applied here.
  useEffect(() => {
    setActionWithDepsDispatcher((actionId, supplied, trigger) => {
      const active = activeRef.current
      const contextConfigsByType = contextConfigsByTypeRef.current
      const ordered = resolve(
        getEffectiveActions(runtime),
        {active, contextConfigsByType},
        {kind: 'supplied', actionId},
      )
      return runOrderedCandidates(
        ordered,
        trigger,
        {active, contextConfigsByType, dispatch: dispatchRef.current},
        supplied,
        () => undefined,
      )
    })
    return () => setActionWithDepsDispatcher(null)
  }, [runtime])

  // Install the pointer-action dispatcher. Mirrors the keyboard coordinator's
  // collect → order → run-until-handled loop, but the candidates are the
  // pointer-bound actions whose descriptor matches this event, and deps are
  // SUPPLIED by the caller (the clicked block — its context isn't keyboard-
  // active). Reads refs so it always sees current active contexts / configs.
  useEffect(() => {
    setPointerActionDispatcher((event, supplied) => {
      const active = activeRef.current
      const contextConfigsByType = contextConfigsByTypeRef.current
      // A touch tap resolves at the `tap` phase and carries none of mouse's
      // button/detail/modifiers; a mouse gesture's phase comes from its event
      // type and matches on those fields. `eventLike` is null for touch so a
      // mouse descriptor can never match a tap (and vice versa).
      const phase: PointerPhase | TouchPhase =
        isTouchGesture(event) ? 'tap' : phaseOfPointerEvent(event)
      const eventLike = mouseEventLikeOf(event)
      const matched = getEffectiveActions(runtime).filter(action => {
        const spec = action.pointerBinding
        if (!spec) return false
        // Context-level pointer gate: a context can declare its gestures don't
        // apply to this target (e.g. block-pointer excludes interactive
        // descendants), so none of its actions become candidates here.
        const contextFilter = contextConfigsByType.get(action.context)?.pointerTargetFilter
        if (contextFilter && !contextFilter(event)) return false
        // A binding may list several pointer chords (ctrl-click OR meta-click,
        // double-click OR tap); the action matches if any of them does.
        const specs: readonly PointerBindingSpec[] = Array.isArray(spec) ? spec : [spec]
        return specs.some(candidate => {
          const descriptor = pointerBindingDescriptor(candidate)
          if (descriptor.phase !== phase) return false
          // A touch descriptor matches a tap on phase alone (no button/detail);
          // a mouse descriptor needs the mouse fields, so a tap (eventLike null)
          // can't satisfy it.
          if (descriptor.kind === 'touch') return true
          if (!eventLike) return false
          if (!matchesMouseEvent(descriptor, eventLike)) return false
          if (descriptor.role && !pointerRoleMatches(supplied.targetElement, descriptor.role)) return false
          return true
        })
      })
      if (matched.length === 0) return false

      const ordered = resolve(matched, {active, contextConfigsByType}, {kind: 'pointer'})
      return runOrderedCandidates(
        ordered,
        event,
        {active, contextConfigsByType, dispatch: dispatchRef.current},
        supplied,
        action => applyTriggerEventOptions(event, action, contextConfigsByType),
      )
    })
    return () => setPointerActionDispatcher(null)
  }, [runtime])

  // Install the gesture-action dispatcher. The continuous-gesture analogue of
  // the pointer effect above: a recognizer (or escape-hatch surface) emits a
  // gesture NAME, and the candidates are the actions whose `gestureBinding`
  // names it — matched by name+phase, not by an event's intrinsic fields, since
  // the recognizer has already classified the motion. Deps are SUPPLIED by the
  // caller (the block the gesture ran on; its context isn't keyboard-active),
  // then ordered and run through the same loop as keyboard/pointer.
  useEffect(() => {
    setGestureActionDispatcher((gesture, supplied, event) => {
      const active = activeRef.current
      const contextConfigsByType = contextConfigsByTypeRef.current
      const matched = getEffectiveActions(runtime).filter(action => {
        const spec = action.gestureBinding
        if (!spec) return false
        // A binding may list several gestures; the action matches if any names
        // this gesture. dispatchGesture is the COMMIT path (progress goes through
        // beginGestureProgress), so we match the commit phase here.
        const specs: readonly GestureBindingSpec[] = Array.isArray(spec) ? spec : [spec]
        return specs.some(candidate =>
          matchesGestureEvent(gestureBindingDescriptor(candidate), {gesture, phase: 'commit'}),
        )
      })
      if (matched.length === 0) return false

      const ordered = resolve(matched, {active, contextConfigsByType}, {kind: 'gesture'})
      return runOrderedCandidates(
        ordered,
        event,
        {active, contextConfigsByType, dispatch: dispatchRef.current},
        supplied,
        action => applyTriggerEventOptions(event, action, contextConfigsByType),
      )
    })
    return () => setGestureActionDispatcher(null)
  }, [runtime])

  // Install the gesture PROGRESS dispatcher — the single-winner preview channel
  // (commit, above, is run-until-handled). A live preview resolves to ONE action
  // on the first progress tick by context priority; the returned handle streams every tick
  // and the terminal settle to that one action. Resolving once (not per tick) is
  // both cheaper at pointer-move frequency and correct — the winner can't change
  // mid-drag. Returns null when nothing binds the gesture's progress phase, so a
  // recognizer skips previewing for free.
  useEffect(() => {
    setGestureProgressDispatcher((gesture, supplied) => {
      const active = activeRef.current
      const contextConfigsByType = contextConfigsByTypeRef.current
      const matched = getEffectiveActions(runtime).filter(action => {
        const spec = action.gestureBinding
        if (!spec) return false
        const specs: readonly GestureBindingSpec[] = Array.isArray(spec) ? spec : [spec]
        return specs.some(candidate =>
          matchesGestureEvent(gestureBindingDescriptor(candidate), {gesture, phase: 'progress'}),
        )
      })
      if (matched.length === 0) return null

      // Resolve once, best-first by context priority; bind to the first candidate
      // with valid deps that doesn't decline via canDispatch.
      const ordered = resolve(matched, {active, contextConfigsByType}, {kind: 'gesture'})
      for (const action of ordered) {
        const deps = resolveDeps(action, active, contextConfigsByType, supplied)
        if (!deps) continue
        if (action.canDispatch && !action.canDispatch(deps)) continue
        const {handler} = action
        // A preview streams MANY ticks; a throwing/rejecting handler must be
        // contained the same way the commit/keyboard path contains it
        // (runOrderedCandidates), or one bad tick becomes an uncaught error /
        // unhandled rejection on every pointer-move. Log and swallow so the
        // gesture keeps running.
        const runProgress = (event: ActionTrigger): void => {
          let result: ActionHandlerResult
          try {
            result = handler(deps, event, dispatchRef.current)
          } catch (error) {
            console.error(`[HotkeyReconciler] Progress action ${action.id} threw`, error)
            return
          }
          void Promise.resolve(result).catch(error => {
            console.error(`[HotkeyReconciler] Progress action ${action.id} rejected`, error)
          })
        }
        return {
          update: event => runProgress(event),
          settle: () => runProgress(gestureProgressCancelEvent(gesture)),
        }
      }
      return null
    })
    return () => setGestureProgressDispatcher(null)
  }, [runtime])

  // One coordinator per phase replaces the N per-action window listeners —
  // that sibling-listener model was the double-fire (a binding's
  // preventDefault can't stop a sibling listener). Each installable non-hold
  // binding keeps its own tinykeys matcher so sequence state (`g g`) survives,
  // but a completed match only RECORDS the candidate; the coordinator orders
  // the recorded candidates and dispatches a single winner. Hold bindings keep
  // their own observer (installHoldBinding) — duration isn't a tinykeys match.
  const installedRef = useRef<{
    actions: readonly ActionConfig[]
    keyboard: Map<string, KeyboardCandidate>
    hold: Map<string, {unsubscribe: () => void}>
  }>({actions: [], keyboard: new Map(), hold: new Map()})
  // Bindings whose chord completed on the event currently being processed.
  // The coordinator clears it before feeding matchers, the match callbacks
  // push into it, and it's read back synchronously after — tinykeys completion
  // is synchronous within the dispatch, so there's no async-ordering hazard.
  const completedRef = useRef<CompletedBinding[]>([])

  useEffect(() => {
    const state = installedRef.current

    const uninstallHold = (actionKey: string) => {
      const entry = state.hold.get(actionKey)
      if (!entry) return
      entry.unsubscribe()
      state.hold.delete(actionKey)
    }

    // If the action set identity changed (runtime regeneration), tear
    // everything down first. Matchers/observers close over the old action
    // objects and would otherwise run stale handlers.
    if (state.actions !== actions) {
      for (const actionKey of Array.from(state.hold.keys())) uninstallHold(actionKey)
      state.keyboard.clear()
      state.actions = actions
    }

    const desiredActionIds = new Set<string>()
    const installable = computeInstallableContexts(active, contextConfigsByType)

    for (const action of actions) {
      if (!action.defaultBinding) continue
      if (!active.has(action.context)) continue
      if (!installable.has(action.context)) continue
      const actionKey = actionRuntimeKey(action)
      desiredActionIds.add(actionKey)

      const binding = action.defaultBinding

      if (binding.phase === 'hold') {
        if (state.hold.has(actionKey)) continue
        const unsubscribe = installHoldBinding({
          action,
          binding,
          keys: normalizeKeys(binding.keys),
          holdMs: binding.holdMs,
          activeRef,
          contextConfigsByTypeRef,
          dispatchRef,
        })
        state.hold.set(actionKey, {unsubscribe})
        continue
      }

      if (state.keyboard.has(actionKey)) continue
      state.keyboard.set(actionKey, {
        action,
        binding,
        phase: binding.phase ?? 'keydown',
        matcher: makeMatcher(action, binding, completedRef),
      })
    }

    // Drop candidates whose context deactivated, was shadowed, or disappeared.
    for (const actionKey of Array.from(state.keyboard.keys())) {
      if (!desiredActionIds.has(actionKey)) state.keyboard.delete(actionKey)
    }
    for (const actionKey of Array.from(state.hold.keys())) {
      if (!desiredActionIds.has(actionKey)) uninstallHold(actionKey)
    }
  }, [actions, active, contextConfigsByType])

  // The single keydown/keyup coordinator. Installed once; reads refs so it
  // always sees the current matcher set, active contexts, and configs without
  // rebinding. (Per the note above, the useEffectEvent indirection broke
  // delivery here — tinykeys fires from a global listener outside React's
  // event scope — so the latest state must come through refs.)
  useEffect(() => {
    const dispatchPhase = (phase: 'keydown' | 'keyup', rawEvent: Event): void => {
      const event = withRecoveredLetterKey(rawEvent as KeyboardEvent)
      const completed = completedRef.current
      completed.length = 0
      // Feed every candidate of this phase so each advances its own sequence
      // state; a completed match pushes the candidate into `completed`.
      for (const candidate of installedRef.current.keyboard.values()) {
        if (candidate.phase === phase) candidate.matcher(event)
      }
      if (completed.length === 0) return

      const active = activeRef.current
      const contextConfigsByType = contextConfigsByTypeRef.current
      // The filter cascade gates dispatch, not matching — sequence state has
      // already advanced above, matching tinykeys' per-listener behaviour.
      if (!shouldHandleEvent(event, active, contextConfigsByType)) return

      // Order + filter through the shared resolver (modal shadowing + the
      // precedence comparator), so the keyboard path can't diverge from the
      // imperative one. resolve drops candidates whose context deactivated or
      // got shadowed between matcher install and this event (filter-before-
      // sort), then orders best-first. Dispatch the first candidate that
      // doesn't decline through any of the three identically-treated
      // fall-through conditions: deps don't resolve, canDispatch returns false,
      // or the handler synchronously returns the not-handled sentinel (`false`).
      const bindings = new Map<ActionConfig, ShortcutBindingDefaults>(
        completed.map(c => [c.action, c.binding]),
      )
      const ordered = resolve([...bindings.keys()], {active, contextConfigsByType}, {kind: 'keyboard'})
      runOrderedCandidates(
        ordered,
        event,
        {active, contextConfigsByType, dispatch: dispatchRef.current},
        undefined,
        action => applyEventOptions(event, action, bindings.get(action)!, contextConfigsByType),
      )
    }

    const onKeydown = (event: Event) => dispatchPhase('keydown', event)
    const onKeyup = (event: Event) => dispatchPhase('keyup', event)
    window.addEventListener('keydown', onKeydown)
    window.addEventListener('keyup', onKeyup)
    return () => {
      window.removeEventListener('keydown', onKeydown)
      window.removeEventListener('keyup', onKeyup)
    }
  }, [])

  // Final teardown on unmount (test cleanup, HMR). Separate effect with empty
  // deps so it runs once on unmount, after reconcile effects have stopped.
  // Snapshot the ref so cleanup doesn't read a mutated installedRef.current.
  useEffect(() => {
    const state = installedRef.current
    return () => {
      for (const [, entry] of state.hold) entry.unsubscribe()
      state.hold.clear()
      state.keyboard.clear()
      state.actions = []
    }
  }, [])

  return null
}

interface HoldBindingInstall {
  action: ActionConfig
  binding: ShortcutBindingDefaults
  keys: readonly string[]
  holdMs: number
  activeRef: { current: ActiveContextsMap }
  contextConfigsByTypeRef: { current: ReadonlyMap<ActionContextType, ActionContextConfig> }
  dispatchRef: { current: ActionDispatch }
}

/**
 * Companion observer for `phase: 'hold'` bindings — tinykeys is purely
 * event-driven and has no notion of duration.
 *
 * Lifecycle per armed hold:
 *  - On a matching keydown (chord parsed via tinykeys' `matchKeybindingPress`,
 *    so `'$mod+s'` etc. work the same as elsewhere), filter the event
 *    through the existing context-aware filter (so typing into an input
 *    doesn't arm a hold) AND check the binding's context is still
 *    eligible. If both pass, preventDefault the keydown (suppresses OS
 *    press-and-hold popups on Mac), start a timer for `holdMs`, and
 *    remember the chord's primary `event.key` to match the eventual keyup.
 *  - OS-driven `event.repeat` keydowns while the key is still held are
 *    ignored — we treat the press as already armed. preventDefault is
 *    still applied so the input event doesn't reach editable targets.
 *  - On keyup of the same primary key before the timer fires, cancel.
 *  - On `blur` of the window, cancel.
 *  - On timer fire, run `action.handler(deps, originalKeydown, dispatch)`
 *    after re-validating the context is still active. Same path as the
 *    keydown / keyup makeHandler uses minus the preventDefault (already
 *    done at arm time).
 *
 * Limitation: if the chord includes modifiers (e.g. `'$mod+s'`) and the
 * user releases the modifier but keeps the primary key pressed, the timer
 * still fires. Acceptable for the initial date-scrub usage which holds a
 * bare letter. Tighten if a future caller needs modifier-release-cancels.
 *
 * Sequence chords (`'g g'`) are rejected at install time — a "hold a
 * sequence" doesn't have well-defined semantics here.
 */
const installHoldBinding = (config: HoldBindingInstall): (() => void) => {
  const {action, binding, keys, holdMs, activeRef, contextConfigsByTypeRef, dispatchRef} = config

  interface ParsedHold {
    rawKey: string
    presses: readonly KeybindingPress[]
  }

  const parsed: ParsedHold[] = []
  for (const rawKey of keys) {
    const presses = parseKeybinding(rawKey)
    if (presses.length !== 1) {
      console.warn(
        `[HotkeyReconciler] Hold binding "${rawKey}" on action "${action.id}" is a sequence chord; skipped (hold semantics are single-press only).`,
      )
      continue
    }
    parsed.push({rawKey, presses})
  }
  if (parsed.length === 0) return () => undefined

  let pending: {
    timer: ReturnType<typeof setTimeout>
    primaryKey: string
  } | null = null

  const cancel = (): void => {
    if (!pending) return
    clearTimeout(pending.timer)
    pending = null
  }

  const fire = (originalEvent: KeyboardEvent): void => {
    const deps = getInstallableContextDeps(
      action,
      activeRef.current,
      contextConfigsByTypeRef.current,
    )
    if (!deps) return
    // Hold dispatch happens here (timer fire), so the canDispatch gate is
    // evaluated here too — same contract the keydown/keyup coordinator
    // enforces: a declining predicate skips the handler rather than firing
    // in a state the action opted out of.
    if (action.canDispatch && !action.canDispatch(deps)) return

    try {
      void Promise.resolve(action.handler(deps, originalEvent, dispatchRef.current)).catch(error => {
        console.error(`[HotkeyReconciler] Action ${action.id} rejected`, error)
      })
    } catch (error) {
      console.error(`[HotkeyReconciler] Action ${action.id} threw`, error)
    }
  }

  const onKeydown = (rawEvent: Event): void => {
    const event = withRecoveredLetterKey(rawEvent as KeyboardEvent)
    if (event.repeat) {
      if (pending) applyEventOptions(event, action, binding, contextConfigsByTypeRef.current)
      return
    }
    if (pending) return

    const matched = parsed.some(({presses}) =>
      presses.every(press => matchKeybindingPress(event, press)),
    )
    if (!matched) return

    const active = activeRef.current
    const contextConfigsByType = contextConfigsByTypeRef.current
    if (!getInstallableContextDeps(action, active, contextConfigsByType)) return
    if (!shouldHandleEvent(event, active, contextConfigsByType)) return

    applyEventOptions(event, action, binding, contextConfigsByType)

    pending = {
      timer: setTimeout(() => {
        pending = null
        fire(event)
      }, holdMs),
      primaryKey: event.key,
    }
  }

  const onKeyup = (rawEvent: Event): void => {
    if (!pending) return
    const event = rawEvent as KeyboardEvent
    if (event.key !== pending.primaryKey) return
    cancel()
  }

  const onBlur = (): void => cancel()

  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  window.addEventListener('blur', onBlur)

  return () => {
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('keyup', onKeyup)
    window.removeEventListener('blur', onBlur)
    cancel()
  }
}

interface CandidateRunContext {
  active: ActiveContextsMap
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>
  dispatch: ActionDispatch
}

/**
 * Run an ordered candidate list best-first and dispatch the first that handles
 * — the single run-until-handled loop shared by the keyboard and pointer
 * paths. The three fall-through conditions are treated identically: deps don't
 * resolve, `canDispatch` returns false, or the handler synchronously returns
 * the not-handled sentinel (`false`).
 *
 * Event options apply only to the candidate that actually handles (or throws);
 * a declining handler leaves the event untouched so the next candidate, or the
 * native default, proceeds. NOTE this is a deliberate timing change from the
 * pre-Option-D keyboard loop, which applied options BEFORE invoking the
 * handler: here they're applied AFTER the synchronous return, because "handled"
 * isn't known until the handler returns non-`false`. `preventDefault` is
 * unaffected (the UA evaluates the default after the whole sync dispatch), but
 * `stopPropagation` now fires after the handler body rather than before. No
 * in-tree binding sets `stopPropagation: true`, so this is currently latent;
 * a binding that does and relies on propagation already being stopped while its
 * handler runs would see the new ordering.
 *
 * `supplied` deps are merged in for callers that hold them (pointer gestures,
 * swipe) and undefined for keyboard. Returns true if a candidate handled (or
 * threw), false if every candidate fell through.
 */
const runOrderedCandidates = (
  ordered: readonly ActionConfig[],
  trigger: ActionTrigger,
  {active, contextConfigsByType, dispatch}: CandidateRunContext,
  supplied: Partial<BaseShortcutDependencies> | undefined,
  applyOptions: (action: ActionConfig) => void,
): boolean => {
  for (const action of ordered) {
    const deps = resolveDeps(action, active, contextConfigsByType, supplied)
    if (!deps) continue
    if (action.canDispatch && !action.canDispatch(deps)) continue

    let result: ActionHandlerResult
    try {
      result = action.handler(deps, trigger, dispatch)
    } catch (error) {
      console.error(`[HotkeyReconciler] Action ${action.id} threw`, error)
      applyOptions(action)
      return true
    }
    if (result === false) continue // declined — try the next candidate
    applyOptions(action)
    void Promise.resolve(result).catch(error => {
      console.error(`[HotkeyReconciler] Action ${action.id} rejected`, error)
    })
    return true
  }
  return false
}

/** A touch gesture carries `changedTouches`; a mouse event does not — the
 *  discriminator the dispatcher uses to pick the tap path over the mouse path. */
const isTouchGesture = (event: PointerGestureEvent): event is ReactTouchEvent<HTMLElement> =>
  'changedTouches' in event

/** The mouse fields a {@link MouseChordDescriptor} matches against, or null for
 *  a touch gesture (a tap has no button/detail/modifiers). */
const mouseEventLikeOf = (event: PointerGestureEvent): MouseEventLike | null =>
  isTouchGesture(event)
    ? null
    : {
        button: event.button,
        detail: event.detail,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      }

/** Map a React mouse event to the binding phase it can satisfy. `click` is
 *  the default; `pointerdown` lets a double-click beat native text selection. */
const phaseOfPointerEvent = (event: ReactMouseEvent<HTMLElement>): PointerPhase => {
  switch (event.type) {
    case 'mousedown':
    case 'pointerdown':
      return 'pointerdown'
    case 'mouseup':
    case 'pointerup':
      return 'pointerup'
    default:
      return 'click'
  }
}

/** A bound node satisfies a descriptor's `role` when it (or an ancestor)
 *  carries the matching `data-pointer-role`. */
const pointerRoleMatches = (target: HTMLElement, role: string): boolean =>
  Boolean(target.closest(`[data-pointer-role="${role}"]`))

/** preventDefault / stopPropagation for a handled pointer OR gesture-commit
 *  action — one body, since both want the same thing. Block selection wants
 *  native text-selection suppressed and the trailing synthesized click kept out
 *  of edit-mode, so the defaults are `{preventDefault: true, stopPropagation:
 *  true}`; a context overrides via `defaultEventOptions`. Typed on the broad
 *  `ActionTrigger` so it serves the pointer path (a React Mouse/Touch event —
 *  `PointerGestureEvent` is a subset) and the gesture commit (the native
 *  `PointerEvent` that ended the drag, or a synthetic `CustomEvent`) alike; all
 *  expose preventDefault/stopPropagation. Eating the commit event is what
 *  suppresses the trailing touchend click that today's swipe/scrub
 *  `event.preventDefault()` does by hand. Keyboard's `applyEventOptions` stays
 *  separate — different defaults (no stopPropagation) and binding-level
 *  precedence. */
const applyTriggerEventOptions = (
  event: ActionTrigger,
  action: ActionConfig,
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>,
): void => {
  const contextConfig = contextConfigsByType.get(action.context)
  const options: EventOptions = {
    preventDefault: true,
    stopPropagation: true,
    ...contextConfig?.defaultEventOptions,
  }
  if (options.stopPropagation) event.stopPropagation()
  if (options.preventDefault) event.preventDefault()
}

/**
 * preventDefault / stopPropagation per the same precedence the keydown /
 * keyup handler uses (binding > context-default > built-in default). Pulled
 * out so the hold companion can reuse it for both the arming keydown and
 * any OS-repeat keydowns that follow before the timer fires.
 */
const applyEventOptions = (
  event: KeyboardEvent,
  action: ActionConfig,
  binding: ShortcutBindingDefaults,
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>,
): void => {
  const contextConfig = contextConfigsByType.get(action.context)
  const options: EventOptions = {
    preventDefault: true,
    stopPropagation: false,
    ...contextConfig?.defaultEventOptions,
    ...binding.eventOptions,
  }
  if (options.stopPropagation) event.stopPropagation()
  if (options.preventDefault) event.preventDefault()
}

/**
 * Build a candidate's tinykeys matcher. Every key in the binding maps to the
 * same callback, which records the candidate in `completedRef` for the event
 * in flight instead of running the handler — the coordinator orders the
 * recorded candidates and runs the winner.
 *
 * `createKeybindingsHandler` (rather than `tinykeys()` directly) lets the
 * coordinator preprocess each event with `withRecoveredLetterKey` before the
 * matcher sees it: tinykeys reads event.key, which Mac option-transforms
 * (Alt+y → '¥') and Linux compose setups corrupt for letter chords; the
 * wrapper restores the logical letter from event.keyCode, and works on
 * Colemak/Dvorak where event.code lies about layout. `ignore: () => false`
 * disables tinykeys' built-in editable-target filter — the coordinator runs
 * the context-aware cascade (`shouldHandleEvent`) itself, so contexts like
 * property-editing can opt into events tinykeys would otherwise drop.
 */
const makeMatcher = (
  action: ActionConfig,
  binding: ShortcutBindingDefaults,
  completedRef: { current: CompletedBinding[] },
): ((event: KeyboardEvent) => void) => {
  const record = () => {
    completedRef.current.push({action, binding})
  }
  const bindingMap: Record<string, (event: KeyboardEvent) => void> = {}
  for (const key of normalizeKeys(binding.keys)) bindingMap[key] = record
  return createKeybindingsHandler(bindingMap, {ignore: () => false})
}
