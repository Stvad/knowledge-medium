import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createKeybindingsHandler } from 'tinykeys'
import { actionContextsFacet } from '@/extensions/core.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useActiveContextsState, ActiveContextsMap } from '@/shortcuts/ActiveContexts.js'
import { setRunActionDispatcher } from '@/shortcuts/runAction.js'
import {
  actionRuntimeKey,
  getActiveActionById,
  getEffectiveActions,
} from './effectiveActions.ts'
import { keybindingOverridesFacet } from './keybindingOverrides.ts'
import {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  ActionContextTypes,
  ActionTrigger,
  EventOptions,
  ShortcutBinding,
} from '@/shortcuts/types.js'
import { hasEditableTarget, isTypingKeyEvent, withRecoveredLetterKey } from '@/shortcuts/utils.js'

interface InstalledBinding {
  unsubscribe: () => void
}

const normalizeKeys = (keys: string | string[]): readonly string[] =>
  Array.isArray(keys) ? keys : [keys]

const defaultEventFilter = (event: KeyboardEvent) =>
  !(isTypingKeyEvent(event) && hasEditableTarget(event))

/**
 * When any active context is `modal: true`, the install set collapses to
 * `{global, <most-recent-modal>}`. Otherwise every active context's
 * bindings install. The `global` carve-out keeps app-wide chords
 * (Cmd+K, Escape, …) reachable while a modal is up — without it, opening
 * the command palette during scrub mode would do nothing.
 *
 * Most-recent-wins for modal stacking: `ActiveContextsMap` is insertion-
 * ordered with re-activations rotated to the end (see ActiveContexts.tsx),
 * so the last `set()` of a modal context wins. `canRun` is not considered
 * here — it's presentational, not an install gate ([types.ts]).
 */
const computeInstallableContexts = (
  active: ActiveContextsMap,
  contextConfigsByType: ReadonlyMap<ActionContextType, ActionContextConfig>,
): ReadonlySet<ActionContextType> => {
  const contexts = Array.from(active.keys())
  const latestModal = contexts.toReversed().find(type =>
    contextConfigsByType.get(type)?.modal === true,
  )
  if (!latestModal) return new Set(contexts)
  return new Set([ActionContextTypes.GLOBAL, latestModal])
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
  useLayoutEffect(() => {
    activeRef.current = active
    contextConfigsByTypeRef.current = contextConfigsByType
  }, [active, contextConfigsByType])

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
      return action.handler(deps, trigger)
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

      const binding: ShortcutBinding = {
        ...action.defaultBinding,
        action: action.id,
      }
      const keys = normalizeKeys(binding.keys)
      const handler = makeHandler(action, binding, activeRef, contextConfigsByTypeRef)

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
      window.addEventListener('keydown', listener)
      const unsubscribe = () => window.removeEventListener('keydown', listener)
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

const makeHandler = (
  action: ActionConfig,
  binding: ShortcutBinding,
  activeRef: { current: ActiveContextsMap },
  contextConfigsByTypeRef: { current: ReadonlyMap<ActionContextType, ActionContextConfig> },
) => {
  return (event: KeyboardEvent) => {
    if (!shouldHandleEvent(event, activeRef.current, contextConfigsByTypeRef.current)) return

    const deps = activeRef.current.get(action.context)
    // Context may have deactivated between the key event and this callback.
    if (!deps) return

    const contextConfig = contextConfigsByTypeRef.current.get(action.context)
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
      void Promise.resolve(action.handler(deps, event)).catch(error => {
        console.error(`[HotkeyReconciler] Action ${action.id} rejected`, error)
      })
    } catch (error) {
      console.error(`[HotkeyReconciler] Action ${action.id} threw`, error)
    }
  }
}
