import { ActionConfig, Action, ActionContextType } from '@/shortcuts/types.ts'

export const hasEditableTarget = (event: KeyboardEvent) => {
  const target = event.target as HTMLElement;
  if (!target) return false;

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
    console.error("Invalid input: Function expects a KeyboardEvent object.");
    return false;
  }

  const key = event.key;
  const ctrl = event.ctrlKey;
  const shift = event.shiftKey;
  const alt = event.altKey;
  const meta = event.metaKey;

  // Calculate how many distinct modifier keys are active *right now* according to the event state.
  // Note: If the key pressed *is* a modifier (e.g., 'Shift'), its corresponding flag (shiftKey) will be true.
  const activeModifierCount = (ctrl ? 1 : 0) + (shift ? 1 : 0) + (alt ? 1 : 0) + (meta ? 1 : 0);

  if (activeModifierCount === 0) {
    // Case 1: No modifiers are active. This means a non-modifier key was pressed alone.
    // (e.g., 'a', 'Enter', 'F5', 'Tab'). This is a single key press.
    return true;
  } else if (activeModifierCount === 1) {
    // Case 2: Exactly one modifier flag is active.
    // This could be a single modifier press (e.g., just 'Shift') OR a combo (e.g., 'Shift' + 'A').
    // It's a single key press ONLY IF the key that triggered the event *IS* that modifier.
    return (
      (ctrl && key === 'Control') ||
      (shift && key === 'Shift') ||
      (alt && key === 'Alt') ||
      (meta && key === 'Meta')
    );
  } else {
    // Case 3: More than one modifier flag is active (e.g., Ctrl+Shift are both true).
    // This cannot be a single key press, regardless of what event.key is.
    return false;
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
