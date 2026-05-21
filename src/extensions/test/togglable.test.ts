/**
 * Unit tests for the togglable primitives.
 *
 * The primitives are pure data — no React, no PowerSync. Tests target:
 *   - factory invariants (system vs user-extension asymmetry)
 *   - boundary marker survives standard array operations
 *   - isEnabled / applyToggle behaviour, especially around the
 *     `defaultEnabled ?? true` convention
 */
import {describe, expect, it} from 'vitest'
import {aliasesProp} from '@/data/internals/coreProperties.ts'
import {makeBlockData} from '@/data/test/factories.ts'
import {
  extensionDescriptionProp,
  extensionNameProp,
} from '@/data/properties.ts'
import {
  applyToggle,
  getBoundary,
  isEnabled,
  systemToggle,
  userExtensionShellToggle,
  userExtensionToggle,
  type Overrides,
  type Togglable,
} from '@/extensions/togglable.ts'

const emptyOverrides: Overrides = new Map()

describe('systemToggle', () => {
  it('mirrors all option fields and exposes a working `of`', () => {
    const handle = systemToggle({
      id: 'system:backlinks',
      name: 'Backlinks',
      description: 'Two-way link surface',
      essential: false,
      defaultEnabled: true,
    })

    expect(handle.id).toBe('system:backlinks')
    expect(handle.name).toBe('Backlinks')
    expect(handle.description).toBe('Two-way link surface')
    expect(handle.essential).toBe(false)
    expect(handle.defaultEnabled).toBe(true)
    expect(handle.kind).toBe('system')

    const wrapped = handle.of([])
    expect(getBoundary(wrapped)).toBe(handle)
  })

  it('records the boundary marker as a non-enumerable symbol property', () => {
    const handle = systemToggle({id: 'system:x', name: 'X'})
    const wrapped = handle.of([]) as object
    expect(Array.isArray(wrapped)).toBe(true)
    // Symbol-keyed marker must be present but non-enumerable.
    const symbolKeys = Object.getOwnPropertySymbols(wrapped)
    expect(symbolKeys.length).toBeGreaterThan(0)
    for (const sym of symbolKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(wrapped, sym)
      expect(descriptor?.enumerable).toBe(false)
    }
    // JSON serialization should ignore the marker.
    expect(JSON.parse(JSON.stringify(wrapped))).toEqual([[]])
  })
})

describe('userExtensionToggle', () => {
  it('forces id to block.id and starts disabled until explicitly enabled', () => {
    const block = makeBlockData({id: 'block-123', workspaceId: 'ws'})
    const handle = userExtensionToggle(block)
    expect(handle.id).toBe('block-123')
    expect(handle.defaultEnabled).toBe(false)
    expect(handle.essential).toBe(false)
    expect(handle.kind).toBe('user')
  })

  it('uses extension metadata properties for display name and description', () => {
    const block = makeBlockData({
      id: 'block-meta',
      workspaceId: 'ws',
      properties: {
        [extensionNameProp.name]: extensionNameProp.codec.encode('Property Name'),
        [extensionDescriptionProp.name]: extensionDescriptionProp.codec.encode('Property description'),
      },
    })
    const handle = userExtensionToggle(block)
    expect(handle.name).toBe('Property Name')
    expect(handle.description).toBe('Property description')
  })

  it('uses the first alias as the display name when present', () => {
    const block = makeBlockData({
      id: 'block-aliased',
      workspaceId: 'ws',
      properties: {
        [aliasesProp.name]: aliasesProp.codec.encode(['My Extension', 'Alt name']),
      },
    })
    const handle = userExtensionToggle(block)
    expect(handle.name).toBe('My Extension')
  })

  it('prefers the extension name property over aliases', () => {
    const block = makeBlockData({
      id: 'block-name-wins',
      workspaceId: 'ws',
      properties: {
        [extensionNameProp.name]: extensionNameProp.codec.encode('Extension property'),
        [aliasesProp.name]: aliasesProp.codec.encode(['Alias fallback']),
      },
    })
    const handle = userExtensionToggle(block)
    expect(handle.name).toBe('Extension property')
  })

  it('falls back to a block-id snippet when no name metadata exists', () => {
    const block = makeBlockData({id: 'abcdef1234567890', workspaceId: 'ws'})
    const handle = userExtensionToggle(block)
    expect(handle.name).toBe('Extension abcdef12')
  })
})

describe('userExtensionShellToggle', () => {
  it('is the same shape as userExtensionToggle without compiling code', () => {
    const block = makeBlockData({id: 'block-shell', workspaceId: 'ws'})
    const shell = userExtensionShellToggle(block)
    expect(shell.id).toBe('block-shell')
    expect(shell.defaultEnabled).toBe(false)
    expect(shell.name).toBe('Extension block-sh')
  })
})

describe('isEnabled', () => {
  const handle = systemToggle({
    id: 'system:y',
    name: 'Y',
    defaultEnabled: true,
  })

  it('returns the override when present', () => {
    const overrides: Overrides = new Map([['system:y', false]])
    expect(isEnabled(handle, overrides)).toBe(false)
  })

  it('falls back to defaultEnabled when no override', () => {
    expect(isEnabled(handle, emptyOverrides)).toBe(true)
  })

  it('treats undefined defaultEnabled as true', () => {
    const noDefault = systemToggle({id: 'system:z', name: 'Z'})
    expect(isEnabled(noDefault, emptyOverrides)).toBe(true)
  })

  it('honours a `false` defaultEnabled in absence of an override', () => {
    const offByDefault = systemToggle({
      id: 'system:opt-in',
      name: 'Opt-in',
      defaultEnabled: false,
    })
    expect(isEnabled(offByDefault, emptyOverrides)).toBe(false)
  })

  it('forces essential handles to enabled regardless of overrides', () => {
    const essential = systemToggle({
      id: 'system:core',
      name: 'Core',
      essential: true,
    })
    const overrides: Overrides = new Map([['system:core', false]])
    expect(isEnabled(essential, overrides)).toBe(true)
  })
})

describe('applyToggle', () => {
  const handle: Togglable = systemToggle({
    id: 'system:x',
    name: 'X',
    defaultEnabled: true,
  })

  it('records an entry when nextState differs from default', () => {
    const next = applyToggle(emptyOverrides, handle, false)
    expect(next.get('system:x')).toBe(false)
  })

  it('removes any entry when nextState equals default', () => {
    const overrides: Overrides = new Map([['system:x', false]])
    const next = applyToggle(overrides, handle, true)
    expect(next.has('system:x')).toBe(false)
  })

  it('treats undefined defaultEnabled as true when deciding to delete', () => {
    const noDefault = systemToggle({id: 'system:nd', name: 'ND'})
    const overrides: Overrides = new Map([['system:nd', false]])
    const next = applyToggle(overrides, noDefault, true)
    expect(next.has('system:nd')).toBe(false)
  })

  it('does not mutate the input map', () => {
    const overrides: Overrides = new Map([['system:x', false]])
    applyToggle(overrides, handle, true)
    expect(overrides.get('system:x')).toBe(false)
  })
})
