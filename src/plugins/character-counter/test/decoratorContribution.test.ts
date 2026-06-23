import { describe, expect, it } from 'vitest'
import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { CHAR_COUNTER_TYPE } from '../blockType'
import { characterCountDecoratorContribution } from '../CharacterCountDecorator'

// The contribution only reads `ctx.types`, so a types-only partial is a
// faithful stand-in for the full resolve context here.
const ctxWithTypes = (types: string[]): BlockResolveContext =>
  ({types} as unknown as BlockResolveContext)

const innerStub = (): BlockRenderer => () => null

describe('characterCountDecoratorContribution', () => {
  it('skips blocks without the char-counter type', () => {
    expect(characterCountDecoratorContribution(ctxWithTypes([]))).toBeNull()
    expect(characterCountDecoratorContribution(ctxWithTypes(['place']))).toBeNull()
  })

  it('decorates blocks tagged char-counter', () => {
    const decorate = characterCountDecoratorContribution(ctxWithTypes([CHAR_COUNTER_TYPE]))
    expect(typeof decorate).toBe('function')
  })

  it('returns a stable wrapped renderer per inner renderer, distinct across inners', () => {
    const decorate = characterCountDecoratorContribution(ctxWithTypes([CHAR_COUNTER_TYPE]))
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
