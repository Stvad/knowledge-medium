import { afterEach, describe, expect, it } from 'vitest'
import {
  canonicalizeChord,
  matchesMouseEvent,
  normalizeChord,
  normalizeChordSequence,
  pointerBindingDescriptor,
  type MouseChordDescriptor,
  type MouseEventLike,
} from './canonicalizeChord.ts'

// The Meta/$mod fold is platform-aware, so stub navigator.platform for the
// cases that depend on it. Default (no stub) falls back to the jsdom
// userAgent, which is non-Mac.
const stubPlatform = (platform: string) => {
  Object.defineProperty(navigator, 'platform', {configurable: true, get: () => platform})
}

describe('canonicalizeChord', () => {
  afterEach(() => stubPlatform(''))

  it('canonicalises each press of a sequence instead of mangling on "+"', () => {
    // A naive '+' split would shatter 'Cmd+K Cmd+S' into ['Cmd', 'K Cmd',
    // 'S']; splitting on space first keeps each press intact.
    expect(canonicalizeChord('Cmd+K Cmd+S')).toBe('$mod+k $mod+s')
  })

  it('folds final-key case: $mod+K and $mod+k are one binding at dispatch', () => {
    // tinykeys compares key.toUpperCase() on both sides, so case-variant
    // spellings dispatch identically and must share a canonical bucket
    // (strip map, conflict detection). normalizeChord deliberately keeps
    // case — the settings UI round-trips the user's spelling.
    expect(canonicalizeChord('$mod+K')).toBe(canonicalizeChord('$mod+k'))
    expect(canonicalizeChord('Cmd+K')).toBe(canonicalizeChord('$mod+k'))
  })

  it('treats alias- and order-equivalent chords as the same key', () => {
    expect(canonicalizeChord('Shift+Cmd+k')).toBe(canonicalizeChord('cmd+shift+k'))
  })

  it('folds Meta into $mod on macOS (Meta is the primary there)', () => {
    stubPlatform('MacIntel')
    expect(canonicalizeChord('Meta+k')).toBe(canonicalizeChord('$mod+k'))
  })

  it('keeps Meta distinct from $mod off-Mac (Super is not Ctrl)', () => {
    stubPlatform('Win32')
    expect(canonicalizeChord('Meta+k')).toBe('Meta+k')
    expect(canonicalizeChord('$mod+k')).toBe('$mod+k')
    expect(canonicalizeChord('Meta+k')).not.toBe(canonicalizeChord('$mod+k'))
  })

  it('distinguishes the same chord on different phases', () => {
    expect(canonicalizeChord('s', 'hold')).not.toBe(canonicalizeChord('s', 'keyup'))
    expect(canonicalizeChord('s')).toBe('s')
  })

  it('preserves case for event.code-only keys so mis-cased overrides do not forge a collision', () => {
    // `Digit1`/`Period`/`Space`/`KeyA`/`Numpad3` dispatch ONLY through
    // tinykeys' case-sensitive `event.code` comparison (their event.key is
    // '1'/'.'/' '/'a'/'3'), so a lowercase spelling fires nothing. Folding
    // them would (a) let a dead `Control+Shift+digit1` strip the working
    // `Control+Shift+Digit1` default and (b) is meaningless — they must
    // stay exact-cased and in their own bucket.
    expect(canonicalizeChord('Control+Shift+Digit1')).toBe('Control+Shift+Digit1')
    expect(canonicalizeChord('Control+Shift+Digit1'))
      .not.toBe(canonicalizeChord('Control+Shift+digit1'))
    expect(canonicalizeChord('$mod+Shift+Period')).toBe('$mod+Shift+Period')
    expect(canonicalizeChord('Space')).toBe('Space')
    expect(canonicalizeChord('KeyA')).toBe('KeyA')
    expect(canonicalizeChord('Numpad3')).toBe('Numpad3')
  })

  it('still folds case for logical keys that dispatch via event.key', () => {
    // Named keys whose event.key equals the code (Enter/ArrowUp/F2/Escape…)
    // match tinykeys' case-INSENSITIVE event.key path, so mis-cased
    // spellings still fire and must share one bucket — fold them.
    expect(canonicalizeChord('ArrowUp')).toBe(canonicalizeChord('arrowup'))
    expect(canonicalizeChord('Shift+Enter')).toBe(canonicalizeChord('Shift+enter'))
    expect(canonicalizeChord('F2')).toBe(canonicalizeChord('f2'))
    // …and single-character keys as before.
    expect(canonicalizeChord('$mod+K')).toBe(canonicalizeChord('$mod+k'))
  })
})

describe('matchesMouseEvent', () => {
  const mouseEvent = (overrides: Partial<MouseEventLike> = {}): MouseEventLike => ({
    button: 0,
    detail: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  })

  const shiftClick: MouseChordDescriptor = {
    kind: 'mouse', button: 0, detail: 1, mods: ['Shift'], phase: 'click',
  }

  it('matches a plain shift-click', () => {
    expect(matchesMouseEvent(shiftClick, mouseEvent({shiftKey: true}))).toBe(true)
  })

  it('requires the modifier set to match exactly (ctrl+shift is not shift)', () => {
    // The collision that matters: shift-click extends a selection, ctrl-click
    // toggles one. An extra modifier must NOT satisfy the shift-click binding.
    expect(matchesMouseEvent(shiftClick, mouseEvent({shiftKey: true, ctrlKey: true}))).toBe(false)
  })

  it('does not match when the required modifier is absent', () => {
    expect(matchesMouseEvent(shiftClick, mouseEvent())).toBe(false)
  })

  it('distinguishes button and click count', () => {
    const doublePrimary: MouseChordDescriptor = {
      kind: 'mouse', button: 0, detail: 2, mods: [], phase: 'pointerdown',
    }
    expect(matchesMouseEvent(doublePrimary, mouseEvent({detail: 2}))).toBe(true)
    expect(matchesMouseEvent(doublePrimary, mouseEvent({detail: 1}))).toBe(false)
    expect(matchesMouseEvent(doublePrimary, mouseEvent({detail: 2, button: 2}))).toBe(false)
  })

  it('matches a no-modifier descriptor only when no modifiers are held', () => {
    const plainClick: MouseChordDescriptor = {
      kind: 'mouse', button: 0, detail: 1, mods: [], phase: 'click',
    }
    expect(matchesMouseEvent(plainClick, mouseEvent())).toBe(true)
    expect(matchesMouseEvent(plainClick, mouseEvent({altKey: true}))).toBe(false)
  })
})

describe('pointerBindingDescriptor', () => {
  it('realizes a touch tap with only its kind and phase', () => {
    expect(pointerBindingDescriptor({kind: 'touch'})).toEqual({kind: 'touch', phase: 'tap'})
    expect(pointerBindingDescriptor({kind: 'touch', phase: 'tap'})).toEqual({kind: 'touch', phase: 'tap'})
  })

  it('defaults a mouse binding to a plain single primary click', () => {
    expect(pointerBindingDescriptor({kind: 'mouse'})).toEqual({
      kind: 'mouse', button: 0, detail: 1, mods: [], phase: 'click',
    })
  })

  it('carries a double-click through at the pointerdown phase', () => {
    expect(pointerBindingDescriptor({kind: 'mouse', detail: 2, phase: 'pointerdown'})).toEqual({
      kind: 'mouse', button: 0, detail: 2, mods: [], phase: 'pointerdown',
    })
  })
})

describe('normalizeChordSequence', () => {
  it('normalises each press of a sequence, preserving the key\'s case', () => {
    // The install form for keybinding overrides (issue #388): modifier
    // aliases fold to dispatch-live names, display case survives — unlike
    // canonicalizeChord, which case-folds because it's a comparison key.
    expect(normalizeChordSequence('Cmd+K Cmd+S')).toBe('$mod+K $mod+S')
    expect(normalizeChordSequence('ctrl+ArrowDown')).toBe('Control+ArrowDown')
    expect(normalizeChordSequence('')).toBe('')
  })
})

describe('normalizeChord (behaviour pinned across the lift)', () => {
  // keyCapture.test.ts covers the ordinary cases through the re-export;
  // these pin the adversarial edges of the "alias or key" rewrite. Only the
  // platform-independent rows live in the table (cmd folds to $mod on every
  // platform); the meta cases are asserted per-platform below.
  afterEach(() => stubPlatform(''))
  it.each([
    ['cmd+shift', '$mod+Shift'],       // all-modifier chord, no final key
    ['k+cmd', '$mod+k'],               // non-modifier before a modifier
    [' cmd + k ', '$mod+k'],           // surrounding whitespace trimmed
    ['', ''],                          // empty input stays empty
  ])('normalizeChord(%j) === %j', (input, expected) => {
    expect(normalizeChord(input)).toBe(expected)
  })

  it('folds meta→$mod on macOS but keeps it literal off-Mac', () => {
    stubPlatform('MacIntel')
    expect(normalizeChord('meta+cmd+k')).toBe('$mod+k')  // duplicate primary → one $mod
    expect(normalizeChord('Meta+K')).toBe('$mod+K')      // final-key case kept
    stubPlatform('Win32')
    expect(normalizeChord('meta+cmd+k')).toBe('$mod+Meta+k')  // Cmd=$mod, Meta=Super, distinct
    expect(normalizeChord('Meta+K')).toBe('Meta+K')
  })
})
