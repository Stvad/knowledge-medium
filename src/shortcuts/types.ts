import type { ComponentType, SVGProps } from 'react';
import { Block } from '../data/block';
import { EditorView } from '@codemirror/view'

/** Action icon — same SVG-component shape lucide-react emits, so the
 *  default action set can use those directly without an adapter. The
 *  type stays SVG-only on purpose: actions render in command palettes,
 *  toolbars, and menus where a vector glyph is the only sensible shape. */
export type ActionIcon = ComponentType<SVGProps<SVGSVGElement>>

export type KeyCombination = string; // e.g. "ctrl+k", "meta+shift+z"

export interface EventOptions {
  preventDefault?: boolean;
  stopPropagation?: boolean;
}

export type DependencyValidator<T extends ActionContextType> = (
  dependencies: unknown
) => dependencies is ShortcutDependenciesMap[T];

export interface ActionContextConfig<T extends ActionContextType = ActionContextType> {
  type: T;
  /** User-friendly name for this context, shown in shortcut-aware UI. */
  displayName: string;
  defaultEventOptions?: EventOptions;
  /**
   * Optional filter function to determine if the context should handle the event.
   * If any active context's eventFilter returns true, the event is processed.
   * If no active context's eventFilter returns true, the defaultEventFilter is used.
   */
  eventFilter?: (event: KeyboardEvent) => boolean;
  /**
   * When true, this context shadows every other active context (except
   * `global`) for the duration of its activation: only this context's and
   * `global`'s bindings install. Use for modes that should claim keyboard
   * focus — command palette, multi-select, property editing, scrub. If
   * multiple modal contexts are active, the most-recently-activated one
   * wins (per `ActiveContextsMap` insertion order). `global` stays
   * installed so app-wide chords (Cmd+K, Escape) remain reachable.
   */
  modal?: boolean;
  /**
   * Type guard function to validate the dependencies provided when activating the context.
   */
  validateDependencies: DependencyValidator<T>;
}

export type BuiltInActionContextType =
  | 'global'
  | 'normal-mode'
  | 'edit-mode-cm'
  | 'property-editing'
  | 'multi-select-mode'

export type ActionContextType = BuiltInActionContextType | (string & {})

export const ActionContextTypes = {
  GLOBAL: 'global',
  NORMAL_MODE: 'normal-mode',
  EDIT_MODE_CM: 'edit-mode-cm',
  PROPERTY_EDITING: 'property-editing',
  MULTI_SELECT_MODE: 'multi-select-mode',
} as const;

export interface BaseShortcutDependencies {
  uiStateBlock: Block;
}

export interface BlockShortcutDependencies  extends BaseShortcutDependencies {
  block: Block;
  visualTargetId?: string;
}

export interface CodeMirrorEditModeDependencies extends BaseShortcutDependencies {
  block: Block;
  editorView: EditorView;
}

export interface PropertyEditingDependencies extends BlockShortcutDependencies {
  input: HTMLInputElement;
}

export interface MultiSelectModeDependencies extends BaseShortcutDependencies {
  selectedBlocks: Block[];
  anchorBlock: Block | null; // The block that started a shift-selection range
}

export interface ShortcutDependenciesMap {
  [context: string]: BaseShortcutDependencies;
  [ActionContextTypes.GLOBAL]: BaseShortcutDependencies;
  [ActionContextTypes.NORMAL_MODE]: BlockShortcutDependencies;
  [ActionContextTypes.EDIT_MODE_CM]: CodeMirrorEditModeDependencies;
  [ActionContextTypes.PROPERTY_EDITING]: PropertyEditingDependencies;
  [ActionContextTypes.MULTI_SELECT_MODE]: MultiSelectModeDependencies;
}

export interface ActiveContextInfo {
  config: ActionContextConfig;
  dependencies: BaseShortcutDependencies;
}

export interface ActionContextActivation {
  context: ActionContextType;
  dependencies?: Record<string, unknown> | null;
  enabled?: boolean;
}

export type ActionTrigger = KeyboardEvent | CustomEvent

export type ActionHandler<T extends ActionContextType = ActionContextType> = {
  bivarianceHack(dependencies: ShortcutDependenciesMap[T], trigger: ActionTrigger): void | Promise<void>
}['bivarianceHack']

export type ActionCanRun<T extends ActionContextType = ActionContextType> = {
  bivarianceHack(dependencies: ShortcutDependenciesMap[T]): boolean
}['bivarianceHack']

export interface Action<T extends ActionContextType = ActionContextType> {
  id: string;
  description: string;
  context: T;
  handler: ActionHandler<T>;
  defaultBinding?: Omit<ShortcutBinding, 'action'>; // Optional default binding
  /** Optional icon for surfaces that render actions visually (toolbars,
   *  swipe menus, eventual command-palette icon column). Surfaces that
   *  don't render icons just ignore the field. */
  icon?: ActionIcon;
  /** Optional synchronous predicate for "is this action meaningfully
   *  applicable to its current dependencies?". Surfaces that list
   *  actions (command palette, swipe menu) hide the action when this
   *  returns false, so the user doesn't see an entry that would silently
   *  no-op. It is NOT a security gate on `handler` — direct callers can
   *  still invoke a handler whose `canRun` is false; the contract is
   *  presentational. Omit to mean "always applicable when the context is
   *  active". */
  canRun?: ActionCanRun<T>;
}

export type ActionConfig<T extends ActionContextType = ActionContextType> = Action<T>

export interface ActionOverride<T extends ActionContextType = ActionContextType> {
  actionId: string;
  context?: T;
  apply: (action: ActionConfig<T>) => ActionConfig<T> | null;
}

export interface ActionDecorator<T extends ActionContextType = ActionContextType> {
  actionId: string;
  context?: T;
  decorate: (action: ActionConfig<T>) => ActionConfig<T>;
}


export interface ShortcutBinding {
  action: string;
  keys: KeyCombination | KeyCombination[];
  eventOptions?: EventOptions; // Event handling options for this binding
}
