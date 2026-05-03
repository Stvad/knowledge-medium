import { describe, expect, it } from 'vitest'
import { headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { themeToggleHeaderItem, themeTogglePlugin } from '../index.ts'

describe('themeTogglePlugin', () => {
  it('contributes the theme toggle header item', () => {
    const runtime = resolveFacetRuntimeSync(themeTogglePlugin)

    expect(runtime.read(headerItemsFacet)).toEqual([themeToggleHeaderItem])
  })
})
