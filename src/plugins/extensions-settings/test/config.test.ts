/**
 * Codec contract for the Extensions overrides property.
 *
 *   - encode/decode round-trip preserves the map
 *   - explicit `null` decodes to an empty map (manual reset friendly)
 *   - shape mismatches throw a CodecError (the subscription effect
 *     turns this into a logged warning + fallback-to-no-overrides)
 */
import {describe, expect, it} from 'vitest'
import {CodecError} from '@/data/api'
import {
  overridesCodec,
  extensionsPrefsType,
} from '@/plugins/extensions-settings/config.js'
import type {Overrides} from '@/extensions/togglable.js'

describe('overridesCodec', () => {
  it('uses the Extensions overrides codec id', () => {
    expect(overridesCodec.type).toBe('extensions:overrides')
  })

  it('round-trips a populated map through encode/decode', () => {
    const original: Overrides = new Map([
      ['system:a', false],
      ['system:b', true],
    ])
    const encoded = overridesCodec.encode(original)
    const restored = overridesCodec.decode(encoded)
    expect(Array.from(restored.entries()).sort()).toEqual([
      ['system:a', false],
      ['system:b', true],
    ])
  })

  it('encodes an empty map to an empty object', () => {
    expect(overridesCodec.encode(new Map())).toEqual({})
  })

  it('decodes null to an empty map', () => {
    expect(overridesCodec.decode(null).size).toBe(0)
  })

  it('decodes an empty object to an empty map', () => {
    expect(overridesCodec.decode({}).size).toBe(0)
  })

  it('throws CodecError on arrays', () => {
    expect(() => overridesCodec.decode([1, 2, 3])).toThrow(CodecError)
  })

  it('throws CodecError on string input', () => {
    expect(() => overridesCodec.decode('disabled')).toThrow(CodecError)
  })

  it('throws CodecError when any value is not a boolean', () => {
    expect(() => overridesCodec.decode({a: false, b: 'no'})).toThrow(CodecError)
    expect(() => overridesCodec.decode({a: 1})).toThrow(CodecError)
  })

  it('does not have a `where` capability (overrides map is never filtered)', () => {
    expect(overridesCodec.where).toBeUndefined()
  })
})

describe('extensionsPrefsType', () => {
  it('uses Extensions ids and label for the prefs block type', () => {
    expect(extensionsPrefsType.id).toBe('extensions-prefs')
    expect(extensionsPrefsType.label).toBe('Extensions')
  })
})
