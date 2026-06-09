import type {
  ComponentType,
  MouseEvent as ReactMouseEvent,
  TouchEvent as ReactTouchEvent,
  SVGProps,
} from 'react';
import { Block } from '../data/block';
import { EditorView } from '@codemirror/view'
import type { PointerBindingSpec } from './canonicalizeChord.js'
import type { GestureBindingSpec } from './gestureBinding.js'

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
   * Whether actions in this context can be bound to a KEYBOARD chord. Defaults
   * to true. Set false for contexts dispatched some other way — e.g.
   * `block-pointer`, fired only by pointer gestures with supplied deps. Such
   * actions carry no keyboard `defaultBinding`, so they must NOT surface in the
   * keybindings editor as assignable, and must stay out of keyboard conflict
   * detection (an assigned chord would be a dead binding).
   */
  keyboardBindable?: boolean;
  /**
   * Optional gate for POINTER dispatch: when present and it returns false for a
   * pointer event, none of this context's actions are considered candidates for
   * that event. Lets a context declare "my gestures don't apply here" once,
   * centrally, instead of every action/handler re-checking — e.g. `block-pointer`
   * excludes clicks landing on interactive descendants (links, buttons) so they
   * keep their native behavior. Keys off the actual event target (works for
   * mouse and touch alike). Only consulted on the pointer path; ignored for
   * keyboard.
   */
  pointerTargetFilter?: (event: ReactMouseEvent<HTMLElement> | ReactTouchEvent<HTMLElement>) => boolean;
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
  | 'block-pointer'

export type ActionContextType = BuiltInActionContextType | (string & {})

export const ActionContextTypes = {
  GLOBAL: 'global',
  NORMAL_MODE: 'normal-mode',
  EDIT_MODE_CM: 'edit-mode-cm',
  PROPERTY_EDITING: 'property-editing',
  MULTI_SELECT_MODE: 'multi-select-mode',
  /**
   * Pointer-dispatched block gestures (shift-click selection, future
   * double-click-to-edit). Never auto-activated by a surface — it carries no
   * persistent state to install bindings against. Instead the block shell
   * dispatches a pointer event with the clicked block's deps SUPPLIED, and the
   * coordinator resolves candidates against those. The context exists only to
   * give those actions a home + a dependency validator.
   */
  BLOCK_POINTER: 'block-pointer',
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

/**
 * Dependencies for a pointer-dispatched block gesture. The clicked block plus
 * the DOM element the pointer event targeted — captured synchronously at
 * dispatch (React nulls `currentTarget` once the handler returns), so spatial
 * walkers can locate the clicked instance among visible blocks.
 */
export interface BlockPointerDependencies extends BlockShortcutDependencies {
  targetElement: HTMLElement;
}

export interface ShortcutDependenciesMap {
  [context: string]: BaseShortcutDependencies;
  [ActionContextTypes.GLOBAL]: BaseShortcutDependencies;
  [ActionContextTypes.NORMAL_MODE]: BlockShortcutDependencies;
  [ActionContextTypes.EDIT_MODE_CM]: CodeMirrorEditModeDependencies;
  [ActionContextTypes.PROPERTY_EDITING]: PropertyEditingDependencies;
  [ActionContextTypes.MULTI_SELECT_MODE]: MultiSelectModeDependencies;
  [ActionContextTypes.BLOCK_POINTER]: BlockPointerDependencies;
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

/**
 * The raw event handed to a handler as its second argument. Keyboard chords
 * deliver a `KeyboardEvent`, imperative/swipe callers a `CustomEvent`, and
 * pointer-bound actions a React `MouseEvent` (click/double-click) or
 * `TouchEvent` (tap) — whose `currentTarget` / coordinates the handler reads
 * synchronously before any await. The descriptor used for resolution/ordering
 * is internal to the coordinator and never reaches here.
 */
export type ActionTrigger =
  | KeyboardEvent
  | CustomEvent
  | ReactMouseEvent<HTMLElement>
  | ReactTouchEvent<HTMLElement>

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

/**
 * What an action handler returns. A SYNCHRONOUS `false` is the "not handled —
 * try the next candidate" sentinel (Option D): the single-winner coordinator
 * treats it as a third fall-through condition, identical to `resolveDeps → null`
 * and `canDispatch → false` — skip this candidate, never abort the loop.
 *
 * Everything else — `void`, `undefined`, or any `Promise` — counts as HANDLED
 * the moment the handler returns; the loop stops there and never awaits. A
 * `Promise` that resolves to `false` therefore does NOT fall through (the loop
 * can't await to find out which is why the sentinel is synchronous-only). The
 * type forbids `Promise<false>` because `Promise<false>` is not assignable to
 * `Promise<void>` — so a handler can't accidentally declare an async decline.
 *
 * Imperative `runActionById` / `useRunAction` ignore the sentinel: they have no
 * candidate list to fall through to, and coerce a `false` to `undefined`.
 */
export type ActionHandlerResult = void | false | Promise<void>

export type ActionHandler<T extends ActionContextType = ActionContextType> = {
  bivarianceHack(
    dependencies: ShortcutDependenciesMap[T],
    trigger: ActionTrigger,
    dispatch?: ActionDispatch,
  ): ActionHandlerResult
}['bivarianceHack']

export type ActionCanRun<T extends ActionContextType = ActionContextType> = {
  bivarianceHack(dependencies: ShortcutDependenciesMap[T]): boolean
}['bivarianceHack']

export interface Action<T extends ActionContextType = ActionContextType> {
  id: string;
  description: string;
  context: T;
  handler: ActionHandler<T>;
  defaultBinding?: ShortcutBindingDefaults; // Optional default keyboard binding
  /** Optional pointer (mouse) binding — dispatched through the same coordinator
   *  + `resolve` path as keyboard, but matched against a pointer event and
   *  supplied the clicked block's deps. A list binds the action to several
   *  pointer chords (e.g. ctrl-click OR meta-click both toggle selection), since
   *  modifier matching is exact-set. See {@link PointerBindingSpec}. */
  pointerBinding?: PointerBindingSpec | readonly PointerBindingSpec[];
  /** Optional continuous-gesture binding — names a gesture a recognizer emits
   *  (e.g. `{gesture: 'swipe-right'}`), dispatched through the same coordinator
   *  + `resolve` path as keyboard/pointer with the gesture's block deps
   *  supplied. The recognizer never names the action; the action names the
   *  gesture, symmetric with `pointerBinding`. A list binds several gestures.
   *  See {@link GestureBindingSpec} and docs/continuous-gesture-triggers.md. */
  gestureBinding?: GestureBindingSpec | readonly GestureBindingSpec[];
  /** Optional icon for surfaces that render actions visually (toolbars,
   *  swipe menus, eventual command-palette icon column). Surfaces that
   *  don't render icons just ignore the field. */
  icon?: ActionIcon;
  /** Optional synchronous predicate for "should this action be SHOWN as
   *  applicable to its current dependencies?". Surfaces that list actions
   *  (command palette, swipe menu) hide the action when this returns false,
   *  so the user doesn't see an entry that would silently no-op. Purely
   *  presentational — it does NOT gate dispatch: the keyboard path and direct
   *  callers (`runActionById`) still invoke the handler when `isVisible` is
   *  false. For a dispatch gate use `canDispatch`. Omit to mean "always
   *  visible when the context is active". */
  isVisible?: ActionCanRun<T>;
  /** Optional synchronous predicate gating keyboard DISPATCH. When present and
   *  it returns false for the resolved deps, the single-winner coordinator
   *  SKIPS this action and tries the next candidate for the chord — it does
   *  not swallow the chord. Distinct from `isVisible` (presentational) and
   *  from imperative `runActionById`, which does not consult it. Must be
   *  synchronous — the coordinator picks the winner within the event. Omit to
   *  mean "always dispatchable when the context is active and deps resolve". */
  canDispatch?: ActionCanRun<T>;
}

export type ActionConfig<T extends ActionContextType = ActionContextType> = Action<T>

/**
 * The single contributor shape for rewriting actions before dispatch.
 * `apply` maps an action to a new action, or to `null` to remove it (the
 * unbind primitive). `actionId` may be {@link WILDCARD_ACTION_ID} (`'*'`)
 * to match every action.
 *
 * Deliberately NOT generic in the context type. Erasing `T` keeps the
 * pipeline cast-free — the one widened→narrow cast lives at the
 * contributor's definition site (where it already narrows `deps`/`action`
 * to its context), not scattered through `effectiveActions`.
 */
export interface ActionTransform {
  actionId: string;
  context?: ActionContextType;
  apply: (action: ActionConfig) => ActionConfig | null;
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
