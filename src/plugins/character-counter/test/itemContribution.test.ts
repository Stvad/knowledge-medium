import { describe, expect, it } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import { characterCountItemContribution } from '../CharacterCountItem'

// The contribution is globally available so child blocks can inspect their
// parent counter config at render time.
const ctxWithTypes = (types: string[]): BlockResolveContext =>
  ({types} as unknown as BlockResolveContext)

describe('characterCountItemContribution', () => {
  it('contributes one bottom-right item for every block, whatever its types', () => {
    const plain = characterCountItemContribution(ctxWithTypes([]))
    expect(plain).toEqual(expect.objectContaining({corner: 'bottom-right'}))
    expect(characterCountItemContribution(ctxWithTypes(['page']))).toBe(plain)
  })
})
