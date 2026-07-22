import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import {
  blockBulletHoverFacet,
  type BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import { blockInfoPlugin } from '../index.ts'
import { BlockMetaCard } from '../BlockMetaCard.tsx'

describe('blockInfoPlugin', () => {
  it('contributes one bullet-hover section', () => {
    const runtime = resolveFacetRuntimeSync(blockInfoPlugin)
    expect(runtime.contributions(blockBulletHoverFacet)).toHaveLength(1)
  })

  it('resolves the metadata card as the sole bullet-hover section', () => {
    const runtime = resolveFacetRuntimeSync(blockInfoPlugin)
    // The contribution ignores context, so a bare stub is sufficient here.
    const sections = runtime.read(blockBulletHoverFacet)({} as BlockResolveContext)
    expect(sections).toEqual([BlockMetaCard])
  })
})
