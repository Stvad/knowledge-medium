import { describe, expect, it } from 'vitest'
import {
  isKeyOverrideUnbound,
  isKeybindingOverride,
} from './keybindingOverrides.ts'

describe('isKeybindingOverride', () => {
  it('accepts a bound override with a single chord', () => {
    expect(isKeybindingOverride({
      actionId: 'demo',
      source: 'user-prefs',
      binding: {keys: 'cmd+k'},
    })).toBe(true)
  })

  it('accepts a bound override with multiple chords', () => {
    expect(isKeybindingOverride({
      actionId: 'demo',
      source: 'user-prefs',
      binding: {keys: ['cmd+k', 'ctrl+k']},
    })).toBe(true)
  })

  it('accepts an unbound override', () => {
    expect(isKeybindingOverride({
      actionId: 'demo',
      source: 'user-prefs',
      binding: {unbound: true},
    })).toBe(true)
  })

  it('accepts an explicit context', () => {
    expect(isKeybindingOverride({
      actionId: 'demo',
      context: 'normal-mode',
      source: 'user-prefs',
      binding: {keys: 'cmd+k'},
    })).toBe(true)
  })

  it('rejects an empty actionId', () => {
    expect(isKeybindingOverride({
      actionId: '',
      source: 'user-prefs',
      binding: {keys: 'cmd+k'},
    })).toBe(false)
  })

  it('rejects a missing source', () => {
    expect(isKeybindingOverride({
      actionId: 'demo',
      binding: {keys: 'cmd+k'},
    })).toBe(false)
  })

  it('rejects a malformed binding', () => {
    expect(isKeybindingOverride({
      actionId: 'demo',
      source: 'user-prefs',
      binding: {keys: 42},
    })).toBe(false)
  })

  it('rejects an unbound=false binding', () => {
    expect(isKeybindingOverride({
      actionId: 'demo',
      source: 'user-prefs',
      binding: {unbound: false},
    })).toBe(false)
  })
})

describe('isKeyOverrideUnbound', () => {
  it('discriminates the unbound branch', () => {
    expect(isKeyOverrideUnbound({unbound: true})).toBe(true)
    expect(isKeyOverrideUnbound({keys: 'cmd+k'})).toBe(false)
  })
})
