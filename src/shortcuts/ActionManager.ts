import hotkeys from 'hotkeys-js'
import {
  Action,
  ShortcutBinding,
  ActionContextType,
  EventOptions,
  ActionContextConfig,
  BaseShortcutDependencies,
  ActionContextTypes,
  BlockShortcutDependencies,
  PropertyEditingDependencies,
  CommandPaletteDependencies,
  MultiSelectModeDependencies,
  ActiveContextInfo,
  ActionConfig,
  CodeMirrorEditModeDependencies, ActionTrigger,
} from './types'
import { isSingleKeyPress, hasEditableTarget, createAction } from '@/shortcuts/utils.ts'
import { Block } from '@/data/block'
import { EditorView } from '@codemirror/view'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import type { FacetRuntime } from '@/extensions/facet.ts'

const isBaseShortcutDependencies = (deps: unknown): deps is BaseShortcutDependencies =>
  typeof deps === 'object' && deps !== null && 'uiStateBlock' in deps && deps.uiStateBlock instanceof Block

const isBlockShortcutDependencies = (deps: unknown): deps is BlockShortcutDependencies =>
  isBaseShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'block' in deps && deps.block instanceof Block

const isCodeMirrorEditModeDependencies = (deps: unknown): deps is CodeMirrorEditModeDependencies =>
  isBaseShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'block' in deps && deps.block instanceof Block && 'editorView' in deps && deps.editorView instanceof EditorView

const isPropertyEditingDependencies = (deps: unknown): deps is PropertyEditingDependencies =>
  isBlockShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'input' in deps && deps.input instanceof HTMLInputElement

const isCommandPaletteDependencies = (deps: unknown): deps is CommandPaletteDependencies =>
  isBaseShortcutDependencies(deps)

const isMultiSelectModeDependencies = (deps: unknown): deps is MultiSelectModeDependencies =>
  isBaseShortcutDependencies(deps) &&
  typeof deps === 'object' && deps !== null &&
  'selectedBlocks' in deps && Array.isArray(deps.selectedBlocks) && (deps.selectedBlocks as unknown[]).every(b => b instanceof Block) &&
  'anchorBlock' in deps && (deps.anchorBlock === null || deps.anchorBlock instanceof Block);

export const defaultActionContextConfigs: readonly ActionContextConfig[] = [
  {
    type: ActionContextTypes.GLOBAL,
    displayName: 'Global',
    validateDependencies: isBaseShortcutDependencies,
  },
  {
    type: ActionContextTypes.NORMAL_MODE,
    displayName: 'Normal Mode',
    validateDependencies: isBlockShortcutDependencies,
  },
  {
    type: ActionContextTypes.EDIT_MODE_CM,
    displayName: 'Edit Mode (CodeMirror)',
    defaultEventOptions: {
      preventDefault: false,
    },
    eventFilter: (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      return target?.closest('.cm-editor') !== null
    },
    validateDependencies: isCodeMirrorEditModeDependencies,
  },
  {
    type: ActionContextTypes.PROPERTY_EDITING,
    displayName: 'Property Editing',
    validateDependencies: isPropertyEditingDependencies,
  },
  {
    type: ActionContextTypes.COMMAND_PALETTE,
    displayName: 'Command Palette',
    validateDependencies: isCommandPaletteDependencies,
  },
  {
    type: ActionContextTypes.MULTI_SELECT_MODE,
    displayName: 'Multi-Select Mode',
    validateDependencies: isMultiSelectModeDependencies,
  },
]

const defaultContextConfigs = new Map<ActionContextType, ActionContextConfig>(
  defaultActionContextConfigs.map(config => [config.type, config]),
)

const defaultEventFilter = (event: KeyboardEvent) => {
  return !(isSingleKeyPress(event) && hasEditableTarget(event))
}

const normalizeKeys = (keys: string | string[]): string[] =>
  Array.isArray(keys) ? keys : [keys]

const bindingKeySignature = (keys: string | string[]): string =>
  [...normalizeKeys(keys)].sort().join('|')

export class ActionManager {
  private actions: Map<string, Action> = new Map()
  private bindings: Map<string, ShortcutBinding[]> = new Map()
  private activeContexts: Map<ActionContextType, BaseShortcutDependencies> = new Map()
  private contexts: Map<ActionContextType, ActionContextConfig>
  /**
   * Reference count for globally-bound hotkey keys. `hotkeys.unbind(key)`
   * removes all handlers for that key, so we only unbind once no live
   * action still wants it.
   */
  private keyRefs: Map<string, number> = new Map()
  private activationListeners: Set<() => void> = new Set()
  /**
   * Cached snapshot of active context type ids. Identity changes only when
   * activations actually change, allowing useSyncExternalStore consumers
   * to bail out cheaply.
   */
  private activeContextTypesSnapshot: readonly ActionContextType[] = []

  constructor(initialContexts: Map<ActionContextType, ActionContextConfig> = defaultContextConfigs) {
    this.contexts = new Map(initialContexts)

    hotkeys.filter = (event) => {
      const approvedInContext = Array.from(this.activeContexts.keys())
        .some(contextType => this.contexts.get(contextType)?.eventFilter?.(event))

      return approvedInContext || defaultEventFilter(event)
    }
  }

  /**
   * Synchronize the engine with a FacetRuntime. Diffs the desired set of
   * actions/contexts against the engine's current state and updates
   * hotkeys-js bindings accordingly.
   */
  sync(runtime: FacetRuntime): void {
    const contextConfigs = runtime.read(actionContextsFacet)
    const actionConfigs = runtime.read(actionsFacet)

    // Upsert contexts (last-write-wins, matching prior registerContext semantics).
    for (const config of contextConfigs) {
      this._upsertContext(config)
    }

    const desiredActionIds = new Set<string>()
    for (const actionConfig of actionConfigs) {
      desiredActionIds.add(actionConfig.id)
      this._upsertAction(actionConfig)
    }

    // Remove actions that are no longer contributed.
    for (const existingId of Array.from(this.actions.keys())) {
      if (!desiredActionIds.has(existingId)) {
        this._removeAction(existingId)
      }
    }
  }

  private _upsertContext<T extends ActionContextType>(config: ActionContextConfig<T>): void {
    this.contexts.set(config.type, config)
  }

  private _upsertAction<T extends ActionContextType>(config: ActionConfig<T>): void {
    const nextAction = createAction(config) as unknown as Action
    const previous = this.actions.get(nextAction.id)

    const prevBindingSignature = previous?.defaultBinding
      ? bindingKeySignature(previous.defaultBinding.keys)
      : null
    const nextBindingSignature = nextAction.defaultBinding
      ? bindingKeySignature(nextAction.defaultBinding.keys)
      : null

    const isSameHandler = previous?.handler === nextAction.handler
    const isSameContext = previous?.context === nextAction.context
    const isSameBinding = prevBindingSignature === nextBindingSignature

    if (previous && isSameHandler && isSameContext && isSameBinding) {
      // Nothing meaningful changed. Update stored config (description etc.) and bail out.
      this.actions.set(nextAction.id, nextAction)
      return
    }

    // Something changed (or this is new). Tear down any existing bindings
    // for this action, then re-register fresh.
    if (previous) {
      this._removeAction(nextAction.id)
    }

    this.actions.set(nextAction.id, nextAction)

    if (nextAction.defaultBinding) {
      this._upsertBinding({
        ...nextAction.defaultBinding,
        action: nextAction.id,
      })
    }
  }

  private _upsertBinding(binding: ShortcutBinding): void {
    const action = this.actions.get(binding.action)
    if (!action) {
      throw new Error(`Action ${binding.action} not registered`)
    }

    const actionBindings = this.bindings.get(binding.action) || []

    const bindingExists = actionBindings.some(existing =>
      bindingKeySignature(existing.keys) === bindingKeySignature(binding.keys),
    )

    if (bindingExists) {
      return
    }

    actionBindings.push(binding)
    this.bindings.set(binding.action, actionBindings)

    if (this.activeContexts.has(action.context)) {
      this.registerHotkey(binding, action)
    }
  }

  /**
   * Remove an action and all of its hotkey bindings, releasing reference
   * counts on any globally-bound keys.
   */
  private _removeAction(actionId: string): void {
    const action = this.actions.get(actionId)
    if (!action) return

    const bindings = this.bindings.get(actionId) || []
    const contextActive = this.activeContexts.has(action.context)

    if (contextActive) {
      for (const binding of bindings) {
        for (const key of normalizeKeys(binding.keys)) {
          this.releaseKey(key)
        }
      }
    }

    this.bindings.delete(actionId)
    this.actions.delete(actionId)
  }

  private handleEvent(event: KeyboardEvent, binding: ShortcutBinding, action: Action): boolean {
    if (!this.activeContexts.has(action.context)) {
      return true
    }

    const contextConfig = this.contexts.get(action.context)

    // Determine event handling options, with precedence:
    // 1. Binding-specific options
    // 2. Context default options
    // 3. Global defaults (prevent default and stop propagation)
    const options: EventOptions = {
      preventDefault: true,
      stopPropagation: false,
      ...contextConfig?.defaultEventOptions,
      ...binding.eventOptions,
    }

    if (options.stopPropagation) {
      event.stopPropagation()
    }
    if (options.preventDefault) {
      console.debug(`[ShortcutManager] Preventing default for action: ${action.id}, context: ${action.context}`)
      event.preventDefault()
    }

    this.runActionById(action.id, event)

    return !options.preventDefault
  }

  private registerHotkey(binding: ShortcutBinding, action: Action): void {
    for (const key of normalizeKeys(binding.keys)) {
      this.retainKey(key)
      hotkeys(key, (event) => {
        // Another action may share this key; only the action whose context is
        // currently active should actually fire.
        if (!this.activeContexts.has(action.context)) return true
        return this.handleEvent(event, binding, action)
      })
    }
  }

  private retainKey(key: string): void {
    this.keyRefs.set(key, (this.keyRefs.get(key) ?? 0) + 1)
  }

  private releaseKey(key: string): void {
    const count = this.keyRefs.get(key) ?? 0
    if (count <= 1) {
      this.keyRefs.delete(key)
      hotkeys.unbind(key)
    } else {
      this.keyRefs.set(key, count - 1)
    }
  }

  private updateActiveContextTypesSnapshot(): void {
    this.activeContextTypesSnapshot = Array.from(this.activeContexts.keys())
  }

  private emitActivationChange(): void {
    this.updateActiveContextTypesSnapshot()
    for (const listener of this.activationListeners) {
      try {
        listener()
      } catch (error) {
        console.error('[ShortcutManager] Activation listener threw', error)
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.activationListeners.add(listener)
    return () => {
      this.activationListeners.delete(listener)
    }
  }

  activateContext(context: ActionContextType, dependencies: BaseShortcutDependencies): void {
    const contextConfig = this.contexts.get(context)
    if (!contextConfig) {
      throw new Error(`[ShortcutManager] Attempted to activate unregistered context: ${context}`)
    }

    if (!contextConfig.validateDependencies(dependencies)) {
      throw new Error(`[ShortcutManager] Invalid dependencies provided for context ${context}. Activation failed. ${{
        expected: `Implementation of ShortcutDependenciesMap['${context}']`,
        provided: dependencies,
      }}`)
    }

    // Ensure context is removed before re-adding to potentially update order if map maintains insertion order
    this.deactivateContext(context)

    this.activeContexts.set(context, dependencies)

    this.actions.forEach((action, actionId) => {
      if (action.context === context) {
        const bindings = this.bindings.get(actionId) || []
        bindings.forEach(binding => this.registerHotkey(binding, action))
      }
    })

    this.emitActivationChange()
  }

  deactivateContext(context: ActionContextType): void {
    if (!this.activeContexts.has(context)) {
      return
    }

    this.activeContexts.delete(context)

    this.actions.forEach((action, actionId) => {
      if (action.context === context) {
        const bindings = this.bindings.get(actionId) || []
        bindings.forEach(binding => {
          for (const key of normalizeKeys(binding.keys)) {
            this.releaseKey(key)
          }
        })
      }
    })

    this.emitActivationChange()
  }

  reset(): void {
    hotkeys.unbind()
    this.activeContexts.clear()
    this.keyRefs.clear()
    this.emitActivationChange()
  }

  /**
   * Retrieves detailed information about the currently active contexts,
   * including their configuration and dependencies.
   * The order might reflect activation order depending on Map implementation specifics.
   */
  getActiveContexts(): ActiveContextInfo[] {
    return Array.from(this.activeContexts.entries()).map(([contextType, dependencies]) =>
      ({config: this.contexts.get(contextType)!, dependencies}))
  }

  /**
   * Returns a cached snapshot (stable identity between activation changes)
   * of the currently active context types. Intended for useSyncExternalStore.
   */
  getActiveContextTypesSnapshot(): readonly ActionContextType[] {
    return this.activeContextTypesSnapshot
  }

  /**
   * Retrieves all actions whose context is currently active.
   */
  getAvailableActions(): Action[] {
    const activeContextTypes = Array.from(this.activeContexts.keys())
    return Array.from(this.actions.values()).filter(action =>
      activeContextTypes.includes(action.context),
    )
  }

  /**
   * Retrieves all registered bindings for a given action ID.
   * @param actionId The ID of the action.
   * @returns An array of ShortcutBinding objects, or an empty array if no bindings are found.
   */
  getBindingsForAction(actionId: string): ShortcutBinding[] {
    return this.bindings.get(actionId) || []
  }

  /**
   * Attempts to run an action by its ID if its context is active.
   * @param actionId The ID of the action to run.
   * @returns True if the action was found, its context was active, dependencies validated, and handler executed. False otherwise.
   */
  runActionById(actionId: string, trigger: ActionTrigger): void | Promise<void> {
    const action = this.actions.get(actionId)
    if (!action) {
      throw new Error(`[ShortcutManager] Action with ID "${actionId}" not found.`)
    }

    if (!this.activeContexts.has(action.context)) {
      throw new Error(`[ShortcutManager] Cannot run action "${actionId}". Context "${action.context}" is not active.`)
    }

    const dependencies = this.activeContexts.get(action.context)!

    return action.handler(dependencies, trigger)
  }
}

export const actionManager = new ActionManager()
