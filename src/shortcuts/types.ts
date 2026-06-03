import type { ComponentType, SVGProps } from 'react';
import { Block } from '../data/block';
import { EditorView } from '@codemirror/view'

/** Action icon — same SVG-component shape lucide-react emits, so the
 *  default action set can use those directly without an adapter. The
 *  type stays SVG-only on purpose: actions render in command palettes,
 *  toolbars, and menus where a vector glyph is the only sensible shape. */
export type ActionIcon = ComponentType<SVGProps<SVGSVGElement>>

export type KeyCombination = string; // e.g. "ctrl+k", "meta+shift+z"

/**
 * Precedence tier for a context, used when two active contexts bind the
 * same chord. Named tiers (CodeMirror `Prec` precedent), deliberately NOT
 * raw integers — keep the set tiny and add a tier only when a real case
 * needs it. Ordering among the remaining contexts is `high` ▸ `default` ▸
 * `low`; `global` is a reserved tier above all of these and an active
 * `modal` context outranks even `global`. Defaults to `'default'`.
 */
export type Priority = 'low' | 'default' | 'high';

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
   * Precedence tier when two active contexts bind the same chord. Higher
   * tiers win; ties fall back to activation recency. Orders the
   * non-`global`, non-`modal` contexts among themselves — `global` sits
   * above all priorities and an active `modal` above `global`. Defaults to
   * `'default'`. See {@link Priority}.
   */
  priority?: Priority;
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
  /** Root of the visible subtree the action runs within (see
   *  `BlockContextType.scopeRootId`). Structural and navigation
   *  handlers use this as the surface boundary instead of reading the
   *  panel's `topLevelBlockId`, so they behave correctly inside nested
   *  surfaces (backlinks, embeds). Injected centrally for block
   *  surfaces by `useShortcutSurfaceActivations`; defaults to the
   *  panel's zoom root for the main outline. */
  scopeRootId?: string;
  /** Whether the surface force-opens its scope root regardless of the
   *  root's own collapse flag (true for focal panel/top-level roots,
   *  false for nested surface roots that honour collapse). Navigation
   *  primitives use it so they don't descend into a collapsed nested
   *  root whose children aren't rendered. Defaults to true (focal). */
  scopeRootForcesOpen?: boolean;
}

export interface BlockShortcutDependencies  extends BaseShortcutDependencies {
  block: Block;
  renderScopeId?: string;
}

export interface CodeMirrorEditModeDependencies extends BlockShortcutDependencies {
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

/**
 * Activation primitives surfaced to action handlers as the optional third
 * argument. Handlers can `dispatch.activate(...)` to enter a modal mode
 * (e.g. date-scrub's hold-to-enter-mode path) or `dispatch.deactivate(...)`
 * to exit, without needing a React context.
 *
 * Always supplied when an action fires through `HotkeyReconciler` or
 * `runActionById` / `useRunAction`. May be undefined when an action is
 * invoked from a decorator that doesn't forward the third argument —
 * which is fine: only handlers that need it bother to type-check for it.
 */
export interface ActionDispatch {
  activate: (context: ActionContextType, dependencies: BaseShortcutDependencies) => void
  deactivate: (context: ActionContextType) => void
}

export type ActionHandler<T extends ActionContextType = ActionContextType> = {
  bivarianceHack(
    dependencies: ShortcutDependenciesMap[T],
    trigger: ActionTrigger,
    dispatch?: ActionDispatch,
  ): void | Promise<void>
}['bivarianceHack']

export type ActionCanRun<T extends ActionContextType = ActionContextType> = {
  bivarianceHack(dependencies: ShortcutDependenciesMap[T]): boolean
}['bivarianceHack']

export interface Action<T extends ActionContextType = ActionContextType> {
  id: string;
  description: string;
  context: T;
  handler: ActionHandler<T>;
  defaultBinding?: ShortcutBindingDefaults; // Optional default binding
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


interface ShortcutBindingFields {
  keys: KeyCombination | KeyCombination[];
  eventOptions?: EventOptions; // Event handling options for this binding
}

/**
 * Shape an action author provides as `defaultBinding`. Discriminated by
 * `phase` so `holdMs` is required exactly when `phase === 'hold'` and
 * forbidden otherwise:
 *  - `'keydown'` (default) — fires on press.
 *  - `'keyup'` — fires on release. tinykeys' matcher accepts a bare modifier
 *    name as the key (`'Shift'`, `'Control'`); for letter chords prefer the
 *    same key string you'd use on keydown (`'$mod+s'`).
 *  - `'hold'` — fires after the chord has been held for `holdMs`. Released
 *    before the threshold = no fire. Sequence chords (`'g g'`) are
 *    rejected at install time.
 */
export type ShortcutBindingDefaults =
  | (ShortcutBindingFields & {phase?: 'keydown' | 'keyup'; holdMs?: never})
  | (ShortcutBindingFields & {phase: 'hold'; holdMs: number});

/**
 * Fully-realized binding — adds the owning action id to
 * `ShortcutBindingDefaults`. Used by surfaces that list bindings
 * (command palette, keybindings settings) and need to know which
 * action a chord belongs to.
 */
export type ShortcutBinding = ShortcutBindingDefaults & {
  action: string;
};
