import { describe, expect, it } from 'vitest'
import { isTypingKeyEvent } from '../utils.ts'

const makeEvent = (init: KeyboardEventInit): KeyboardEvent =>
  new KeyboardEvent('keydown', init)

describe('isTypingKeyEvent', () => {
  it.each([
    ['bare letter', {key: 'p'}],
    ['bare digit', {key: '1'}],
    ['shifted letter (capital)', {key: 'P', shiftKey: true}],
    ['shifted digit (symbol)', {key: '!', shiftKey: true}],
    ['Enter', {key: 'Enter'}],
    ['Backspace', {key: 'Backspace'}],
    ['Tab', {key: 'Tab'}],
    ['ArrowDown', {key: 'ArrowDown'}],
    ['Shift held alone', {key: 'Shift', shiftKey: true}],
  ])('treats %s as typing', (_label, init) => {
    expect(isTypingKeyEvent(makeEvent(init))).toBe(true)
  })

  it.each([
    ['cmd+letter (palette)', {key: 'k', metaKey: true}],
    ['ctrl+letter', {key: 'c', ctrlKey: true}],
    ['alt+letter', {key: 'q', altKey: true}],
    ['cmd+shift+letter', {key: 'P', metaKey: true, shiftKey: true}],
    ['ctrl+alt+delete', {key: 'Delete', ctrlKey: true, altKey: true}],
  ])('treats %s as a chord, not typing', (_label, init) => {
    expect(isTypingKeyEvent(makeEvent(init))).toBe(false)
  })
})
