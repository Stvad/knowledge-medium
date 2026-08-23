// @vitest-environment jsdom
// Stays on jsdom to match `recoverLogicalKey.test.ts` (the hand-written
// example suite this generalizes): happy-dom defines KeyboardEvent's
// `code` as an own instance property rather than a prototype accessor, so
// it can't exercise the same brand-check-shaped semantics jsdom (and real
// browsers) have.
/**
 * Fuzz suite for `withRecoveredLetterKey` (src/shortcuts/utils.ts:69-96).
 * See `src/test/fuzz.ts` for the smoke/deep tier mechanics and
 * `docs/fuzzing.md` for conventions. Generalizes the hand-picked
 * OS/layout-corruption cases in `recoverLogicalKey.test.ts` (Mac
 * Alt-transform, Colemak code-lies, digit/Escape out-of-scope, …) into
 * generated event shapes; that file's receiver-binding regression test
 * (getters must observe the real event as `this`, not the Proxy) stays
 * example-based — it patches `KeyboardEvent.prototype` globally and isn't
 * something to run per fuzz case.
 *
 * ──── Contract under test (utils.ts:69-96) ────
 *
 * `withRecoveredLetterKey(event)`:
 *  1. `!event.altKey && !event.metaKey` → return `event` (:73) — no
 *     modifier, `event.key` is trustworthy.
 *  2. `keyCode` outside `[ASCII_A(65), ASCII_Z(90)]` → return `event`
 *     (:74-75) — out of the letters-only scope the docblock declares
 *     (:64-67); digit/punctuation/special keys are untouched.
 *  3. `event.key.toLowerCase() === recovered` (where `recovered =
 *     String.fromCharCode(keyCode).toLowerCase()`, :76-77) → return
 *     `event` — already correct, no recovery needed.
 *  4. Otherwise: a `Proxy` whose `key` trap returns `recovered` and whose
 *     every other prop passes through `Reflect.get(target, prop)` with
 *     `target` (not the proxy) as the implicit receiver (:89-95) — the
 *     KeyboardEvent brand-check reason is covered by the receiver-binding
 *     example test, not re-tested here.
 *
 * ──── A guard quirk found while grounding the generators (NOT a fix) ────
 *
 * Step 2's `keyCode < 65 || keyCode > 90` does NOT exclude `keyCode =
 * NaN`: both comparisons are `false` for NaN, so a NaN keyCode with a
 * modifier held falls through to step 3/4 and "recovers" to the NUL character
 * (`String.fromCharCode(NaN)` → `ToUint16(NaN)` → 0). `event.keyCode` is
 * DOM-spec `unsigned long` and never NaN from a real dispatched event —
 * this is only reachable by a hand-corrupted event (as this suite's own
 * `mk()` helper can build, matching `recoverLogicalKey.test.ts`'s), so
 * it's out of the function's realistic domain and not a product bug. The
 * "in-scope"/"out-of-scope" classification generators below therefore
 * only draw `keyCode` from `fc.integer(...)` (never NaN); the
 * never-throws/idempotence properties still cover NaN, just without
 * asserting which branch it takes.
 *
 * ──── Idempotence, derived (not assumed) ────
 *
 * `withRecoveredLetterKey(withRecoveredLetterKey(event)) ===
 * withRecoveredLetterKey(event)` for ANY event, including out-of-scope
 * ones. Out-of-scope: the first call is already the identity, so the
 * second call sees the same (unchanged) event again — trivially
 * idempotent. In-scope: the first call's result R passes `altKey`,
 * `metaKey`, and `keyCode` through unchanged (Proxy pass-through, :92),
 * so `recovered` recomputes to the SAME value on the second call, and
 * `R.key` is already exactly that value (step 4 sets it verbatim); since
 * `String.fromCharCode(keyCode).toLowerCase()` is already all-ASCII
 * lowercase, re-applying `.toLowerCase()` in step 3's check is a no-op
 * (`.toLowerCase()` is idempotent), so step 3's "already correct" branch
 * fires on the second call and returns R itself.
 *
 * ──── Downstream-behavior recovery property, not the formula
 *      (PR #454 review comment 3677006799) ────
 *
 * A prior version of this suite's "in-scope recovery" property derived
 * its expectation with `String.fromCharCode(shape.keyCode).toLowerCase()`
 * — the exact same expression `withRecoveredLetterKey` uses (utils.ts:76)
 * — and then branched on `shape.key.toLowerCase() === recovered` to decide
 * whether the result should be the same event or a Proxy, mirroring
 * utils.ts:77's own branch. That's a formula-mirror, same defect as the
 * `clampSelectionToLength` property fixed alongside this one (PR #454
 * comment 3676886063) — random garbage `key`/`code` values gave no
 * independent oracle. The lesson from that fix carries a caution, not just
 * a template: replacing a formula-mirror with SOME other property isn't
 * automatically progress — that fix's own mutation test showed idempotence
 * /direction/monotonicity would NOT have caught a dropped lower-bound
 * clamp; only deterministic examples did. So the replacement below is
 * deliberately built around a genuinely independent oracle rather than
 * a plausible-sounding structural property: `withRecoveredLetterKey`
 * exists so an OS/layout-corrupted event still matches the chord the user
 * intended (HotkeyReconciler.tsx:473,640 call it immediately before
 * tinykeys' own `matchKeybindingPress`, utils.ts:850-852) — that downstream
 * MATCH is the thing to check, not the recovered `.key` value's exact
 * text. `intentEventArb` generates an intended `Alt+<letter>` /
 * `Meta+<letter>` chord alongside a KeyboardEvent corrupted in one of the
 * three ways the module docblock names (utils.ts:42-45: Mac Alt-transform
 * — key transformed, code still correct; Colemak/Dvorak — key
 * transformed AND code lies about the physical key; Meta-transform) plus
 * an already-correct case (recovery is a no-op). The property runs the
 * corrupted event through `withRecoveredLetterKey` and asserts tinykeys'
 * `matchKeybindingPress` now matches the INTENDED chord, and does NOT
 * match a chord for a different letter — using tinykeys' own matcher
 * (ground truth by construction, same principle as sequenceMatcher's
 * differential) as the independent oracle, never re-deriving
 * `String.fromCharCode`/`.toLowerCase()` anywhere in this property.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { matchKeybindingPress, parseKeybinding } from 'tinykeys'
import { fuzzParams, fuzzTestTimeout, utf16UnitArb } from '@/test/fuzz'
import { withRecoveredLetterKey } from '../utils.ts'

const ASCII_A = 65
const ASCII_Z = 90

// ──── event construction ────

type EventShape = {
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
  keyCode: number
  key: string
  code: string
}

/** Builds a real KeyboardEvent with `keyCode` force-set via
 *  `defineProperty` — `KeyboardEventInit` ignores `keyCode` in modern
 *  browsers/jsdom, but it's exactly the field `withRecoveredLetterKey`
 *  recovers from. Mirrors `recoverLogicalKey.test.ts`'s `mk()`. */
const mk = ({ altKey, metaKey, shiftKey, keyCode, key, code }: EventShape): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { altKey, metaKey, shiftKey, key, code })
  Object.defineProperty(event, 'keyCode', { value: keyCode, configurable: true })
  return event
}

// ──── keyCode domains ────

const letterCodeArb: fc.Arbitrary<number> = fc.integer({ min: ASCII_A, max: ASCII_Z })
const nonLetterCodeArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -1000, max: ASCII_A - 1 }),
  fc.integer({ min: ASCII_Z + 1, max: 1000 }),
  fc.constantFrom(0, -1),
)
/** Wild `keyCode`, including values a real `unsigned long` DOM property
 *  can never carry (NaN, Infinity, huge/negative, fractional) — used ONLY
 *  by the never-throws / idempotence properties, which don't assert a
 *  classification (see the NaN-guard-quirk note above). */
const wildKeyCodeArb: fc.Arbitrary<number> = fc.oneof(
  letterCodeArb,
  nonLetterCodeArb,
  fc.constantFrom(NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER),
  fc.double(),
)

const garbageKeyArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.string({ unit: 'binary', maxLength: 6 }), // whole code points, astral included
  fc.string({ unit: utf16UnitArb, maxLength: 6 }), // ill-formed UTF-16: lone surrogates
  fc.constantFrom('', 'Escape', 'Enter', 'Tab', 'Shift', 'Unidentified', '¥', 'Ω', 'ÿ'),
)
const garbageCodeArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.constantFrom('KeyY', 'KeyO', 'Digit1', 'Escape', ''),
)
/** At least one of Alt/Meta held — the two "might be transformed" modifiers
 *  the docblock names (:39-45, :64-67). */
const modifierPairArb: fc.Arbitrary<{ altKey: boolean; metaKey: boolean }> = fc.oneof(
  fc.constant({ altKey: true, metaKey: false }),
  fc.constant({ altKey: false, metaKey: true }),
  fc.constant({ altKey: true, metaKey: true }),
)

// ──── fully wild event (never-throws / idempotence domain) ────

const wildEventArb: fc.Arbitrary<EventShape> = fc.record({
  altKey: fc.boolean(),
  metaKey: fc.boolean(),
  shiftKey: fc.boolean(),
  keyCode: wildKeyCodeArb,
  key: garbageKeyArb,
  code: garbageCodeArb,
})

// ──── guaranteed out-of-scope event, by construction (3 flavors mirroring
//      the example test's cases) ────

const outOfScopeEventArb: fc.Arbitrary<EventShape> = fc.oneof(
  // (a) no modifier at all — keyCode/key are irrelevant to the outcome.
  fc.record({
    altKey: fc.constant(false),
    metaKey: fc.constant(false),
    shiftKey: fc.boolean(),
    keyCode: fc.oneof(letterCodeArb, nonLetterCodeArb),
    key: garbageKeyArb,
    code: garbageCodeArb,
  }),
  // (b) modifier held, keyCode outside the letters-only scope.
  fc.tuple(modifierPairArb, nonLetterCodeArb, fc.boolean(), garbageKeyArb, garbageCodeArb)
    .map(([mod, keyCode, shiftKey, key, code]) => ({ ...mod, keyCode, shiftKey, key, code })),
  // (c) modifier held, letter keyCode, but `key` already matches the
  //     keyCode-derived letter (case-insensitively) — no recovery needed.
  fc.tuple(modifierPairArb, letterCodeArb, fc.boolean(), garbageCodeArb)
    .chain(([mod, keyCode, shiftKey, code]) => {
      const letter = String.fromCharCode(keyCode)
      return fc.constantFrom(letter.toLowerCase(), letter.toUpperCase())
        .map(key => ({ ...mod, keyCode, shiftKey, key, code }))
    }),
)

// ──── intended-chord + corrupted-event pairs (downstream-behavior domain) ────

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')
const letterArb: fc.Arbitrary<string> = fc.constantFrom(...LETTERS)
/** Glyphs that never coincide with a-z — stand-ins for whatever an OS
 *  Alt/Meta transform actually produces (¥, Ω, …); the exact glyph is
 *  irrelevant to the property, only that it's NOT the intended letter. */
const TRANSFORM_GLYPHS = ['¥', 'Ω', 'ÿ', '€', '§', '±', '∆', 'ç'] as const

interface IntentEventPair {
  readonly letter: string // intended logical letter, lowercase
  readonly modifier: 'Alt' | 'Meta'
  readonly shiftKey: boolean
  readonly event: KeyboardEvent
}

/** Builds (intended chord, corrupted-or-not KeyboardEvent) pairs covering
 *  the three corruption shapes the module docblock names (utils.ts:42-45)
 *  plus the no-corruption case, all with `keyCode` set to the intended
 *  letter's ASCII code — exactly what a real dispatched event carries
 *  (utils.ts:52-57) regardless of which corruption flavor `.key`/`.code`
 *  exhibit. */
const intentEventArb: fc.Arbitrary<IntentEventPair> = fc.record({
  letter: letterArb,
  modifier: fc.constantFrom<'Alt' | 'Meta'>('Alt', 'Meta'),
  flavor: fc.constantFrom(
    'already-correct', // no corruption: .key already the intended letter
    'mac-alt-transform', // .key transformed, .code still the correct QWERTY code
    'colemak-code-lies', // .key transformed AND .code names a DIFFERENT key
  ),
  glyph: fc.constantFrom(...TRANSFORM_GLYPHS),
  lieLetter: letterArb, // only consumed by the colemak-code-lies flavor
  shiftKey: fc.boolean(),
}).map(({ letter, modifier, flavor, glyph, lieLetter, shiftKey }): IntentEventPair => {
  const keyCode = letter.toUpperCase().charCodeAt(0)
  const correctCode = `Key${letter.toUpperCase()}`
  let key: string
  let code: string
  if (flavor === 'already-correct') {
    key = letter
    code = correctCode
  } else if (flavor === 'mac-alt-transform') {
    key = glyph
    code = correctCode
  } else {
    key = glyph
    // A genuinely different key's code, so it "lies" about the physical
    // key the way Colemak/Dvorak layouts do (utils.ts:47-50).
    const lie = lieLetter === letter ? LETTERS[(LETTERS.indexOf(letter) + 1) % LETTERS.length]! : lieLetter
    code = `Key${lie.toUpperCase()}`
  }
  const event = mk({
    altKey: modifier === 'Alt',
    metaKey: modifier === 'Meta',
    shiftKey,
    keyCode,
    key,
    code,
  })
  return { letter, modifier, shiftKey, event }
})

// ──── properties ────

describe('withRecoveredLetterKey — totality', () => {
  it('never throws for an arbitrary (keyCode, key, code, altKey/metaKey) event', () => {
    fc.assert(
      fc.property(wildEventArb, shape => {
        const event = mk(shape)
        expect(() => withRecoveredLetterKey(event)).not.toThrow()
      }),
      fuzzParams(500),
    )
  }, fuzzTestTimeout())
})

describe('withRecoveredLetterKey — idempotence', () => {
  it('applying it twice equals applying it once', () => {
    fc.assert(
      fc.property(wildEventArb, shape => {
        const event = mk(shape)
        const once = withRecoveredLetterKey(event)
        const twice = withRecoveredLetterKey(once)
        expect(twice).toBe(once)
        expect(twice.key).toBe(once.key)
      }),
      fuzzParams(500),
    )
  }, fuzzTestTimeout())
})

describe('withRecoveredLetterKey — out-of-scope (utils.ts:73-75, :77)', () => {
  it('returns the SAME event reference for anything outside the letters+modifier scope', () => {
    fc.assert(
      fc.property(outOfScopeEventArb, shape => {
        const event = mk(shape)
        expect(withRecoveredLetterKey(event)).toBe(event)
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})

describe('withRecoveredLetterKey — downstream: tinykeys matches the intended chord after recovery (utils.ts:76, :89-95; PR #454 comment 3677006799)', () => {
  it('matches the intended Alt/Meta[+Shift]+letter chord after recovery, and does not match a different letter’s chord', () => {
    fc.assert(
      fc.property(
        intentEventArb,
        fc.constantFrom(...LETTERS), // decoy letter for the negative assertion
        ({ letter, modifier, shiftKey, event }, decoyLetterRaw) => {
          const decoyLetter = decoyLetterRaw === letter
            ? LETTERS[(LETTERS.indexOf(letter) + 1) % LETTERS.length]!
            : decoyLetterRaw
          const shiftPrefix = shiftKey ? 'Shift+' : ''

          const recovered = withRecoveredLetterKey(event)

          const intendedPress = parseKeybinding(`${shiftPrefix}${modifier}+${letter}`)[0]!
          expect(
            matchKeybindingPress(recovered, intendedPress),
            `expected recovery of ${JSON.stringify({ key: event.key, code: event.code })} to match the intended chord ${shiftPrefix}${modifier}+${letter}`,
          ).toBe(true)

          const decoyPress = parseKeybinding(`${shiftPrefix}${modifier}+${decoyLetter}`)[0]!
          expect(
            matchKeybindingPress(recovered, decoyPress),
            `expected recovery to NOT match the unrelated decoy chord ${shiftPrefix}${modifier}+${decoyLetter}`,
          ).toBe(false)
        },
      ),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
