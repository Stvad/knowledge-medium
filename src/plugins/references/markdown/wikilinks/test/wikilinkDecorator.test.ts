// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  resolveWikilinkDisplay,
  wikilinkDisplayDecoratorFacet,
  type WikilinkDisplayContext,
  type WikilinkDisplayDecorator,
} from '../wikilinkDecorator.ts'

const ctx = (alias: string): WikilinkDisplayContext =>
  ({alias, blockId: 'b', workspaceId: 'ws'})

const stub = (
  id: string,
  decorate: WikilinkDisplayDecorator['decorate'],
): WikilinkDisplayDecorator => ({id, decorate})

describe('wikilinkDisplayDecoratorFacet', () => {
  it('returns null when no decorators are registered', () => {
    const runtime = resolveFacetRuntimeSync([])
    expect(resolveWikilinkDisplay(runtime, ctx('whatever'))).toBeNull()
  })

  it('returns the first non-null decorator result', () => {
    const runtime = resolveFacetRuntimeSync([
      wikilinkDisplayDecoratorFacet.of(stub('a', () => null), {source: 'a'}),
      wikilinkDisplayDecoratorFacet.of(stub('b', ({alias}) => `B:${alias}`), {source: 'b'}),
      wikilinkDisplayDecoratorFacet.of(stub('c', ({alias}) => `C:${alias}`), {source: 'c'}),
    ])
    expect(resolveWikilinkDisplay(runtime, ctx('x'))).toBe('B:x')
  })

  it('falls through every decorator when all return null', () => {
    const runtime = resolveFacetRuntimeSync([
      wikilinkDisplayDecoratorFacet.of(stub('a', () => null), {source: 'a'}),
      wikilinkDisplayDecoratorFacet.of(stub('b', () => null), {source: 'b'}),
    ])
    expect(resolveWikilinkDisplay(runtime, ctx('x'))).toBeNull()
  })

  it('respects precedence — lower precedence decorator wins', () => {
    const runtime = resolveFacetRuntimeSync([
      wikilinkDisplayDecoratorFacet.of(stub('late', () => 'late'), {source: 'late'}),
      wikilinkDisplayDecoratorFacet.of(stub('early', () => 'early'), {source: 'early', precedence: -1}),
    ])
    expect(resolveWikilinkDisplay(runtime, ctx('x'))).toBe('early')
  })

  it('passes full context (alias, blockId, workspaceId) to decorators', () => {
    let received: WikilinkDisplayContext | null = null
    const runtime = resolveFacetRuntimeSync([
      wikilinkDisplayDecoratorFacet.of(
        stub('capture', context => { received = context; return 'ok' }),
        {source: 'capture'},
      ),
    ])
    resolveWikilinkDisplay(runtime, {alias: 'A', blockId: 'B', workspaceId: 'W'})
    expect(received).toEqual({alias: 'A', blockId: 'B', workspaceId: 'W'})
  })
})
