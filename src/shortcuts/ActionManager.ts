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
  EditModeDependencies,
  PropertyEditingDependencies,
  CommandPaletteDependencies,
  ActiveContextInfo,
} from './types'
import { isSingleKeyPress, hasEditableTarget } from '@/shortcuts/utils.ts'
import { Block } from '@/data/block'

const isBaseShortcutDependencies = (deps: unknown): deps is BaseShortcutDependencies =>
  typeof deps === 'object' && deps !== null && 'uiStateBlock' in deps && deps.uiStateBlock instanceof Block

const isBlockShortcutDependencies = (deps: unknown): deps is BlockShortcutDependencies =>
  isBaseShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'block' in deps && deps.block instanceof Block

const isEditModeDependencies = (deps: unknown): deps is EditModeDependencies =>
  isBlockShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'textarea' in deps && deps.textarea instanceof HTMLTextAreaElement

const isPropertyEditingDependencies = (deps: unknown): deps is PropertyEditingDependencies =>
  isBlockShortcutDependencies(deps) && typeof deps === 'object' && deps !== null && 'input' in deps && deps.input instanceof HTMLInputElement

const isCommandPaletteDependencies = (deps: unknown): deps is CommandPaletteDependencies =>
  isBaseShortcutDependencies(deps)

const defaultContextConfigs = new Map<ActionContextType, ActionContextConfig>([
  [ActionContextTypes.GLOBAL, {
    type: ActionContextTypes.GLOBAL,
    displayName: 'Global',
    validateDependencies: isBaseShortcutDependencies,
  }],
  [ActionContextTypes.NORMAL_MODE, {
    type: ActionContextTypes.NORMAL_MODE,
    displayName: 'Normal Mode',
    validateDependencies: isBlockShortcutDependencies,
  }],
  [ActionContextTypes.EDIT_MODE, {
    type: ActionContextTypes.EDIT_MODE,
    displayName: 'Edit Mode',
    defaultEventOptions: {
      preventDefault: false,
    },
    eventFilter: (event: KeyboardEvent) => (event.target as HTMLElement)?.tagName === 'TEXTAREA',
    validateDependencies: isEditModeDependencies,
  }],
  [ActionContextTypes.PROPERTY_EDITING, {
    type: ActionContextTypes.PROPERTY_EDITING,
    displayName: 'Property Editing',
    validateDependencies: isPropertyEditingDependencies,
  }],
  [ActionContextTypes.COMMAND_PALETTE, {
    type: ActionContextTypes.COMMAND_PALETTE,
    displayName: 'Command Palette',
    validateDependencies: isCommandPaletteDependencies,
  }],
])

const defaultEventFilter = (event: KeyboardEvent) => {
  return !(isSingleKeyPress(event) && hasEditableTarget(event))
}

export class ActionManager {
  private actions: Map<string, Action> = new Map()
  private bindings: Map<string, ShortcutBinding[]> = new Map()
  private activeContexts: Map<ActionContextType, BaseShortcutDependencies> = new Map()
  private contexts: Map<ActionContextType, ActionContextConfig>

  constructor(initialContexts: Map<ActionContextType, ActionContextConfig> = defaultContextConfigs) {
    this.contexts = new Map(initialContexts)

    hotkeys.filter = (event) => {
      const approvedInContext = Array.from(this.activeContexts.keys())
        .some(contextType => this.contexts.get(contextType)?.eventFilter?.(event))

      return approvedInContext || defaultEventFilter(event)
    }
  }

  registerContext<T extends ActionContextType>(config: ActionContextConfig<T>): void {
    if (this.contexts.has(config.type)) {
      console.warn(`[ShortcutManager] Context ${config.type} already registered. Overwriting.`)
    }
    this.contexts.set(config.type, config)
    console.log(`[ShortcutManager] Registered context: ${config.type}`)
  }

  registerAction<T extends ActionContextType>(action: Action<T>): void {
    console.log(`[ShortcutManager] Registering action: ${action.id} for context: ${action.context}`)

    if (this.actions.has(action.id)) {
      console.warn(`[ShortcutManager] Action ${action.id} already registered`)
    }

    // Cast the specifically typed Action<T> to the map's expected Action type.
    // This bypasses the TS2345 error at the assignment site.
    // Runtime safety is ensured by validateDependencies and the cast in handleEvent.
    this.actions.set(action.id, action as unknown as Action)

    if (action.defaultBinding) {
      this.registerBinding({
        ...action.defaultBinding,
        action: action.id,
      })
    }
  }

  registerBinding(binding: ShortcutBinding): void {
    console.log(`[ShortcutManager] Registering binding for action: ${binding.action}, keys: ${binding.keys}`)
    const action = this.actions.get(binding.action)
    if (!action) {
      throw new Error(`Action ${binding.action} not registered`)
    }

    const actionBindings = this.bindings.get(binding.action) || []

    const bindingExists = actionBindings.some(existing => {
      const existingKeys = Array.isArray(existing.keys) ? existing.keys : [existing.keys]
      const newKeys = Array.isArray(binding.keys) ? binding.keys : [binding.keys]
      return JSON.stringify(existingKeys.sort()) === JSON.stringify(newKeys.sort())
    })

    if (bindingExists) {
      console.log(`[ShortcutManager] Binding for action ${binding.action} with keys ${binding.keys} already exists, skipping`)
      return
    }

    actionBindings.push(binding)
    this.bindings.set(binding.action, actionBindings)

    if (this.activeContexts.has(action.context)) {
      this.registerHotkey(binding, action)
    }
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
      event.preventDefault()
    }

    this.runActionById(action.id)

    return !options.preventDefault
  }

  private registerHotkey(binding: ShortcutBinding, action: Action): void {
    const keys = Array.isArray(binding.keys) ? binding.keys : [binding.keys]

    keys.forEach(key => {
      hotkeys(key, (event) => {
        console.log(`[ShortcutManager] Handling event for key: ${key}, action: ${action.id}, context: ${action.context}`)
        return this.handleEvent(event, binding, action)
      })
    })
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

    console.log(`[ShortcutManager] Activating context: ${context}`, {
      existingContexts: Array.from(this.activeContexts.keys()),
      dependencies,
      bindings: this.bindings,
    })

    // Ensure context is removed before re-adding to potentially update order if map maintains insertion order
    this.deactivateContext(context)
    this.activeContexts.set(context, dependencies)

    this.actions.forEach((action, actionId) => {
      if (action.context === context) {
        const bindings = this.bindings.get(actionId) || []
        bindings.forEach(binding => this.registerHotkey(binding, action))
      }
    })
  }

  deactivateContext(context: ActionContextType): void {
    console.log(`[ShortcutManager] Deactivating context: ${context}`)
    if (!this.activeContexts.has(context)) {
      console.log(`[ShortcutManager] Context ${context} was not active`)
      return
    }

    this.activeContexts.delete(context)

    this.actions.forEach((action, actionId) => {
      if (action.context === context) {
        const bindings = this.bindings.get(actionId) || []
        bindings.forEach(binding => {
          const keys = Array.isArray(binding.keys) ? binding.keys : [binding.keys]
          keys.forEach(key => hotkeys.unbind(key))
        })
      }
    })
  }

  reset(): void {
    hotkeys.unbind()
    this.activeContexts.clear()
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
  runActionById(actionId: string): void | Promise<void> {
    const action = this.actions.get(actionId)
    if (!action) {
      throw new Error(`[ShortcutManager] Action with ID "${actionId}" not found.`)
    }

    if (!this.activeContexts.has(action.context)) {
      throw new Error(`[ShortcutManager] Cannot run action "${actionId}". Context "${action.context}" is not active.`)
    }

    const dependencies = this.activeContexts.get(action.context)!

    console.log(`[ShortcutManager] Running action "${actionId}" from command palette.`)
    return action.handler(dependencies)
  }
}

export const actionManager = new ActionManager()
