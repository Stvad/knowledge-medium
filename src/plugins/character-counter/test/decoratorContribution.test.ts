import { describe, expect, it } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { characterCountDecoratorContribution } from '../CharacterCountDecorator'

// The contribution is globally available so child blocks can inspect their
// parent counter config at render time.
const ctxWithTypes = (types: string[]): BlockResolveContext =>
  ({types} as unknown as BlockResolveContext)

const innerStub = (): BlockRenderer => () => null

describe('characterCountDecoratorContribution', () => {
  it('contributes a decorator for all blocks', () => {
    const decorate = characterCountDecoratorContribution(ctxWithTypes([]))
    expect(typeof decorate).toBe('function')
  })

  it('returns a stable wrapped renderer per inner renderer, distinct across inners', () => {
    const decorate = characterCountDecoratorContribution(ctxWithTypes([]))
    if (typeof decorate !== 'function') throw new Error('expected a decorator')
    const innerA = innerStub()
    const innerB = innerStub()
    // Memoised per inner: same inner → same component identity (so React
    // never unmounts the inner subtree on a parent re-render).
    expect(decorate(innerA)).toBe(decorate(innerA))
    // Different inner → different wrapper.
    expect(decorate(innerA)).not.toBe(decorate(innerB))
  })
})
