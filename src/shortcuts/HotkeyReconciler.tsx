import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  createKeybindingsHandler,
  matchKeybindingPress,
  parseKeybinding,
  type KeybindingPress,
} from 'tinykeys'
import { actionContextsFacet } from '@/extensions/core.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import {
  useActiveContextsDispatch,
  useActiveContextsState,
  ActiveContextsMap,
} from '@/shortcuts/ActiveContexts.js'
import { setRunActionDispatcher } from '@/shortcuts/runAction.js'
import {
  actionRuntimeKey,
  getActiveActionById,
  getEffectiveActions,
} from './effectiveActions.ts'
import { keybindingOverridesFacet } from './keybindingOverrides.ts'
import { computeInstallableContexts } from './resolve.ts'
import {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  ActionDispatch,
  ActionTrigger,
  EventOptions,
  ShortcutBindingDefaults,
} from '@/shortcuts/types.js'
import { hasEditableTarget, isTypingKeyEvent, withRecoveredLetterKey } from '@/shortcuts/utils.js'

interface InstalledBinding {
  unsubscribe: () => void
}

const normalizeKeys = (keys: string | string[]): readonly string[] =>
  Array.isArray(keys) ? keys : [keys]

const defaultEventFilter = (event: KeyboardEvent) =>
  !(isTypingKeyEvent(event) && hasEditableTarget(event))

const getInstallableContextDeps = (
  context: ActionContextType,
  active: ActiveContextsMap,
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>,
) => {
  const deps = active.get(context)
  if (!deps) return null
  if (!computeInstallableContexts(active, contextConfigsByType).has(context)) return null
  return deps
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
  const contextConfigs = useMemo(() => runtime.read(actionContextsFacet), [runtime])
  const contextConfigsByType = useMemo<ReadonlyMap<ActionContextType, ActionContextConfig>>(
    () => new Map(contextConfigs.map(c => [c.type, c])),
    [contextConfigs],
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
    setRunActionDispatcher((actionId: string, trigger: ActionTrigger) => {
      const action = getActiveActionById(getEffectiveActions(runtime), activeRef.current, actionId)
      if (!action) {
        throw new Error(`[HotkeyReconciler] Active action with ID "${actionId}" not found.`)
      }
      const deps = activeRef.current.get(action.context)
      if (!deps) throw new Error(`[HotkeyReconciler] Context "${action.context}" is not active.`)
      return action.handler(deps, trigger, dispatchRef.current)
    })
    return () => setRunActionDispatcher(null)
  }, [runtime])

  // Track which actions currently have hotkeys installed.
  // Each entry owns its own tinykeys subscription — calling its
  // unsubscribe removes only that handler's listener.
  const installedRef = useRef<{
    actions: readonly ActionConfig[]
    byActionId: Map<string, InstalledBinding>
  }>({actions: [], byActionId: new Map()})

  useEffect(() => {
    const state = installedRef.current

    const uninstall = (actionId: string) => {
      const entry = state.byActionId.get(actionId)
      if (!entry) return
      entry.unsubscribe()
      state.byActionId.delete(actionId)
    }

    // If the action set identity changed (runtime regeneration), tear
    // everything down first. Handlers close over the old action objects and
    // would otherwise become stale.
    if (state.actions !== actions) {
      for (const actionId of Array.from(state.byActionId.keys())) uninstall(actionId)
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

      if (state.byActionId.has(actionKey)) continue

      const binding = action.defaultBinding
      const keys = normalizeKeys(binding.keys)

      if (binding.phase === 'hold') {
        const unsubscribe = installHoldBinding({
          action,
          binding,
          keys,
          holdMs: binding.holdMs,
          activeRef,
          contextConfigsByTypeRef,
          dispatchRef,
        })
        state.byActionId.set(actionKey, {unsubscribe})
        continue
      }

      const handler = makeHandler(action, binding, activeRef, contextConfigsByTypeRef, dispatchRef)
      const bindingMap: Record<string, (event: KeyboardEvent) => void> = {}
      for (const key of keys) bindingMap[key] = handler
      // We use `createKeybindingsHandler` + a manual listener rather than
      // tinykeys() directly so we can preprocess events with
      // `withRecoveredLetterKey`. tinykeys' matcher reads event.key, which
      // Mac's option-transformations and Linux compose-key setups can
      // corrupt for letter chords (Alt+y → '¥' on Mac US). The wrapper
      // restores the logical letter from event.keyCode before tinykeys
      // sees it — matches hotkeys-js's pre-migration behavior, and works
      // on Colemak/Dvorak where event.code lies about layout.
      //
      // `ignore: () => false` disables tinykeys' built-in editable-target
      // filter; we run our own context-aware filter inside the handler so
      // contexts like property-editing can opt in to events tinykeys
      // would otherwise drop.
      const tinykeysHandler = createKeybindingsHandler(bindingMap, {ignore: () => false})
      const listener: EventListener = (event) => {
        tinykeysHandler(withRecoveredLetterKey(event as KeyboardEvent))
      }
      const phase = binding.phase ?? 'keydown'
      window.addEventListener(phase, listener)
      const unsubscribe = () => window.removeEventListener(phase, listener)
      state.byActionId.set(actionKey, {unsubscribe})
    }

    // Uninstall actions whose context deactivated (or that disappeared).
    for (const actionId of Array.from(state.byActionId.keys())) {
      if (!desiredActionIds.has(actionId)) uninstall(actionId)
    }
  }, [actions, active, contextConfigsByType])

  // Final teardown on unmount (test cleanup, HMR). Separate effect with
  // empty deps so it only runs once on unmount, after all reconcile effects
  // have stopped firing. Snapshot the ref into a local so the cleanup
  // doesn't read a (potentially-mutated) installedRef.current at unmount.
  useEffect(() => {
    const state = installedRef.current
    return () => {
      for (const [, entry] of state.byActionId) entry.unsubscribe()
      state.byActionId.clear()
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
      action.context,
      activeRef.current,
      contextConfigsByTypeRef.current,
    )
    if (!deps) return

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
    if (!getInstallableContextDeps(action.context, active, contextConfigsByType)) return
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

const makeHandler = (
  action: ActionConfig,
  binding: ShortcutBindingDefaults,
  activeRef: { current: ActiveContextsMap },
  contextConfigsByTypeRef: { current: ReadonlyMap<ActionContextType, ActionContextConfig> },
  dispatchRef: { current: ActionDispatch },
) => {
  return (event: KeyboardEvent) => {
    const active = activeRef.current
    const contextConfigsByType = contextConfigsByTypeRef.current
    if (!shouldHandleEvent(event, active, contextConfigsByType)) return

    const deps = getInstallableContextDeps(action.context, active, contextConfigsByType)
    // Context may have deactivated or become shadowed between install and callback.
    if (!deps) return

    const contextConfig = contextConfigsByType.get(action.context)
    const options: EventOptions = {
      preventDefault: true,
      stopPropagation: false,
      ...contextConfig?.defaultEventOptions,
      ...binding.eventOptions,
    }

    if (options.stopPropagation) event.stopPropagation()
    if (options.preventDefault) {
      console.debug(
        `[HotkeyReconciler] Preventing default for action: ${action.id}, context: ${action.context}`,
      )
      event.preventDefault()
    }

    try {
      void Promise.resolve(action.handler(deps, event, dispatchRef.current)).catch(error => {
        console.error(`[HotkeyReconciler] Action ${action.id} rejected`, error)
      })
    } catch (error) {
      console.error(`[HotkeyReconciler] Action ${action.id} threw`, error)
    }
  }
}
