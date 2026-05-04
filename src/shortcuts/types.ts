import { Block } from '../data/block';
import { EditorView } from '@codemirror/view'

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

export interface Action<T extends ActionContextType = ActionContextType> {
  id: string;
  description: string;
  context: T;
  handler: ActionHandler<T>;
  defaultBinding?: Omit<ShortcutBinding, 'action'>; // Optional default binding
}

export type ActionConfig<T extends ActionContextType = ActionContextType> = Action<T>


export interface ShortcutBinding {
  action: string;
  keys: KeyCombination | KeyCombination[];
  eventOptions?: EventOptions; // Event handling options for this binding
}
