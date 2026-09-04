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
 * sequence-timeout logic (tinykeys clears via a real `setTimeout`; the
 * matcher checks the GAP between two `event.timeStamp`s at the next press).
 * Note tinykeys' `createKeybindingsHandler` — the thing this differential
 * runs against — never executes in production: the dispatcher
 * (HotkeyReconciler.tsx) and the shortcut-help inspector (useKeyInspector.ts)
 * both import only the per-press primitives and drive `createSequenceMatcher`
 * directly. So this differential is a SPEC-FIDELITY check (does our
 * hand-port match the reference implementation's intent) rather than a
 * live-behavior constraint (there is no runtime tinykeys instance this code
 * must bit-for-bit agree with) — material for interpreting the exact-boundary
 * finding below, which is a case where fidelity to tinykeys' literal
 * timer-firing behavior and the actual desired dispatch behavior turned out
 * to disagree.
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
 * gap drawn from {0, within-timeout, exactly-the-timeout, past-timeout} —
 * see the "found while authoring" note below for how the exact-boundary
 * case was found, why it's included in the generator rather than excluded,
 * and why the first property treats it as admissible either way instead of
 * asserting strict tinykeys-parity there.
 *
 * Not covered (by design, not oversight): parenthesized-regex key tokens
 * and optional-modifier (`[Mod]`) chord syntax — grepped for real usage
 * across the codebase's actual chord strings (defaultShortcuts.ts,
 * blockActions.ts, colemak-keybindings, …) and found neither; adding them
 * would fuzz a tinykeys grammar corner this app never authors.
 *
 * ──── Found while authoring — the exact-boundary gap, and why it stays
 *      admissible-either-way rather than "fixed" ────
 *
 * The first deep-tier-shaped run (smoke seed, chord `"ArrowUp a"`, two
 * events each with `gapMs = DEFAULT_SEQUENCE_TIMEOUT_MS` exactly) went RED:
 * `matcher.next(event1).completed === true` but tinykeys never fired. This
 * suite originally excluded `gapMs === DEFAULT_SEQUENCE_TIMEOUT_MS` from
 * `gapMsArb` to work around it, reasoning the tie was an unreachable
 * fake-clock artifact. That reasoning didn't hold — browsers coarsen
 * `event.timeStamp` for privacy, so two real keypresses landing exactly
 * `timeoutMs` apart IS reachable — so the boundary was restored to the
 * generator permanently.
 *
 * First fix attempt: switch sequenceMatcher.ts's strict `>` to `>=`, to
 * match tinykeys' own timer, which (confirmed by instrumenting the run)
 * re-arms a `setTimeout(() => pending.clear(), timeout)` on every keydown
 * and — under this harness's fake timers — fires once AT LEAST `timeout`
 * ms have elapsed, i.e. at gap >= timeout, not gap > timeout. That
 * initially looked like the fix (re-verified clean across several 2000+
 * run deep-tier passes). It was reverted: `createKeybindingsHandler` (the
 * thing whose timer we'd be matching) never runs in production — only
 * `matchKeybindingPress`/`parseKeybinding` do (HotkeyReconciler.tsx,
 * useKeyInspector.ts) — so "match tinykeys' timer" isn't actually a
 * live-behavior requirement, just one reading of the reference
 * implementation's intent. And `event.timeStamp` coarsening cuts both
 * ways: a rounded gap of exactly `timeoutMs` can correspond to true
 * elapsed time on either side of the boundary, so neither `>` nor `>=` is
 * the objectively correct reading of an already-ambiguous input — the
 * choice is a harm-asymmetry call (sequenceMatcher.ts's comment), and
 * `>` (fail toward keeping a sequence alive, never silently drop a
 * shortcut) wins that call.
 *
 * Consequence for this suite: the exact-boundary gap is a genuinely
 * admissible-either-way case, not a bug to fix or hide. The first property
 * below stops asserting tinykeys-parity once a scenario hits that gap
 * (comment there explains why); the boundary is pinned deterministically
 * instead in sequenceMatcher.test.ts, against the port's OWN chosen
 * behavior rather than against tinykeys.
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

// Includes the exact boundary (gapMs === DEFAULT_SEQUENCE_TIMEOUT_MS) as its
// own case — see the docblock's "Found while authoring" note: this used to
// be excluded as an "unreachable" tie, which was wrong (coarsened
// `event.timeStamp`s make it reachable). It stays in the generator
// permanently; the first property below treats a hit on this exact value as
// admissible either way, and — because that step's disagreement can
// contaminate every later step's comparison in the same scenario (pending
// state legitimately diverges after an accepted tie, sequenceMatcher.ts) —
// stops asserting tinykeys-parity for the rest of that scenario once it's
// hit. That truncation is why the boundary is given a DELIBERATELY LOW
// weight below (~1.6%, not an even 25% split): at an even split, most
// generated scenarios (a scenario needs only one boundary-valued step among
// up to 6) would hit the boundary and run just a short, truncated parity
// check — silently hollowing out the differential this suite exists to run.
// Low weight keeps the boundary reachable (still exercised hundreds of
// times over a deep run) while keeping full end-to-end parity assertion on
// the large majority of scenarios. Do not rebalance this back toward
// uniform — that reintroduces the coverage loss.
const gapMsArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 20, arbitrary: fc.constant(0) },
  { weight: 20, arbitrary: fc.integer({ min: 1, max: DEFAULT_SEQUENCE_TIMEOUT_MS - 1 }) }, // within timeout — neither side expires
  { weight: 1, arbitrary: fc.constant(DEFAULT_SEQUENCE_TIMEOUT_MS) }, // exact boundary — admissible either way, see docblock; rare and truncating, see comment above
  { weight: 20, arbitrary: fc.integer({ min: DEFAULT_SEQUENCE_TIMEOUT_MS + 1, max: DEFAULT_SEQUENCE_TIMEOUT_MS * 3 }) }, // past timeout — both expire
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

  it('completes on exactly the same events tinykeys would fire on, over generated chord specs and event sequences (except at an exact-timeout-boundary gap, which is admissible either way — see docblock), and never reports completed and pending simultaneously', () => {
    fc.assert(
      fc.property(scenarioArb, scenario => {
        const results = runDifferential(scenario)
        for (let i = 0; i < results.length; i++) {
          const { matcherVerdict } = results[i]!
          // Mutual exclusion (sequenceMatcher.ts:119-121: `completed` is set
          // only inside `if (!pending)`, immediately followed by `break`) is
          // pure control flow, unaffected by the timeout check above the
          // loop (which only clears `state`, not these locals) — so it
          // holds on EVERY step, including boundary-gap ones, and is
          // checked here before the boundary `break` below so it still runs
          // on those steps too. This used to be a standalone property
          // re-running a full separate `fuzzParams` budget over the same
          // kind of generated scenarios just to re-derive what the control
          // flow already guarantees — a fuzz-tier restatement of the
          // implementation. Folding it into this loop checks it on every
          // step of every scenario
          // this property generates anyway, at zero extra cost and with
          // MORE coverage than the standalone version had (that ran over
          // its own independently-generated scenarios; this rides the
          // exact ones already being differential-tested here).
          expect(matcherVerdict.completed && matcherVerdict.pending).toBe(false)

          // Once a step's gap lands EXACTLY on DEFAULT_SEQUENCE_TIMEOUT_MS,
          // the two systems are comparing an underdetermined input (see the
          // docblock and sequenceMatcher.ts): tinykeys' fake-timer-driven
          // clear deterministically resolves the tie as "expired" in THIS
          // harness, while the port deliberately fails toward "continued".
          // Neither is wrong, so we stop asserting tinykeys-parity from
          // that step onward — a later mismatch in the SAME scenario would
          // just be a downstream echo of this one accepted tie (the two
          // systems' pending state has diverged), not an independently new
          // bug. `gapMsArb` weights this case low (see its comment)
          // precisely so this truncation stays rare — measured at ~94-95%
          // of scenarios running the full, untruncated parity check across
          // several deep-tier runs.
          if (scenario.steps[i]!.gapMs === DEFAULT_SEQUENCE_TIMEOUT_MS) break
          const { tinykeysFired } = results[i]!
          expect(matcherVerdict.completed, `step ${i}: ${JSON.stringify(scenario.steps[i])}`).toBe(tinykeysFired)
        }
      }),
      fuzzParams(200),
    )
  }, fuzzTestTimeout())
})
