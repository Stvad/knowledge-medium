import { describe, expect, it } from 'vitest'
import {
  chordFromEvent,
  formatChord,
  isModifierOnly,
  normalizeChord,
} from '../keyCapture.ts'

const mk = (over: Partial<{key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean}>) => ({
  key: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
})

describe('chordFromEvent', () => {
  it('returns null while only a modifier is held', () => {
    expect(chordFromEvent(mk({key: 'Meta', metaKey: true}))).toBeNull()
    expect(chordFromEvent(mk({key: 'Shift', shiftKey: true}))).toBeNull()
  })

  it('builds cmd+k from Meta+K', () => {
    expect(chordFromEvent(mk({key: 'k', metaKey: true}))).toBe('cmd+k')
  })

  it('builds cmd+shift+k with modifiers in a stable order', () => {
    expect(chordFromEvent(mk({key: 'K', metaKey: true, shiftKey: true})))
      .toBe('cmd+shift+k')
    expect(chordFromEvent(mk({key: 'K', shiftKey: true, metaKey: true})))
      .toBe('cmd+shift+k')
  })

  it('aliases arrow keys and space to hotkeys-js canonical names', () => {
    expect(chordFromEvent(mk({key: 'ArrowLeft', ctrlKey: true}))).toBe('ctrl+left')
    expect(chordFromEvent(mk({key: ' ', metaKey: true}))).toBe('cmd+space')
    expect(chordFromEvent(mk({key: 'Escape'}))).toBe('esc')
  })

  it('uses event.code to recover the logical digit when shift is held', () => {
    // Shift+3 reports key='#' on a US keyboard — that's the shifted
    // character, not the user's intent. event.code = 'Digit3' is the
    // stable physical-key fallback.
    expect(chordFromEvent(mk({key: '#', code: 'Digit3', shiftKey: true})))
      .toBe('shift+3')
  })

  it('captures shift+letter using event.key on QWERTY (uppercased → lowercased)', () => {
    expect(chordFromEvent(mk({key: 'K', code: 'KeyK', shiftKey: true, metaKey: true})))
      .toBe('cmd+shift+k')
  })

  it('respects Colemak/Dvorak letter layouts — uses event.key, not event.code', () => {
    // Colemak places the letter 'E' at QWERTY's KeyF position. When
    // a Colemak user presses Shift+E, event.code='KeyF' but
    // event.key='E' (their actual layout's letter, uppercased by
    // shift). Using event.code here would capture as 'shift+f' —
    // the physical position the user remapped *away* from. The
    // right behaviour is to trust event.key for letters.
    expect(chordFromEvent(mk({key: 'E', code: 'KeyF', shiftKey: true})))
      .toBe('shift+e')
  })

  it('keeps trusting event.key when shift is not held (layout-respecting)', () => {
    // On a German keyboard, AltGr+8 produces '[' with code='Digit8'.
    // Without shift, we keep event.key so the user's layout works.
    expect(chordFromEvent(mk({key: '[', code: 'Digit8'}))).toBe('[')
  })
})

describe('isModifierOnly', () => {
  it('recognises every modifier-key value', () => {
    for (const k of ['Control', 'Meta', 'Alt', 'Shift', 'OS']) {
      expect(isModifierOnly({key: k})).toBe(true)
    }
    expect(isModifierOnly({key: 'k'})).toBe(false)
  })
})

describe('formatChord', () => {
  it('renders modifier glyphs and uppercases the key', () => {
    expect(formatChord('cmd+shift+k')).toBe('⌘⇧K')
    expect(formatChord('ctrl+alt+left')).toBe('⌃⌥←')
  })

  it('preserves multi-char keys with title casing', () => {
    expect(formatChord('cmd+enter')).toBe('⌘⏎')
    expect(formatChord('f5')).toBe('F5')
  })
})

describe('normalizeChord', () => {
  it('canonicalises modifier order and aliases', () => {
    expect(normalizeChord('Shift+Meta+K')).toBe('cmd+shift+k')
    expect(normalizeChord('control+option+a')).toBe('ctrl+alt+a')
  })

  it('is idempotent', () => {
    const c = 'cmd+shift+k'
    expect(normalizeChord(c)).toBe(c)
    expect(normalizeChord(normalizeChord(c))).toBe(c)
  })
})
