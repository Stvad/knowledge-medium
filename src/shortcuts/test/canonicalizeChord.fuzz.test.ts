// @vitest-environment node
/**
 * Differential fuzz suite: `canonicalizeChord` (src/shortcuts/canonicalizeChord.ts)
 * against tinykeys' own dispatch. See `src/test/fuzz.ts` for the smoke/deep
 * tier mechanics and `docs/fuzzing.md` for conventions.
 *
 * The canonical chord is a COMPARISON key: the override strip
 * (`applyKeybindingOverrides`) and the settings conflict detector
 * (`findKeybindingConflicts`) both treat two chords as "the same binding"
 * exactly when their canonical keys are equal. What makes two bindings the
 * same is what tinykeys does with them, so the oracle here is tinykeys
 * itself (`parseKeybinding` + `matchKeybindingPress`), never the canonical
 * function's own parse:
 *
 *   same canonical key  ⇔  tinykeys fires both installed forms on exactly
 *                          the same keyboard events
 *
 * "Installed form" is `normalizeChordSequence(chord)` — what an override is
 * installed as (tinykeys only knows `Control`/`Meta`/`Alt`/`Shift`/`$mod`).
 * Event sets are computed exhaustively over a fixed universe of realistic
 * `key`/`code` pairs × all 16 modifier states, with deliberately
 * distinguishing layouts (AZERTY/Dvorak letters, shifted digits, numpad)
 * so a `code`-form token and its logical-key spelling never look alike.
 *
 * Soundness (⇒) holds for every chord in the generated domain; completeness
 * (⇐) only for LIVE chords — two dead spellings (`digit1`, `keya`, which
 * tinykeys can never fire) are trivially equal as event sets and need not
 * share a bucket.
 *
 * Out of the generated domain, because no capture path or default authors
 * them: tinykeys' optional-modifier syntax (`[Shift]+k`), two non-modifier
 * tokens in one press (`a+b`, which tinykeys reads as an unknown required
 * modifier), and a bare-modifier press.
 *
 * Runs on both platform families: tinykeys resolves `$mod` at module load
 * (`Meta` on Mac, `Control` elsewhere) and `isMacPlatform` reads `navigator`
 * per call, so each platform stubs `navigator` and loads its own tinykeys
 * instance. `vi.resetModules` cannot do that — tinykeys is an externalized
 * dependency, cached by Node's loader — so the instance is imported by file
 * URL with a per-platform query, which Node evaluates as a separate module.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import { canonicalizeChord, normalizeChordSequence } from '../canonicalizeChord.ts'

type Tinykeys = typeof import('tinykeys')
type Physical = 'Shift' | 'Meta' | 'Alt' | 'Control'
const PHYSICAL: readonly Physical[] = ['Shift', 'Meta', 'Alt', 'Control']

/** Realistic `[event.key, event.code]` pairs. Each logical key also appears
 *  on some OTHER physical key, and each physical key also yields some other
 *  logical key, so `KeyA` vs `a`, `Digit1` vs `1`, `Slash` vs `/` … always
 *  differ on at least one event. */
const KEY_CODE_PAIRS: readonly (readonly [string, string])[] = [
  ['a', 'KeyA'], ['A', 'KeyA'], ['q', 'KeyA'], ['a', 'KeyQ'], ['q', 'KeyQ'],
  ['k', 'KeyK'], ['K', 'KeyK'], ['k', 'KeyV'],
  ['1', 'Digit1'], ['!', 'Digit1'], ['3', 'Digit3'], ['3', 'Numpad3'],
  ['+', 'Equal'], ['=', 'Equal'], ['+', 'NumpadAdd'],
  ['Enter', 'Enter'], ['ArrowDown', 'ArrowDown'], ['F2', 'F2'], ['Escape', 'Escape'],
  [' ', 'Space'], ['.', 'Period'], ['>', 'Period'], ['.', 'NumpadDecimal'],
  ['/', 'Slash'], ['/', 'Digit7'], [']', 'BracketRight'], ['[', 'BracketLeft'],
]

interface FakeKeyEvent {
  readonly key: string
  readonly code: string
  getModifierState(mod: string): boolean
}

const EVENTS: readonly FakeKeyEvent[] = KEY_CODE_PAIRS.flatMap(([key, code]) =>
  Array.from({length: 1 << PHYSICAL.length}, (_, mask) => {
    const held = new Set(PHYSICAL.filter((_, i) => mask & (1 << i)))
    return {key, code, getModifierState: (mod: string) => held.has(mod as Physical)}
  }))

/** Bitstring of which universe events each press of `chord` fires on, one
 *  segment per press — the tinykeys-side identity of a binding. */
const dispatchSignature = (tk: Tinykeys, chord: string): string =>
  tk.parseKeybinding(chord)
    .map(press => EVENTS.map(event => tk.matchKeybindingPress(event as never, press) ? '1' : '0').join(''))
    .join(' ')

const isLive = (signature: string): boolean =>
  signature.split(' ').every(segment => segment.includes('1'))

const MOD_SPELLINGS = [
  '$mod', 'cmd', 'Cmd', 'CMD', 'meta', 'Meta', 'os', 'OS',
  'ctrl', 'Ctrl', 'control', 'Control', 'CONTROL',
  'option', 'Option', 'alt', 'Alt', 'ALT', 'shift', 'Shift', 'SHIFT',
] as const

const KEY_TOKENS = [
  'a', 'A', 'k', 'K', 'q', '1', '3', '+', '=', '.', '/', ']', '[',
  'Enter', 'enter', 'ENTER', 'ArrowDown', 'arrowdown', 'F2', 'f2', 'Escape', 'escape',
  'Space', 'space', 'KeyA', 'keya', 'KEYA', 'KeyK', 'KeyQ', 'Digit1', 'digit1', 'Digit3',
  'Numpad3', 'numpad3', 'Period', 'period', 'Slash', 'Equal',
] as const

const pressArb = fc.record({
  mods: fc.array(fc.constantFrom(...MOD_SPELLINGS), {maxLength: 4}),
  key: fc.constantFrom(...KEY_TOKENS),
}).map(({mods, key}) => [...mods, key].join('+'))

const chordArb = fc.array(pressArb, {minLength: 1, maxLength: 2}).map(presses => presses.join(' '))

/** Modifier spellings that fold to the same canonical name on EVERY
 *  platform (`meta`/`os` vs `cmd` differ off-Mac, so they are separate). */
const SPELLING_FAMILIES: readonly (readonly string[])[] = [
  ['$mod', 'cmd', 'Cmd', 'CMD'], ['meta', 'Meta', 'os', 'OS'],
  ['ctrl', 'Ctrl', 'control', 'Control', 'CONTROL'],
  ['option', 'Option', 'alt', 'Alt', 'ALT'], ['shift', 'Shift', 'SHIFT'],
]

/** Re-spell `chord` press by press — each modifier swapped for a random
 *  spelling, modifiers shuffled, key case possibly flipped —
 *  drawing choices from `picks`. Pairs biased this way share a bucket far
 *  more often than two independent chords do. */
const respell = (chord: string, picks: readonly number[]): string => {
  let cursor = 0
  const pick = (n: number) => picks[cursor++ % picks.length] % n
  return chord.split(' ').map(press => {
    const tokens = press.split(/(?<=\w|\])\+/)
    const key = tokens.pop()!
    const mods = tokens.map(token => {
      // Mostly a same-family spelling; sometimes any modifier, so pairs that
      // differ in exactly one modifier (a near-collision) come up too.
      const family = pick(4) === 0
        ? SPELLING_FAMILIES[pick(SPELLING_FAMILIES.length)]
        : SPELLING_FAMILIES.find(f => f.includes(token))!
      return family[pick(family.length)]
    })
    for (let i = mods.length - 1; i > 0; i--) {
      const j = pick(i + 1)
      ;[mods[i], mods[j]] = [mods[j], mods[i]]
    }
    const recased = [key, key.toLowerCase(), key.toUpperCase()][pick(3)]
    return [...mods, recased].join('+')
  }).join(' ')
}

const pairArb = fc.oneof(
  fc.tuple(chordArb, chordArb),
  fc.tuple(chordArb, fc.array(fc.nat(), {minLength: 1, maxLength: 16}))
    .map(([a, picks]) => [a, respell(a, picks)] as const),
)

describe.each([
  {platform: 'Linux x86_64', label: 'off-Mac'},
  {platform: 'MacIntel', label: 'macOS'},
])('canonicalizeChord buckets chords exactly as tinykeys dispatches them ($label)', ({platform}) => {
  let tk: Tinykeys
  beforeAll(async () => {
    vi.stubGlobal('navigator', {platform, userAgent: ''})
    const cjsEntry = createRequire(import.meta.url).resolve('tinykeys')
    const esmEntry = pathToFileURL(cjsEntry.replace(/\.cjs$/, '.mjs')).href
    tk = await import(/* @vite-ignore */ `${esmEntry}?platform=${encodeURIComponent(platform)}`)
  })
  afterAll(() => { vi.unstubAllGlobals() })

  it('same canonical key ⇔ same dispatch on every event (completeness for live chords)', () => {
    fc.assert(
      fc.property(pairArb, ([a, b]) => {
        const sigA = dispatchSignature(tk, normalizeChordSequence(a))
        const sigB = dispatchSignature(tk, normalizeChordSequence(b))
        const sameBucket = canonicalizeChord(a) === canonicalizeChord(b)
        if (sameBucket) expect(sigA, `${a} / ${b} share a bucket but dispatch differently`).toBe(sigB)
        else if (isLive(sigA) && sigA === sigB) {
          expect.fail(`${a} and ${b} fire on the same events but land in buckets ` +
            `${canonicalizeChord(a)} / ${canonicalizeChord(b)}`)
        }
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
