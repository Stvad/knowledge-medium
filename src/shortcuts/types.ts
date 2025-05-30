import { Block } from '@/data/block';
import { Optional } from '@/utils/types.ts'
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
  /** User-friendly name for this context, shown in the command palette. */
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

export type ActionContextType =
  | 'global'
  | 'normal-mode'
  | 'edit-mode'
  | 'edit-mode-cm'
  | 'property-editing'
  | 'command-palette'
  | 'multi-select-mode'

export const ActionContextTypes = {
  GLOBAL: 'global',
  NORMAL_MODE: 'normal-mode',
  EDIT_MODE: 'edit-mode',
  EDIT_MODE_CM: 'edit-mode-cm',
  PROPERTY_EDITING: 'property-editing',
  COMMAND_PALETTE: 'command-palette',
  MULTI_SELECT_MODE: 'multi-select-mode',
} as const;

export interface BaseShortcutDependencies {
  uiStateBlock: Block;
}

export interface BlockShortcutDependencies  extends BaseShortcutDependencies {
  block: Block;
}

export interface EditModeDependencies extends BlockShortcutDependencies {
  textarea: HTMLTextAreaElement;
}

export interface CodeMirrorEditModeDependencies extends BaseShortcutDependencies {
  block: Block;
  editorView: EditorView;
}

export interface PropertyEditingDependencies extends BlockShortcutDependencies {
  input: HTMLInputElement;
}

export type CommandPaletteDependencies =  BaseShortcutDependencies

export interface MultiSelectModeDependencies extends BaseShortcutDependencies {
  selectedBlocks: Block[];
  anchorBlock: Block | null; // The block that started a shift-selection range
}

export interface ShortcutDependenciesMap {
  [ActionContextTypes.GLOBAL]: BaseShortcutDependencies;
  [ActionContextTypes.NORMAL_MODE]: BlockShortcutDependencies;
  [ActionContextTypes.EDIT_MODE]: EditModeDependencies;
  [ActionContextTypes.EDIT_MODE_CM]: CodeMirrorEditModeDependencies;
  [ActionContextTypes.PROPERTY_EDITING]: PropertyEditingDependencies;
  [ActionContextTypes.COMMAND_PALETTE]: CommandPaletteDependencies;
  [ActionContextTypes.MULTI_SELECT_MODE]: MultiSelectModeDependencies;
}

export interface ActiveContextInfo {
  config: ActionContextConfig;
  dependencies: BaseShortcutDependencies;
}

export type ActionTrigger = KeyboardEvent | CustomEvent

export interface Action<T extends ActionContextType = ActionContextType> {
  id: string;
  description: string;
  context: T;
  handler: (dependencies: ShortcutDependenciesMap[T], trigger: ActionTrigger) => void | Promise<void>;
  defaultBinding?: Omit<ShortcutBinding, 'action'>; // Optional default binding
  hideFromCommandPallet?: boolean;
}

export type ActionConfig<T extends ActionContextType = ActionContextType> = Optional<
  Action<T>,
  'hideFromCommandPallet'
>;


export interface ShortcutBinding {
  action: string;
  keys: KeyCombination | KeyCombination[];
  eventOptions?: EventOptions; // Event handling options for this binding
}
