import { describe, expect, it } from 'vitest'
import { canonicalizeChord, normalizeChord, parseChord } from './canonicalizeChord.ts'

describe('parseChord', () => {
  it('splits a sequence chord into one descriptor per press', () => {
    // The historical gap: 'g g' / 'd d' were treated as a single atomic
    // key because the splitter only split on '+'. They must become an
    // ordered list of presses.
    expect(parseChord('g g')).toEqual([
      {kind: 'key', key: 'g', mods: [], phase: 'keydown'},
      {kind: 'key', key: 'g', mods: [], phase: 'keydown'},
    ])
  })

  it('keeps a modifier press whole within a sequence', () => {
    expect(parseChord('Cmd+K Cmd+S')).toEqual([
      {kind: 'key', key: 'K', mods: ['$mod'], phase: 'keydown'},
      {kind: 'key', key: 'S', mods: ['$mod'], phase: 'keydown'},
    ])
  })

  it('alias-folds and orders modifiers on a plain chord', () => {
    expect(parseChord('Shift+Cmd+k')).toEqual([
      {kind: 'key', key: 'k', mods: ['$mod', 'Shift'], phase: 'keydown'},
    ])
  })

  it('stamps the requested phase onto every press', () => {
    expect(parseChord('s', 'keyup').map(d => d.phase)).toEqual(['keyup'])
  })
})

describe('canonicalizeChord', () => {
  it('canonicalises each press of a sequence instead of mangling on "+"', () => {
    // A naive '+' split would shatter 'Cmd+K Cmd+S' into ['Cmd', 'K Cmd',
    // 'S']; splitting on space first keeps each press intact.
    expect(canonicalizeChord('Cmd+K Cmd+S')).toBe('$mod+K $mod+S')
  })

  it('treats alias- and order-equivalent chords as the same key', () => {
    expect(canonicalizeChord('Shift+Cmd+k')).toBe(canonicalizeChord('cmd+shift+k'))
    expect(canonicalizeChord('Meta+k')).toBe(canonicalizeChord('$mod+k'))
  })

  it('distinguishes the same chord on different phases', () => {
    expect(canonicalizeChord('s', 'hold')).not.toBe(canonicalizeChord('s', 'keyup'))
    expect(canonicalizeChord('s')).toBe('s')
  })
})

describe('normalizeChord (behaviour pinned across the lift)', () => {
  // The whole PR's safety rests on normalizeChord being a relocation, not a
  // change. keyCapture.test.ts covers the ordinary cases through the
  // re-export; these pin the adversarial edges that the position-aware →
  // "alias or key" rewrite could plausibly have shifted.
  it.each([
    ['cmd+shift', '$mod+Shift'],       // all-modifier chord, no final key
    ['k+cmd', '$mod+k'],               // non-modifier before a modifier
    ['meta+cmd+k', '$mod+k'],          // duplicate primary folds to one $mod
    ['Meta+K', '$mod+K'],              // meta→$mod alias; final-key case kept
    [' cmd + k ', '$mod+k'],           // surrounding whitespace trimmed
    ['', ''],                          // empty input stays empty
  ])('normalizeChord(%j) === %j', (input, expected) => {
    expect(normalizeChord(input)).toBe(expected)
  })
})
