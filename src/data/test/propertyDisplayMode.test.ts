import { describe, expect, it } from 'vitest'
import { nextBlockPropertyDisplaySetting, type PropertyDisplayLevels } from '../propertyDisplayMode'

const levels = (overrides: Partial<PropertyDisplayLevels> = {}): PropertyDisplayLevels => ({
  childBacked: true, workspace: 'inherit', panel: 'inherit', block: 'inherit', ...overrides,
})

describe('nextBlockPropertyDisplaySetting', () => {
  it.each([
    ['none', 'non-hidden'], ['non-hidden', 'all'], ['all', 'inherit'],
  ] as const)('cycles %s to %s', (block, next) => {
    expect(nextBlockPropertyDisplaySetting(levels({block}))).toBe(next)
  })

  it('collapses to an inherited non-hidden workspace mode', () => {
    expect(nextBlockPropertyDisplaySetting(levels({workspace: 'non-hidden', block: 'none'}))).toBe('inherit')
  })

  it('collapses to an inherited all panel mode over the workspace', () => {
    expect(nextBlockPropertyDisplaySetting(levels({workspace: 'none', panel: 'all', block: 'non-hidden'}))).toBe('inherit')
  })

  it('cycles the effective inherited mode', () => {
    expect(nextBlockPropertyDisplaySetting(levels({workspace: 'non-hidden'}))).toBe('all')
  })

  it('cycles an explicit block mode over its scope', () => {
    expect(nextBlockPropertyDisplaySetting(levels({workspace: 'all', block: 'none'}))).toBe('non-hidden')
  })
})
