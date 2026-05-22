import { describe, expect, it } from 'vitest'
import { headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { accountHeaderItem, accountHeaderPlugin } from '../index.ts'

describe('accountHeaderPlugin', () => {
  it('contributes the account header item', () => {
    const runtime = resolveFacetRuntimeSync(accountHeaderPlugin)

    expect(runtime.read(headerItemsFacet)).toEqual([accountHeaderItem])
  })
})
