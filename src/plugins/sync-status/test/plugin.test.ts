import { describe, expect, it } from 'vitest'
import { headerItemsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import {
  syncStatusHeaderItem,
  syncStatusPlugin,
} from '../index.ts'

describe('syncStatusPlugin', () => {
  it('contributes the sync status header item', () => {
    const runtime = resolveFacetRuntimeSync(syncStatusPlugin)

    expect(runtime.read(headerItemsFacet)).toEqual([syncStatusHeaderItem])
  })
})
