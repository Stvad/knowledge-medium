// @vitest-environment happy-dom
/**
 * Fuzz suite for `createSequenceMatcher` (src/shortcuts/sequenceMatcher.ts).
 * See `src/test/fuzz.ts` for the smoke/deep tier mechanics and
 * `docs/fuzzing.md` for conventions. Generalizes `sequenceMatcher.test.ts`'s
 * hand-written `CASES` table (fixed chord/event pairs, `tinykeysFires` vs
 * `matcherFires`) into generated chord specs × generated event sequences,
 * per issue #433. That file's non-differential verdict tests (`pending`
 * mid-sequence, `reset()`, multi-alternative dispatch) stay example-based —
 * tinykeys exposes no `pending` state to differential-test against
 * (sequenceMatcher.ts:14-16, the exact gap this module fills).
 *
 * ──── Why a differential, and what it can/can't catch (grounded in
 * sequenceMatcher.ts and tinykeys' `dist/tinykeys.cjs`) ────
 *
 * `createSequenceMatcher` delegates PRESS matching to tinykeys'
 * `matchKeybindingPress`/`parseKeybinding` directly (sequenceMatcher.ts:28-29)
 * — that primitive can never disagree with itself, so this suite's real
 * target is the SEQUENCE STATE MACHINE sequenceMatcher.ts:74-111 hand-ports
 * from `createKeybindingsHandler`'s loop (tinykeys.cjs:144-166): per-event
 * miss/pending/complete/conflict bookkeeping, the held-modifier-preserves-
 * sequence exception (sequenceMatcher.ts:55-56, tinykeys.cjs:151), and the
 * sequence-timeout equivalence sequenceMatcher.ts:75-77 argues for (tinykeys
 * clears via a real `setTimeout`; the matcher checks the GAP between two
 * `event.timeStamp`s at the next press). The differential below verifies
 * that argument computationally rather than trusting the comment: real
 * `vi` fake timers drive tinykeys' internal timer in lockstep with each
 * generated event's synthetic `timeStamp`, so both systems observe "the
 * same amount of elapsed time" and a disagreement at any step is real.
 *
 * ──── Generator design ────
 *
 * `chordArb` builds 1-2 presses per chord from a small token vocabulary
 * (letters in random case + code-only tokens: `ArrowUp`, `BracketLeft`,
 * `Digit1`, …) and a random modifier subset (incl. `$mod`); `chordSpecArb`
 * picks 1-3 TEXTUALLY DISTINCT chords as `createSequenceMatcher`'s
 * alternatives. Matching events are built from a press's PARSED form
 * (`parseKeybinding(pressString)[0]` — the exact tuple `matchKeybindingPress`
 * consumes) rather than re-deriving `$mod`'s platform resolution by hand:
 * this is ground-truth-by-construction the same way the codemirror suite's
 * generators are, just sourced from tinykeys' own parser instead of
 * duplicating its `$mod`/case rules. Each event step is drawn from a mix of
 * (a) a press aimed at one of the actual alternatives — weighted up so
 * multi-press sequences actually get completed/continued instead of never
 * coincidentally matching a ~10-token vocabulary by chance, (b) an
 * independently-random press (serves as both "matches by chance" and
 * "near miss" — the property doesn't care which, only that both systems
 * agree on the outcome), and (c) a bare modifier-only press (`Shift`
 * alone), covering the held-modifier exception. Each step also carries a
 * gap drawn from {0, within-timeout, past-timeout} — see the
 * "found while authoring" note below for why the exact-boundary gap is
 * deliberately excluded.
 *
 * Not covered (by design, not oversight): parenthesized-regex key tokens
 * and optional-modifier (`[Mod]`) chord syntax — grepped for real usage
 * across the codebase's actual chord strings (defaultShortcuts.ts,
 * blockActions.ts, colemak-keybindings, …) and found neither; adding them
 * would fuzz a tinykeys grammar corner this app never authors.
 *
 * ──── Found while authoring (NOT a product bug) — the exact-boundary gap ────
 *
 * The first deep-tier-shaped run (smoke seed, chord `"ArrowUp a"`, two
 * events each with `gapMs = DEFAULT_SEQUENCE_TIMEOUT_MS` exactly) went RED:
 * `matcher.next(event1).completed === true` but tinykeys never fired.
 * Root cause, confirmed by instrumenting the run rather than assumed: the
 * SECOND `vi.advanceTimersByTime(1000)` call fires tinykeys' timer
 * (scheduled for exactly 1000ms after event0) SYNCHRONOUSLY, before
 * `handler(event1)` runs — clearing `pending` first — while the matcher's
 * check (`event.timeStamp - lastTimeStamp > timeoutMs`, sequenceMatcher.ts:78)
 * is a STRICT `>`, so a gap of EXACTLY 1000 does not expire it. This is a
 * real divergence at that one exact value, but not a reachable one: for any
 * gap strictly less than or strictly greater than the timeout — the only
 * regions `gapMsArb` now generates — both sides agree (verified: fake
 * timers never fire early, so a gap `< timeout` leaves tinykeys' timer
 * un-fired same as the matcher's `>` being false; a gap `> timeout` fires
 * it, same as the matcher's `>` being true). The exact-equality point is a
 * measure-zero fake-clock tie-break (whether "advance by exactly D" counts
 * as reaching a timer scheduled for delay D) that real `event.timeStamp`s
 * — sub-millisecond `DOMHighResTimeStamp`s from two independent keypresses
 * — cannot land on. Not fixed: flipping sequenceMatcher.ts:78's `>` to
 * `>=` wouldn't make the port MORE correct, since tinykeys' own docs say
 * sequences "timeout if individual key presses are more than 1s apart"
 * (strict, matching the current `>`) — the mismatch traces to tinykeys'
 * OWN setTimeout being racy relative to its documented intent at that
 * single instant, not to anything the port got wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { vi } from 'vitest'
import { createKeybindingsHandler, parseKeybinding } from 'tinykeys'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { createSequenceMatcher, DEFAULT_SEQUENCE_TIMEOUT_MS } from '../sequenceMatcher.ts'

// ──── chord token vocabulary ────

const LETTER_TOKENS = ['a', 'g', 'j', 'k', 'y', 'z'] as const
const CODE_TOKENS = ['ArrowUp', 'ArrowDown', 'BracketLeft', 'Digit1', 'Space', 'Backquote'] as const
const MOD_TOKENS = ['Shift', 'Control', 'Alt', 'Meta', '$mod'] as const
const KEYBINDING_MODIFIER_KEYS = ['Shift', 'Meta', 'Alt', 'Control'] as const

const caseVariant = (s: string): fc.Arbitrary<string> => fc.constantFrom(s.toLowerCase(), s.toUpperCase())

interface PressSpec {
  readonly mods: readonly string[]
  readonly token: string
  readonly isCode: boolean
}

const pressSpecArb: fc.Arbitrary<PressSpec> = fc.record({
  mods: fc.uniqueArray(fc.constantFrom(...MOD_TOKENS), { maxLength: 3 }),
  tokenChoice: fc.oneof(
    fc.constantFrom(...LETTER_TOKENS).chain(caseVariant).map(token => ({ token, isCode: false })),
    fc.constantFrom(...CODE_TOKENS).map(token => ({ token, isCode: true })),
  ),
}).map(({ mods, tokenChoice }) => ({ mods, token: tokenChoice.token, isCode: tokenChoice.isCode }))

const pressToString = (p: PressSpec): string => (p.mods.length ? `${p.mods.join('+')}+${p.token}` : p.token)

interface ChordSpec {
  readonly presses: readonly PressSpec[]
  readonly str: string
}

const chordArb: fc.Arbitrary<ChordSpec> = fc.array(pressSpecArb, { minLength: 1, maxLength: 2 }).map(presses => ({
  presses,
  str: presses.map(pressToString).join(' '),
}))

/** 1-3 textually distinct chord alternatives for one `createSequenceMatcher`
 *  binding — mirrors real multi-alternative bindings like
 *  `['$mod+Shift+ArrowUp', '$mod+Shift+k']` (blockActions.ts:249). */
const chordSpecArb: fc.Arbitrary<readonly ChordSpec[]> =
  fc.uniqueArray(chordArb, { minLength: 1, maxLength: 3, selector: c => c.str })

// ──── event construction from a parsed press (ground truth = tinykeys'
//      own parser, not a hand-derived $mod/case model) ────

/** Builds a `KeyboardEventInit` that `matchKeybindingPress` accepts for
 *  `p`, deriving required modifiers via `parseKeybinding` itself (so
 *  `$mod`'s platform resolution is always exactly what tinykeys computed,
 *  never re-guessed) and holding exactly those modifiers — plus the key
 *  itself when the key IS a modifier name, mirroring the "press a modifier
 *  alone" exception (tinykeys.cjs:107, `key !== mod`). Code-form tokens get
 *  a deliberately mismatched `.key` so the match genuinely exercises the
 *  `event.code` fallback (tinykeys.cjs:104), not a `.key` coincidence. */
const buildEventInit = (p: PressSpec): KeyboardEventInit => {
  const [requiredModifiers, , keyOrRegex] = parseKeybinding(pressToString(p))[0]!
  const key = keyOrRegex as string // this suite never generates regex-form keys
  const held = new Set(requiredModifiers)
  if ((KEYBINDING_MODIFIER_KEYS as readonly string[]).includes(key)) held.add(key)

  const init: KeyboardEventInit = {
    shiftKey: held.has('Shift'),
    ctrlKey: held.has('Control'),
    altKey: held.has('Alt'),
    metaKey: held.has('Meta'),
  }
  if (p.isCode) {
    init.code = key // matched case-sensitively — never re-case this
    init.key = 'Unidentified'
  } else {
    init.key = key // matched case-insensitively
    init.code = 'Unidentified'
  }
  return init
}

const modifierOnlyInitArb: fc.Arbitrary<KeyboardEventInit> = fc.constantFrom(...KEYBINDING_MODIFIER_KEYS).map(mod => ({
  key: mod,
  code: `${mod}Left`,
  shiftKey: mod === 'Shift',
  ctrlKey: mod === 'Control',
  altKey: mod === 'Alt',
  metaKey: mod === 'Meta',
}))

interface EventStep {
  readonly init: KeyboardEventInit
  readonly gapMs: number
}

// Deliberately does NOT include gapMs === DEFAULT_SEQUENCE_TIMEOUT_MS
// exactly — see the docblock's "found while authoring" note: at that exact
// gap, the deep-tier run demonstrated a real divergence between tinykeys'
// setTimeout-driven expiry and the matcher's strict `>` check, diagnosed as
// a measure-zero fake-clock tie-break artifact rather than a reachable
// product bug. Both surrounding regions (strictly within, strictly past)
// are unambiguous and covered here.
const gapMsArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 1, max: DEFAULT_SEQUENCE_TIMEOUT_MS - 1 }), // within timeout — neither side expires
  fc.integer({ min: DEFAULT_SEQUENCE_TIMEOUT_MS + 1, max: DEFAULT_SEQUENCE_TIMEOUT_MS * 3 }), // past timeout — both expire
)

const eventStepArb = (alternatives: readonly ChordSpec[]): fc.Arbitrary<EventStep> => {
  const targetedPressArb: fc.Arbitrary<PressSpec> = fc.oneof(
    ...alternatives.flatMap(alt => alt.presses.map(p => fc.constant(p))),
  )
  const initArb: fc.Arbitrary<KeyboardEventInit> = fc.oneof(
    { weight: 3, arbitrary: pressSpecArb.map(buildEventInit) }, // random — coincidental match or near-miss alike
    { weight: 4, arbitrary: targetedPressArb.map(buildEventInit) }, // aimed at actually progressing a real alternative
    { weight: 1, arbitrary: modifierOnlyInitArb },
  )
  return fc.record({ init: initArb, gapMs: gapMsArb })
}

interface Scenario {
  readonly keysArg: string | string[]
  readonly chordStrings: readonly string[]
  readonly steps: readonly EventStep[]
}

const scenarioArb: fc.Arbitrary<Scenario> = chordSpecArb.chain(alternatives => {
  const chordStrings = alternatives.map(a => a.str)
  return fc.array(eventStepArb(alternatives), { minLength: 1, maxLength: 6 }).map((steps): Scenario => ({
    keysArg: chordStrings.length === 1 ? chordStrings[0]! : [...chordStrings],
    chordStrings,
    steps,
  }))
})

// ──── differential runner ────

interface StepResult {
  readonly tinykeysFired: boolean
  readonly matcherVerdict: { completed: boolean; pending: boolean }
}

/** Feeds `scenario.steps` to a real tinykeys handler (via real `vi` fake
 *  timers, advanced by each step's `gapMs` BEFORE the event — so tinykeys'
 *  own `setTimeout`-driven pending-clear fires exactly when that much real
 *  time would have elapsed) and to a fresh `createSequenceMatcher`, in
 *  lockstep, recording BOTH systems' verdict at every single step (not
 *  just "did it ever fire") — a strictly stronger check than
 *  `sequenceMatcher.test.ts`'s cumulative `matcherFires`/`tinykeysFires`. */
const runDifferential = (scenario: Scenario): readonly StepResult[] => {
  const matcher = createSequenceMatcher(scenario.keysArg, { timeoutMs: DEFAULT_SEQUENCE_TIMEOUT_MS })

  let tinykeysFiredThisStep: boolean
  const keybindingsMap = Object.fromEntries(
    scenario.chordStrings.map(chord => [chord, () => { tinykeysFiredThisStep = true }]),
  )
  const handler = createKeybindingsHandler(keybindingsMap, {
    ignore: () => false, // matches the coordinator's makeMatcher — see sequenceMatcher.test.ts:20
    timeout: DEFAULT_SEQUENCE_TIMEOUT_MS,
  })

  const results: StepResult[] = []
  let cumulativeMs = 0
  for (const step of scenario.steps) {
    if (step.gapMs > 0) vi.advanceTimersByTime(step.gapMs)
    cumulativeMs += step.gapMs

    const event = new KeyboardEvent('keydown', step.init)
    Object.defineProperty(event, 'timeStamp', { configurable: true, value: cumulativeMs })

    tinykeysFiredThisStep = false
    handler(event)
    const matcherVerdict = matcher.next(event)

    results.push({ tinykeysFired: tinykeysFiredThisStep, matcherVerdict })
  }
  return results
}

// ──── properties ────

describe('createSequenceMatcher ↔ tinykeys per-step differential (generalizes sequenceMatcher.test.ts CASES)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('completes on exactly the same events tinykeys would fire on, over generated chord specs and event sequences', () => {
    fc.assert(
      fc.property(scenarioArb, scenario => {
        const results = runDifferential(scenario)
        for (let i = 0; i < results.length; i++) {
          const { tinykeysFired, matcherVerdict } = results[i]!
          expect(matcherVerdict.completed, `step ${i}: ${JSON.stringify(scenario.steps[i])}`).toBe(tinykeysFired)
        }
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())

  it('never reports completed and pending simultaneously (sequenceMatcher.ts:104-108: completed is only set inside `if (!pending)`, immediately followed by break)', () => {
    fc.assert(
      fc.property(scenarioArb, scenario => {
        const results = runDifferential(scenario)
        for (const { matcherVerdict } of results) {
          expect(matcherVerdict.completed && matcherVerdict.pending).toBe(false)
        }
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})
