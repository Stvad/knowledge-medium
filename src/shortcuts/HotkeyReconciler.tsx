import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import hotkeys from 'hotkeys-js'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useActiveContextsState, ActiveContextsMap } from '@/shortcuts/ActiveContexts.tsx'
import { setRunActionDispatcher } from '@/shortcuts/runAction.ts'
import {
  ActionConfig,
  ActionContextConfig,
  ActionContextType,
  ActionTrigger,
  EventOptions,
  ShortcutBinding,
} from '@/shortcuts/types.ts'
import { hasEditableTarget, isSingleKeyPress } from '@/shortcuts/utils.ts'

type HotkeyHandler = (event: KeyboardEvent) => boolean | void

interface InstalledBinding {
  keys: readonly string[]
  handler: HotkeyHandler
}

const normalizeKeys = (keys: string | string[]): readonly string[] =>
  Array.isArray(keys) ? keys : [keys]

const defaultEventFilter = (event: KeyboardEvent) =>
  !(isSingleKeyPress(event) && hasEditableTarget(event))

/**
 * Keeps `hotkeys-js` in sync with the facet runtime's declared actions and the
 * currently-active contexts from `<ActiveContextsProvider>`.
 *
 * - When the action set changes (runtime regeneration) all bindings are torn
 *   down and re-installed. This is uncommon; runtime regenerates only on
 *   dynamic extension reloads.
 * - When active contexts change, bindings are installed/uninstalled per action
 *   based on whether the action's context is active. Handlers read deps via
 *   refs so intra-context dependency changes (e.g. new focused block) don't
 *   require rebinding.
 * - Also installs `hotkeys.filter` for per-context event filtering and the
 *   module-level `runActionById` dispatcher for external callers.
 *
 * NOTE: an earlier pass replaced the latest-ref pattern below with
 * `useEffectEvent`. That broke shortcut delivery in the browser (likely
 * because hotkeys-js fires its handlers from a global keydown listener,
 * not a React-tracked event handler — outside that scope the
 * effect-event indirection doesn't see the latest closure reliably).
 * Reverted to the ref pattern; the refs are written in a useLayoutEffect
 * so we don't trip the new react-hooks/refs rule.
 */
export function HotkeyReconciler(): null {
  const runtime = useAppRuntime()
  const active = useActiveContextsState()

  const actions = useMemo(() => runtime.read(actionsFacet), [runtime])
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

  // Install the hotkeys-js event filter. It reads activeRef/contextConfigsByTypeRef
  // so it stays current without needing to re-install. Restore a permissive
  // default on unmount so stale closures don't remain wired into the global.
  useEffect(() => {
    const previousFilter = hotkeys.filter
    hotkeys.filter = (event) => {
      for (const type of activeRef.current.keys()) {
        const config = contextConfigsByTypeRef.current.get(type)
        if (config?.eventFilter?.(event)) return true
      }
      return defaultEventFilter(event)
    }
    return () => {
      hotkeys.filter = previousFilter
    }
  }, [])

  // Install the module-level runActionById dispatcher. Reads refs so it's
  // always current. Torn down on unmount so stray callers fail loudly.
  useEffect(() => {
    setRunActionDispatcher((actionId: string, trigger: ActionTrigger) => {
      const currentActions = runtime.read(actionsFacet)
      const action = currentActions.find(a => a.id === actionId)
      if (!action) {
        throw new Error(`[HotkeyReconciler] Action with ID "${actionId}" not found.`)
      }
      const deps = activeRef.current.get(action.context)
      if (!deps) {
        throw new Error(
          `[HotkeyReconciler] Cannot run action "${actionId}". Context "${action.context}" is not active.`,
        )
      }
      return action.handler(deps, trigger)
    })
    return () => setRunActionDispatcher(null)
  }, [runtime])

  // Track which actions currently have hotkeys installed.
  // hotkeys-js supports handler-specific unbinding: `hotkeys.unbind(key, fn)`
  // detects the function arg and maps it to `method`, so two actions sharing
  // a key can independently install and uninstall their handlers without
  // stepping on each other.
  const installedRef = useRef<{
    actions: readonly ActionConfig[]
    byActionId: Map<string, InstalledBinding>
  }>({actions: [], byActionId: new Map()})

  useEffect(() => {
    const state = installedRef.current

    const uninstall = (actionId: string) => {
      const entry = state.byActionId.get(actionId)
      if (!entry) return
      for (const key of entry.keys) hotkeys.unbind(key, entry.handler)
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

    for (const action of actions) {
      if (!action.defaultBinding) continue
      if (!active.has(action.context)) continue
      desiredActionIds.add(action.id)

      if (state.byActionId.has(action.id)) continue

      const binding: ShortcutBinding = {
        ...action.defaultBinding,
        action: action.id,
      }
      const keys = normalizeKeys(binding.keys)
      const handler = makeHandler(action, binding, activeRef, contextConfigsByTypeRef)

      for (const key of keys) hotkeys(key, handler)
      state.byActionId.set(action.id, {keys, handler})
    }

    // Uninstall actions whose context deactivated (or that disappeared).
    for (const actionId of Array.from(state.byActionId.keys())) {
      if (!desiredActionIds.has(actionId)) uninstall(actionId)
    }
    // `contextConfigsByType` is intentionally NOT a dep: handlers read it
    // through `contextConfigsByTypeRef`, so config changes propagate without
    // requiring a reinstallation pass.
  }, [actions, active])

  // Final teardown on unmount (test cleanup, HMR). Separate effect with
  // empty deps so it only runs once on unmount, after all reconcile effects
  // have stopped firing. Snapshot the ref into a local so the cleanup
  // doesn't read a (potentially-mutated) installedRef.current at unmount.
  useEffect(() => {
    const state = installedRef.current
    return () => {
      for (const [, entry] of state.byActionId) {
        for (const key of entry.keys) hotkeys.unbind(key, entry.handler)
      }
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
): HotkeyHandler => {
  return (event: KeyboardEvent) => {
    const deps = activeRef.current.get(action.context)
    // Context may have deactivated between the key event and this callback
    // (or another action shares this key in a different, inactive context).
    // Returning true lets the event propagate / default-handle.
    if (!deps) return true

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

    return !options.preventDefault
  }
}
