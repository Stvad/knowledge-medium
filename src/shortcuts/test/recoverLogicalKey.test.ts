import { describe, expect, it } from 'vitest'
import { withRecoveredLetterKey } from '../utils.ts'

const mk = (init: Partial<KeyboardEventInit> & {keyCode?: number}): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', init as KeyboardEventInit)
  // KeyboardEventInit ignores `keyCode` in modern browsers, so set it
  // explicitly — this is the field we're recovering FROM in the helper.
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', {value: init.keyCode, configurable: true})
  }
  return event
}

describe('withRecoveredLetterKey', () => {
  it('returns the event unchanged when no alt/meta is held', () => {
    // Bare letter typing — tinykeys handles this fine via event.key.
    const event = mk({key: 'y', code: 'KeyY', keyCode: 89})
    expect(withRecoveredLetterKey(event).key).toBe('y')
    expect(withRecoveredLetterKey(event)).toBe(event)
  })

  it('returns the event unchanged when event.key already matches keyCode-derived letter', () => {
    // Linux/Windows Alt+y on QWERTY — event.key is the logical letter
    // already, no recovery needed. Identity preserves prototype methods.
    const event = mk({key: 'y', code: 'KeyY', keyCode: 89, altKey: true})
    expect(withRecoveredLetterKey(event)).toBe(event)
  })

  it('recovers the logical letter when Mac Alt-transformation hid it', () => {
    // Mac QWERTY Alt+y — event.key='¥' (option-y transform), event.code='KeyY'.
    // keyCode still reports the logical letter, so recover from there.
    const event = mk({key: '¥', code: 'KeyY', keyCode: 89, altKey: true})
    expect(withRecoveredLetterKey(event).key).toBe('y')
  })

  it('recovers the logical letter on Colemak when event.code lies about layout', () => {
    // Mac Colemak Alt+y: user's 'y' is at physical KeyO position,
    // event.key is alt-transformed (e.g. 'ÿ'), event.code='KeyO'.
    // Neither event.key nor event.code points to 'y' — keyCode does.
    const event = mk({key: 'ÿ', code: 'KeyO', keyCode: 89, altKey: true})
    expect(withRecoveredLetterKey(event).key).toBe('y')
  })

  it('recovers under Meta as well as Alt', () => {
    // Some platforms apply Meta-transformations too. Treat both as
    // "key might be transformed".
    const event = mk({key: '¥', code: 'KeyY', keyCode: 89, metaKey: true})
    expect(withRecoveredLetterKey(event).key).toBe('y')
  })

  it('does not touch non-letter keyCodes (digits, special keys)', () => {
    // Digit recovery is layout-dependent in a different way and the
    // chord DSL uses Digit{N} codes for these — out of scope.
    const digitEvent = mk({key: '!', code: 'Digit1', keyCode: 49, shiftKey: true})
    expect(withRecoveredLetterKey(digitEvent)).toBe(digitEvent)

    const escapeEvent = mk({key: 'Escape', code: 'Escape', keyCode: 27, altKey: true})
    expect(withRecoveredLetterKey(escapeEvent)).toBe(escapeEvent)
  })

  it('preserves event prototype methods (getModifierState etc.) on the recovered view', () => {
    // tinykeys' matcher calls event.getModifierState — the wrapper
    // must keep it callable, not strip it via spread/clone.
    const event = mk({key: '¥', code: 'KeyY', keyCode: 89, altKey: true})
    const recovered = withRecoveredLetterKey(event)
    expect(typeof recovered.getModifierState).toBe('function')
    expect(recovered.getModifierState('Alt')).toBe(true)
    expect(recovered.altKey).toBe(true)
    expect(recovered.code).toBe('KeyY')
  })

  it('emits lowercase letters regardless of Shift', () => {
    // tinykeys matches the chord key case-insensitively, so the canonical
    // recovered form is lowercase. With Shift held the chord might be
    // written as `Shift+Y` or `Shift+y` — both match.
    const event = mk({key: 'Ÿ', code: 'KeyY', keyCode: 89, altKey: true, shiftKey: true})
    expect(withRecoveredLetterKey(event).key).toBe('y')
  })
})
