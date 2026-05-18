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

export const hasEditableTarget = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement
  if (!target) return false

  return target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA'
}

/**
 * Checks if a KeyboardEvent represents a single key press.
 * This means either:
 * 1. A non-modifier key was pressed with NO modifier keys active.
 * 2. A modifier key was pressed, and it was the ONLY modifier key active.
 *
 * Returns false for combinations like Shift+A, Ctrl+Shift, etc.
 *
 * @param {KeyboardEvent} event The keyboard event object.
 * @returns {boolean} True if the event represents a single key press (modifier or non-modifier), false otherwise.
 */
export function isSingleKeyPress(event: KeyboardEvent): boolean {
  // Basic validation
  if (!event || typeof event.key === 'undefined' || typeof event.ctrlKey === 'undefined') {
    console.error('Invalid input: Function expects a KeyboardEvent object.')
    return false
  }

  const key = event.key
  const ctrl = event.ctrlKey
  const shift = event.shiftKey
  const alt = event.altKey
  const meta = event.metaKey

  // Calculate how many distinct modifier keys are active *right now* according to the event state.
  // Note: If the key pressed *is* a modifier (e.g., 'Shift'), its corresponding flag (shiftKey) will be true.
  const activeModifierCount = (ctrl ? 1 : 0) + (shift ? 1 : 0) + (alt ? 1 : 0) + (meta ? 1 : 0)

  if (activeModifierCount === 0) {
    // Case 1: No modifiers are active. This means a non-modifier key was pressed alone.
    // (e.g., 'a', 'Enter', 'F5', 'Tab'). This is a single key press.
    return true
  } else if (activeModifierCount === 1) {
    // Case 2: Exactly one modifier flag is active.
    // This could be a single modifier press (e.g., just 'Shift') OR a combo (e.g., 'Shift' + 'A').
    // It's a single key press ONLY IF the key that triggered the event *IS* that modifier.
    return (
      (ctrl && key === 'Control') ||
      (shift && key === 'Shift') ||
      (alt && key === 'Alt') ||
      (meta && key === 'Meta')
    )
  } else {
    // Case 3: More than one modifier flag is active (e.g., Ctrl+Shift are both true).
    // This cannot be a single key press, regardless of what event.key is.
    return false
  }
}

/*
// --- How it behaves: ---
// Press 'a'               -> isSingleKeyPress returns true  (activeModifierCount = 0)
// Press 'Enter'           -> isSingleKeyPress returns true  (activeModifierCount = 0)
// Press 'F5'              -> isSingleKeyPress returns true  (activeModifierCount = 0)

// Press 'Shift' alone     -> isSingleKeyPress returns true  (activeModifierCount = 1, key === 'Shift')
// Press 'Control' alone   -> isSingleKeyPress returns true  (activeModifierCount = 1, key === 'Control')
// Press 'Alt' alone       -> isSingleKeyPress returns true  (activeModifierCount = 1, key === 'Alt')
// Press 'Meta' alone      -> isSingleKeyPress returns true  (activeModifierCount = 1, key === 'Meta')

// Press 'Shift' + 'A'     -> isSingleKeyPress returns false (activeModifierCount = 1, but key === 'a'/'A' NOT 'Shift')
// Press 'Control' + 'C'   -> isSingleKeyPress returns false (activeModifierCount = 1, but key === 'c' NOT 'Control')
// Press 'Alt' + 'Tab'     -> isSingleKeyPress returns false (activeModifierCount = 1, but key === 'Tab' NOT 'Alt')
// Press 'Meta' + 'S'      -> isSingleKeyPress returns false (activeModifierCount = 1, but key === 's' NOT 'Meta')

// Press 'Control' + 'Shift' -> isSingleKeyPress returns false (activeModifierCount = 2)
// Press 'Control'+'Alt'+'Delete' -> isSingleKeyPress returns false (activeModifierCount = 2, key === 'Delete')
*/

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
  // Default behavior: apply the original action to each selected block
  const multiSelectHandler = async (multiSelectDeps: MultiSelectModeDependencies, trigger: ActionTrigger) => {
    const {selectedBlocks, uiStateBlock} = multiSelectDeps
    const blocks = applyInReverseOrder ? selectedBlocks.toReversed() : selectedBlocks
    console.log(`[makeMultiSelect] Running action for ${blocks.length} blocks`)

    // todo Wrap all per-block actions into a single repo.tx so undo
    // collapses the bulk action into one entry; today each per-block
    // action commits its own tx and is its own undo step.

    // Process blocks sequentially, awaiting each one before proceeding
    for (const block of blocks) {
      // Convert dependencies to match the original action's context
      const originalDeps = {
        block,
        uiStateBlock,
      } as ShortcutDependenciesMap[T]

      await actionConfig.handler(originalDeps, trigger)
    }
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
  /** Shared action id. Both context variants register under this
   *  same id; `getActiveActionById` resolves the right variant
   *  based on the currently active context. */
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
   *  NORMAL_MODE variant's `canRun` gates on `appliesTo(block)`,
   *  and the MULTI_SELECT_MODE variant's `canRun` gates on at
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
 *  `flow` call instead. */
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
      ? {canRun: ({block}: BlockShortcutDependencies) => appliesTo(block)}
      : {}),
    handler: ({block}: BlockShortcutDependencies) => flow([block]),
  },
  blocks: {
    id,
    description: blocksDescription,
    context: ActionContextTypes.MULTI_SELECT_MODE,
    ...(icon ? {icon} : {}),
    canRun: ({selectedBlocks}: MultiSelectModeDependencies) => {
      if (selectedBlocks.length === 0) return false
      if (!appliesTo) return true
      return selectedBlocks.some(block => appliesTo(block))
    },
    handler: ({selectedBlocks}: MultiSelectModeDependencies) =>
      flow(selectedBlocks),
  },
})
