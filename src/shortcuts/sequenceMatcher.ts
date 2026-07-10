import {
  matchKeybindingPress,
  parseKeybinding,
  type KeybindingPress,
} from 'tinykeys'

/**
 * A per-binding, stateful keyboard sequence matcher — the one piece of
 * chord-matching the shortcut dispatcher and the shortcut-help inspector
 * share instead of each keeping its own.
 *
 * It is a faithful port of tinykeys' `createKeybindingsHandler` sequence
 * loop, narrowed to ONE binding (its `keys` may still list several chord
 * alternatives) and lifted from "fire a callback" to "return a verdict" so
 * the inspector can read the `pending` (which-key) state tinykeys keeps
 * internally but never exposes:
 *
 *  - `completed` — this event finished one of the chord alternatives (the
 *    dispatcher would run the handler now).
 *  - `pending` — after this event at least one alternative is mid-sequence,
 *    awaiting more presses (`g` typed, `g g` still possible).
 *
 * Per-alternative sequence state is what removes the inspector's old
 * drop-oldest suffix retry: a press that breaks one binding's sequence
 * simply resets THAT binding while another matches fresh, exactly as the
 * dispatcher's per-binding tinykeys handlers behaved.
 *
 * Matching delegates to tinykeys' own `parseKeybinding` / `matchKeybindingPress`,
 * so chord identity (`$mod` resolution, `event.code` fallback, exact-modifier
 * sets) agrees with dispatch by construction. Callers feed real
 * `KeyboardEvent`s and decide which events to consider (typing filters,
 * capture-phase swallowing) — this is only the sequence state machine.
 */
export interface SequenceVerdict {
  readonly completed: boolean
  readonly pending: boolean
}

export interface SequenceMatcher {
  /** Advance the matcher with one keydown, returning its verdict. */
  next(event: KeyboardEvent): SequenceVerdict
  /** Abandon all in-flight sequence progress. */
  reset(): void
}

const NO_MATCH: SequenceVerdict = {completed: false, pending: false}

/** tinykeys default: a gap longer than this abandons an in-flight sequence. */
export const DEFAULT_SEQUENCE_TIMEOUT_MS = 1000

/** A modifier key's OWN press must not break an in-flight sequence (a bare
 *  Shift between `g` and `g` keeps `g g` alive). Mirrors tinykeys, which
 *  tests `event.getModifierState(event.key)` — true only when the pressed key
 *  is itself a currently-held modifier. */
const isHeldModifierPress = (event: KeyboardEvent): boolean =>
  typeof event.getModifierState === 'function' && event.getModifierState(event.key)

export const createSequenceMatcher = (
  keys: string | readonly string[],
  options: {timeoutMs?: number} = {},
): SequenceMatcher => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS
  // Each alternative's full parsed presses; `state` holds the presses still
  // OUTSTANDING for an alternative mid-sequence (absent = fresh).
  const alternatives = (Array.isArray(keys) ? keys : [keys]).map(k => parseKeybinding(k))
  const state = new Map<number, readonly KeybindingPress[]>()
  let lastTimeStamp: number | null = null

  const reset = (): void => {
    state.clear()
    lastTimeStamp = null
  }

  const next = (event: KeyboardEvent): SequenceVerdict => {
    // Sequence expiry. tinykeys clears via a setTimeout; keying off the event
    // timestamp is equivalent for dispatch — nothing observes the state
    // between two events, so an unbounded gap only matters at the next press.
    if (lastTimeStamp !== null && event.timeStamp - lastTimeStamp > timeoutMs) {
      state.clear()
    }
    lastTimeStamp = event.timeStamp

    let pending = false
    let completed = false
    for (let i = 0; i < alternatives.length; i++) {
      const remaining = state.get(i) ?? alternatives[i]!
      const expected = remaining[0]
      if (!expected) continue // empty chord string — nothing to match
      if (!matchKeybindingPress(event, expected)) {
        // Miss: reset this alternative, UNLESS the miss is a held modifier's
        // own press (which doesn't break the sequence).
        if (!isHeldModifierPress(event)) state.delete(i)
        continue
      }
      const rest = remaining.slice(1)
      if (rest.length > 0) {
        state.set(i, rest)
        pending = true
      } else {
        state.delete(i)
        // tinykeys suppresses a completion when an earlier alternative is
        // still mid-sequence this same event (a genuine conflict), and stops
        // iterating after a fire.
        if (!pending) {
          completed = true
          break
        }
      }
    }
    return completed || pending ? {completed, pending} : NO_MATCH
  }

  return {next, reset}
}
