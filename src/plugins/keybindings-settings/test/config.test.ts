import { describe, expect, it } from 'vitest'
import { CodecError } from '@/data/api'
import { keybindingOverridesCodec, keybindingOverridesProp } from '../config.ts'

describe('keybindingOverridesCodec', () => {
  it('decodes a valid array round-trip', () => {
    const sample = [
      {actionId: 'a', context: 'normal-mode', binding: {keys: 'cmd+k'}},
      {actionId: 'b', context: 'global', binding: {unbound: true}},
    ]
    expect(keybindingOverridesCodec.decode(sample)).toEqual(sample)
  })

  it('decodes null/undefined as an empty array', () => {
    expect(keybindingOverridesCodec.decode(null)).toEqual([])
    expect(keybindingOverridesCodec.decode(undefined)).toEqual([])
  })

  it('throws CodecError on non-array input', () => {
    expect(() => keybindingOverridesCodec.decode({})).toThrow(CodecError)
  })

  it('throws CodecError on malformed entries', () => {
    expect(() => keybindingOverridesCodec.decode([
      {actionId: '', context: 'normal-mode', binding: {keys: 'cmd+k'}},
    ])).toThrow(CodecError)

    expect(() => keybindingOverridesCodec.decode([
      {actionId: 'a', context: 'normal-mode', binding: {unbound: false}},
    ])).toThrow(CodecError)

    expect(() => keybindingOverridesCodec.decode([
      {actionId: 'a', context: 'normal-mode', binding: {keys: 42}},
    ])).toThrow(CodecError)
  })

  it('exposes the schema metadata', () => {
    expect(keybindingOverridesProp.name).toBe('keybindings:overrides')
    expect(keybindingOverridesProp.defaultValue).toEqual([])
  })
})
