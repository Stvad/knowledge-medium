import { describe, expect, it } from 'vitest'
import {
  chordFromEvent,
  formatChord,
  isModifierOnly,
  normalizeChord,
} from '../keyCapture.ts'

const mk = (over: Partial<{key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean}>) => ({
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
