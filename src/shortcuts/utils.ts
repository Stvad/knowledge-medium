import type { Block } from '@/data/block'
import {
  ActionConfig,
  Action,
  ActionContextType,
  ActionContextTypes,
  ActionIcon,
  BlockShortcutDependencies,
  MultiSelectModeDependencies,
  ShortcutDependenciesMap, ActionTrigger,
} from './types'
import { withMoveTransition } from '@/utils/viewTransition'
import { invokeAction } from './actionDispatch.ts'

export const hasEditableTarget = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement
  if (!target) return false

  return target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA'
}

/**
 * True for keyboard events shaped like "the user is typing into an editable
 * field" — no chord-modifiers (Ctrl/Alt/Meta). Shift is permitted because
 * it's part of producing capital letters and shifted symbols.
 *
 * Used by the default hotkeys-js event filter ([HotkeyReconciler.tsx]) to
 * suppress shortcut handlers for bare `p`, `P` (= shift+p), `!` (= shift+1),
 * Enter, Tab, etc. when focus is in an input. Modifier-bearing chords like
 * `cmd+p` are NOT typing and stay unblocked — the user pressed those to
 * address the app, not the input.
 */
export const isTypingKeyEvent = (event: KeyboardEvent): boolean =>
  !event.ctrlKey && !event.altKey && !event.metaKey

/**
 * Recover the logical letter of a keyboard event when an Alt or Meta
 * modifier has corrupted `event.key`.
 *
 * `event.key` is unreliable for letter-keys under Alt/Meta:
 *   - macOS option-transforms (Alt+y → '¥', Alt+z → 'Ω', …) on every layout.
 *   - Linux xkb compose / dead-key setups that emit composing chars
 *     when Alt is held.
 *
 * `event.code` is layout-INdependent — it reports the QWERTY-position
 * id ('KeyY') even when the user is on Colemak/Dvorak. So matching on
 * `event.code === 'KeyY'` works on Mac QWERTY but not on Mac Colemak,
 * where the user's logical 'y' sits at the physical KeyO position.
 *
 * `event.keyCode` is what hotkeys-js used to get right. Modern browsers
 * populate it for printable letters with the *logical* letter's char
 * code — i.e. the letter the layout produces, derived before any
 * modifier-induced transformation. So a Mac Colemak user pressing
 * Alt+y gives `event.keyCode = 89` ('Y') regardless of `event.key`
 * being a transformed glyph and `event.code` reporting KeyO.
 *
 * This helper returns the event unchanged when no recovery is needed,
 * or a Proxy that overrides `event.key` with the recovered lowercase
 * letter. Proxy (not spread/clone) so `getModifierState` and other
 * prototype methods stay callable for tinykeys' matcher.
 *
 * Scope: letters only (`keyCode` in [65,90]) and only when Alt or
 * Meta is held. Digit/punctuation keyCodes are layout-dependent in a
 * way keyCode can't recover; those bindings use Digit{N} / code-form
 * chord strings.
 */
const ASCII_A = 65
const ASCII_Z = 90

export const withRecoveredLetterKey = (event: KeyboardEvent): KeyboardEvent => {
  if (!event.altKey && !event.metaKey) return event
  const keyCode = event.keyCode
  if (keyCode < ASCII_A || keyCode > ASCII_Z) return event
  const recovered = String.fromCharCode(keyCode).toLowerCase()
  if (event.key.toLowerCase() === recovered) return event
  // Proxy preserves prototype methods (getModifierState, preventDefault).
  // We can't reassign event.key directly because KeyboardEvent props
  // are non-writable in jsdom and read-only via accessor in real browsers.
  //
  // Critical: read via `Reflect.get(target, prop)` (receiver omitted,
  // defaults to target) — NOT `Reflect.get(target, prop, receiver)`.
  // KeyboardEvent's accessor properties (code, repeat, isComposing, …)
  // have opaque brand checks that throw "'get code' called on an object
  // that does not implement interface KeyboardEvent" if their getter
  // runs with `this` set to a Proxy. Passing `target` as receiver binds
  // those getters to the real event.
  return new Proxy(event, {
    get(target, prop) {
      if (prop === 'key') return recovered
      const value = Reflect.get(target, prop)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export const createAction = <T extends ActionContextType>(config: ActionConfig<T>): Action<T> => ({
  ...config,
})

/**
 * Creates a multi-select version of an action that applies the original action to each selected block.
 * Uses makeModeAction under the hood with a specialized handler override.
 */
export const applyToAllBlocksInSelection = <T extends ActionContextType>(
  actionConfig: ActionConfig<T>,
  {applyInReverseOrder}: {applyInReverseOrder?: boolean} = { applyInReverseOrder: false},
): ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE> => {
  // Default behavior: apply the original action to each selected block.
  // Wrap the whole batch in one view transition so users see a single
  // crossfade from "all selected" to "all applied" instead of N
  // separate transitions (each one would cancel the previous,
  // dropping all but the last block's animation). The per-action
  // wraps inside the inner handlers are reentrancy-suppressed.
  const multiSelectHandler = async (multiSelectDeps: MultiSelectModeDependencies, trigger: ActionTrigger) => {
    const {selectedBlocks, uiStateBlock, scopeRootId} = multiSelectDeps
    const blocks = applyInReverseOrder ? selectedBlocks.toReversed() : selectedBlocks
    console.log(`[makeMultiSelect] Running action for ${blocks.length} blocks`)

    // todo Wrap all per-block actions into a single repo.tx so undo
    // collapses the bulk action into one entry; today each per-block
    // action commits its own tx and is its own undo step.

    // Route each per-block sub-invocation through the dispatch choke so the
    // action-dispatch middleware (telemetry, guards, redirects) covers the
    // multi-select fan-out the same as a single dispatch. `repo.facetRuntime`
    // is the live runtime; the early-boot / minimal-harness path with no
    // runtime falls back to calling the handler directly.
    const runtime = uiStateBlock.repo.facetRuntime
    await withMoveTransition(async () => {
      // Process blocks sequentially, awaiting each one before proceeding
      for (const block of blocks) {
        // Convert dependencies to match the original action's context
        const originalDeps = {
          block,
          uiStateBlock,
          scopeRootId,
        } as ShortcutDependenciesMap[T]

        await (runtime
          ? invokeAction(runtime, {action: actionConfig as ActionConfig, deps: originalDeps, trigger})
          : actionConfig.handler(originalDeps, trigger))
      }
    })
  }

  return makeMultiSelect({
    ...actionConfig,
    description: `${actionConfig.description} (Multiple Blocks)`,
    handler: multiSelectHandler as ActionConfig['handler'],
  })
}

/**
 * Creates a higher-order function that transforms an action config for a specific mode.
 * This allows creating mode-specific action transformers like makeNormalMode, makeVisualMode, etc.
 *
 * @param mode The mode context type to transform the action into
 * @param idPrefix The prefix to add to the action ID (e.g. 'normal', 'visual', etc)
 * @returns A function that transforms an action config for the specified mode
 */
export const makeModeAction = <TargetMode extends ActionContextType>(
  mode: TargetMode,
  idPrefix: string,
) => {
  return <T extends ActionContextType>(
    actionConfig: ActionConfig<T>,
  ): ActionConfig<TargetMode> => ({
    ...actionConfig,
    id: `${idPrefix}.${actionConfig.id}`,
    context: mode,
  } as ActionConfig<TargetMode>)
}

export const makeNormalMode = makeModeAction(ActionContextTypes.NORMAL_MODE, 'normal')
export const makeCMMode = makeModeAction(ActionContextTypes.EDIT_MODE_CM, 'edit.cm')
export const makeMultiSelect = makeModeAction(ActionContextTypes.MULTI_SELECT_MODE, 'multi_select')

export interface DefineBlocksActionConfig {
  /** Id for the NORMAL_MODE variant. The MULTI_SELECT_MODE variant
   *  is registered under `multi_select.<id>` (matching the
   *  `makeMultiSelect` convention) so dispatch by id stays
   *  unambiguous when both contexts are active simultaneously —
   *  e.g. focus moves to an unselected block while a selection
   *  remains. */
  id: string
  /** Optional icon shown by any surface that renders actions. */
  icon?: ActionIcon
  /** Description shown for the NORMAL_MODE variant (e.g. "Tag
   *  block"). Appears in the command palette when a single block
   *  is focused. */
  blockDescription: string
  /** Description shown for the MULTI_SELECT_MODE variant
   *  (e.g. "Tag selected blocks"). Appears in the palette during a
   *  real multi-select and labels the group-header button. */
  blocksDescription: string
  /** Per-block applicability predicate. When provided, the
   *  NORMAL_MODE variant's `isVisible` gates on `appliesTo(block)`,
   *  and the MULTI_SELECT_MODE variant's `isVisible` gates on at
   *  least one selected block matching. Omit to mean "always". */
  appliesTo?: (block: Block) => boolean
  /** The actual operation. Both variants forward to this with the
   *  blocks they respectively hold (one or many). */
  flow: (blocks: readonly Block[]) => Promise<void> | void
}

export interface BlocksActionPair {
  block: ActionConfig<typeof ActionContextTypes.NORMAL_MODE>
  blocks: ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE>
}

/** Prefix used for the MULTI_SELECT_MODE variant's id. Mirrors the
 *  prefix emitted by `makeMultiSelect`, so an existing multi-select
 *  surface wired up via either path keeps the same id shape. */
const MULTI_SELECT_ID_PREFIX = 'multi_select'

export const multiSelectActionId = (baseId: string): string =>
  `${MULTI_SELECT_ID_PREFIX}.${baseId}`

/** Pair an "operation over a set of blocks" with the two natural
 *  action contexts: NORMAL_MODE (focused block as a one-element set)
 *  and MULTI_SELECT_MODE (the current selection).
 *
 *  Reach for this when the operation collects shared user input
 *  ONCE (a dialog asking for parameters, a confirm step, …) and
 *  then applies the result to every block in the set.
 *
 *  Why not `applyToAllBlocksInSelection`: that wrapper invokes the
 *  per-block handler N times for an N-block selection, which would
 *  prompt the user N times for any operation that opens a dialog
 *  in its handler. This helper passes the whole set into a single
 *  `flow` call instead.
 *
 *  The two variants get distinct ids (NORMAL: `id`, MULTI_SELECT:
 *  `multi_select.<id>`) because the command palette dispatches by
 *  id alone — `getActiveActionById` picks the most-recently-active
 *  matching context — so a shared id can route a click on the
 *  "block" row to the multi-select handler when both contexts are
 *  active. Distinct ids keep each row's behaviour grounded in the
 *  context it advertises. */
export const defineBlocksAction = ({
  id,
  icon,
  blockDescription,
  blocksDescription,
  appliesTo,
  flow,
}: DefineBlocksActionConfig): BlocksActionPair => ({
  block: {
    id,
    description: blockDescription,
    context: ActionContextTypes.NORMAL_MODE,
    ...(icon ? {icon} : {}),
    ...(appliesTo
      ? {isVisible: ({block}: BlockShortcutDependencies) => appliesTo(block)}
      : {}),
    handler: ({block}: BlockShortcutDependencies) => flow([block]),
  },
  blocks: {
    id: multiSelectActionId(id),
    description: blocksDescription,
    context: ActionContextTypes.MULTI_SELECT_MODE,
    ...(icon ? {icon} : {}),
    isVisible: ({selectedBlocks}: MultiSelectModeDependencies) => {
      if (selectedBlocks.length === 0) return false
      if (!appliesTo) return true
      return selectedBlocks.some(block => appliesTo(block))
    },
    handler: ({selectedBlocks}: MultiSelectModeDependencies) =>
      flow(selectedBlocks),
  },
})
