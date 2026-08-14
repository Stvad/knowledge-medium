import { describe, it, expect } from 'vitest'
import { isFocalRender } from '@/hooks/useIsFocalRender'
import { surfaceFromContext } from '@/plugins/spatial-navigation/surface'
import type { Block } from '@/data/block'
import type { BlockResolveContext } from '@/extensions/blockInteraction'
import type { BlockContextType } from '@/types'

const focalCtx = (blockContext: BlockContextType): BlockResolveContext => ({
  block: {id: 'b'} as Block,
  // these two stand-ins are unused by isFocalRender
  repo: {} as BlockResolveContext['repo'],
  uiStateBlock: {} as Block,
  types: [],
  isTopLevel: true,
  blockContext,
})

// Both surfaces set the umbrella `isNestedSurface`, so the focal-affordance
// machinery (force-open, hide-bullet, breadcrumbs header, backlinks footer)
// excludes them without a per-surface branch.
describe('reference / embed are focal-excluded nested surfaces', () => {
  it('a reference is never a focal render even when its id is the focal block', () => {
    expect(isFocalRender(focalCtx({isNestedSurface: true, isReference: true}))).toBe(false)
  })

  it('an embed is never a focal render even when its id is the focal block', () => {
    expect(isFocalRender(focalCtx({isNestedSurface: true, isEmbedded: true}))).toBe(false)
  })

  it('classifies a reference as a generic nested spatial surface', () => {
    expect(surfaceFromContext({isNestedSurface: true, isReference: true})).toBe('nested')
  })

  it('keeps an embed as the embedded spatial surface', () => {
    expect(surfaceFromContext({isNestedSurface: true, isEmbedded: true})).toBe('embedded')
  })
})
