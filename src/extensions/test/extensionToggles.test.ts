/**
 * Unit tests for the extension-block → togglable decode (app layer).
 *
 * These cover the half of the toggle surface that reads block
 * properties: resolving a display name/description and the identifying
 * `extension:name` from a block without compiling it. The pure kernel
 * factories (`userToggle`, `systemToggle`, `isEnabled`, `applyToggle`)
 * are tested in `@/facets/test/togglable.test.ts`.
 */
import {describe, expect, it} from 'vitest'
import {makeBlockData} from '@/data/test/factories.js'
import {
  extensionDescriptionProp,
  extensionNameProp,
} from '@/data/properties.js'
import {
  extensionName,
  userExtensionShellToggle,
  userExtensionToggle,
} from '@/extensions/extensionToggles.js'

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

describe('extensionName', () => {
  it('returns the extension:name property', () => {
    const block = makeBlockData({
      id: 'block-labels',
      workspaceId: 'ws',
      properties: {
        [extensionNameProp.name]: extensionNameProp.codec.encode('Canonical'),
      },
    })
    expect(extensionName(block)).toBe('Canonical')
  })

  it('is undefined when the block has no name', () => {
    const block = makeBlockData({id: 'bare', workspaceId: 'ws'})
    expect(extensionName(block)).toBeUndefined()
  })
})
