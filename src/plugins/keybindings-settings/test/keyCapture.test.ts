// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest'
import {
  chordFromEvent,
  formatChord,
  isModifierOnly,
  normalizeChord,
} from '../keyCapture.ts'

const mk = (over: Partial<{key: string; code: string; keyCode: number; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean}>) => ({
  key: '',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
})

// chordFromEvent reads navigator.platform to decide which physical
// modifier ($mod) normalises to. Stub it per-test so the captures we
// assert about don't depend on whichever machine runs the suite.
const stubPlatform = (platform: string) => {
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    get: () => platform,
  })
}

describe('chordFromEvent', () => {
  beforeEach(() => {
    stubPlatform('MacIntel')
  })

  it('returns null while only a modifier is held', () => {
    expect(chordFromEvent(mk({key: 'Meta', metaKey: true}))).toBeNull()
    expect(chordFromEvent(mk({key: 'Shift', shiftKey: true}))).toBeNull()
  })

  it('builds $mod+k from Meta+K on macOS', () => {
    expect(chordFromEvent(mk({key: 'k', metaKey: true}))).toBe('$mod+k')
  })

  it('builds $mod+k from Ctrl+K on Windows', () => {
    stubPlatform('Win32')
    expect(chordFromEvent(mk({key: 'k', ctrlKey: true}))).toBe('$mod+k')
  })

  it('builds $mod+Shift+K with modifiers in a stable order', () => {
    expect(chordFromEvent(mk({key: 'K', metaKey: true, shiftKey: true})))
      .toBe('$mod+Shift+K')
    expect(chordFromEvent(mk({key: 'K', shiftKey: true, metaKey: true})))
      .toBe('$mod+Shift+K')
  })

  it('maps non-primary Ctrl on macOS to literal Control (so vim Ctrl+D survives)', () => {
    expect(chordFromEvent(mk({key: 'd', ctrlKey: true}))).toBe('Control+d')
  })

  it('aliases arrow keys and Escape to tinykeys canonical names', () => {
    expect(chordFromEvent(mk({key: 'ArrowLeft', ctrlKey: true}))).toBe('Control+ArrowLeft')
    expect(chordFromEvent(mk({key: ' ', metaKey: true}))).toBe('$mod+Space')
    expect(chordFromEvent(mk({key: 'Escape'}))).toBe('Escape')
  })

  it('uses event.code to recover the logical digit when shift is held', () => {
    // Shift+3 reports key='#' on a US keyboard — that's the shifted
    // character, not the user's intent. event.code = 'Digit3' is the
    // stable physical-key fallback.
    expect(chordFromEvent(mk({key: '#', code: 'Digit3', shiftKey: true})))
      .toBe('Shift+Digit3')
  })

  it('captures shift+letter using event.key on QWERTY (uppercased)', () => {
    expect(chordFromEvent(mk({key: 'K', code: 'KeyK', shiftKey: true, metaKey: true})))
      .toBe('$mod+Shift+K')
  })

  it('respects Colemak/Dvorak letter layouts — uses event.key, not event.code', () => {
    // Colemak places the letter 'E' at QWERTY's KeyF position. When
    // a Colemak user presses Shift+E, event.code='KeyF' but
    // event.key='E' (their actual layout's letter, uppercased by
    // shift). Using event.code here would capture as 'Shift+KeyF' —
    // the physical position the user remapped *away* from. The
    // right behaviour is to trust event.key for letters.
    expect(chordFromEvent(mk({key: 'E', code: 'KeyF', shiftKey: true})))
      .toBe('Shift+E')
  })

  it('keeps trusting event.key when shift is not held (layout-respecting)', () => {
    // On a German keyboard, AltGr+8 produces '[' with code='Digit8'.
    // Without shift, we keep event.key so the user's layout works.
    expect(chordFromEvent(mk({key: '[', code: 'Digit8'}))).toBe('[')
  })

  it('recovers the logical letter from keyCode under Alt — fixes Mac Alt-transforms', () => {
    // Mac alt+y produces '¥' as event.key. event.keyCode still reports
    // 89 ('Y'), the logical letter the user pressed, so emit `Alt+y`
    // — matches what `withRecoveredLetterKey` produces in the reconciler.
    expect(chordFromEvent(mk({key: '¥', code: 'KeyY', keyCode: 89, altKey: true})))
      .toBe('Alt+y')
  })

  it('recovers the logical letter on Colemak — event.code lies about layout', () => {
    // Colemak user pressing Alt+y: their 'y' sits at physical KeyO, so
    // event.code='KeyO'. event.key on Linux is just 'y' (no transform);
    // on Mac it's an option-transform glyph. Either way keyCode=89
    // gives the logical 'y' the user meant.
    expect(chordFromEvent(mk({key: 'y', code: 'KeyO', keyCode: 89, altKey: true})))
      .toBe('Alt+y')
    expect(chordFromEvent(mk({key: 'ÿ', code: 'KeyO', keyCode: 89, altKey: true})))
      .toBe('Alt+y')
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
    expect(formatChord('$mod+Shift+k')).toBe('⌘⇧K')
    expect(formatChord('Control+Alt+ArrowLeft')).toBe('⌃⌥←')
  })

  it('strips tinykeys code prefixes for display', () => {
    expect(formatChord('Alt+KeyY')).toBe('⌥Y')
    expect(formatChord('Shift+Digit3')).toBe('⇧3')
  })

  it('maps punctuation code names to their glyphs', () => {
    stubPlatform('MacIntel')
    expect(formatChord('Control+Shift+Backquote')).toBe('⌃⇧`')
    expect(formatChord('Control+Shift+BracketLeft')).toBe('⌃⇧[')
  })

  it('spells Control out off-Mac, where ⌃ reads as noise', () => {
    stubPlatform('Win32')
    expect(formatChord('Control+d')).toBe('CtrlD')
    stubPlatform('MacIntel')
    expect(formatChord('Control+d')).toBe('⌃D')
  })

  it('preserves multi-char keys with title casing', () => {
    expect(formatChord('$mod+Enter')).toBe('⌘⏎')
    expect(formatChord('f5')).toBe('F5')
  })
})

describe('normalizeChord', () => {
  it('canonicalises modifier aliases to tinykeys names', () => {
    expect(normalizeChord('Shift+Meta+K')).toBe('$mod+Shift+K')
    expect(normalizeChord('control+option+a')).toBe('Control+Alt+a')
  })

  it('orders modifiers consistently: $mod, Control, Meta, Alt, Shift, key', () => {
    expect(normalizeChord('Shift+Alt+$mod+k')).toBe('$mod+Alt+Shift+k')
  })

  it('is idempotent', () => {
    const c = '$mod+Shift+k'
    expect(normalizeChord(c)).toBe(c)
    expect(normalizeChord(normalizeChord(c))).toBe(c)
  })
})

