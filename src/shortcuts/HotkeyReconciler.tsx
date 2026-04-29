import { useEffect, useEffectEvent, useMemo, useRef } from 'react'
import hotkeys from 'hotkeys-js'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
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
 *   based on whether the action's context is active. Handler bodies are
 *   `useEffectEvent`s, so they always see the latest active map / context
 *   configs without forcing the bindings to rebind on every change.
 * - Also installs `hotkeys.filter` for per-context event filtering and the
 *   module-level `runActionById` dispatcher for external callers.
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

  // useEffectEvent gives us functions that:
  //   - have a stable identity (so installing them once into hotkeys-js /
  //     the runActionById dispatcher is enough), and
  //   - always observe the latest `active` and `contextConfigsByType`
  //     without forcing the install effects to re-run.
  // This is exactly the role the previous `latestRef.current = …`
  // assign-during-render pattern played.
  const eventFilter = useEffectEvent((event: KeyboardEvent) => {
    for (const type of active.keys()) {
      const config = contextConfigsByType.get(type)
      if (config?.eventFilter?.(event)) return true
    }
    return defaultEventFilter(event)
  })

  const dispatchAction = useEffectEvent(
    (actionId: string, trigger: ActionTrigger) => {
      const action = actions.find(a => a.id === actionId)
      if (!action) {
        throw new Error(`[HotkeyReconciler] Action with ID "${actionId}" not found.`)
      }
      const deps = active.get(action.context)
      if (!deps) {
        throw new Error(
          `[HotkeyReconciler] Cannot run action "${actionId}". Context "${action.context}" is not active.`,
        )
      }
      return action.handler(deps, trigger)
    },
  )

  const runActionForKey = useEffectEvent(
    (action: ActionConfig, binding: ShortcutBinding, event: KeyboardEvent) => {
      const deps = active.get(action.context)
      // Context may have deactivated between the key event and this callback
      // (or another action shares this key in a different, inactive context).
      // Returning true lets the event propagate / default-handle.
      if (!deps) return true

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
        void Promise.resolve(action.handler(deps, event)).catch(error => {
          console.error(`[HotkeyReconciler] Action ${action.id} rejected`, error)
        })
      } catch (error) {
        console.error(`[HotkeyReconciler] Action ${action.id} threw`, error)
      }

      return !options.preventDefault
    },
  )

  // Install the hotkeys-js event filter. Restore a permissive default on
  // unmount so stale closures don't remain wired into the global.
  useEffect(() => {
    const previousFilter = hotkeys.filter
    hotkeys.filter = (event) => eventFilter(event)
    return () => {
      hotkeys.filter = previousFilter
    }
  }, [])

  // Install the module-level runActionById dispatcher. Torn down on
  // unmount so stray callers fail loudly.
  useEffect(() => {
    setRunActionDispatcher((actionId, trigger) => dispatchAction(actionId, trigger))
    return () => setRunActionDispatcher(null)
  }, [])

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
      const handler: HotkeyHandler = (event) => runActionForKey(action, binding, event)

      for (const key of keys) hotkeys(key, handler)
      state.byActionId.set(action.id, {keys, handler})
    }

    // Uninstall actions whose context deactivated (or that disappeared).
    for (const actionId of Array.from(state.byActionId.keys())) {
      if (!desiredActionIds.has(actionId)) uninstall(actionId)
    }
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
