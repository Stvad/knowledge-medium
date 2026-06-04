import { describe, expect, it } from 'vitest'
import { appMountsFacet } from '@/extensions/core.js'
import { mutatorsFacet, queriesFacet } from '@/data/facets.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import {
  FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
  FIND_REPLACE_SEARCH_CONTENT_QUERY,
  findReplaceDataExtension,
} from '../index.ts'

describe('findReplacePlugin', () => {
  it('exposes data-layer contributions separately for repo bootstrap (no UI mount)', () => {
    const runtime = resolveFacetRuntimeSync(findReplaceDataExtension)

    expect(runtime.read(appMountsFacet)).toEqual([])
    expect(runtime.read(queriesFacet).has(FIND_REPLACE_SEARCH_CONTENT_QUERY)).toBe(true)
    expect(runtime.read(mutatorsFacet).has(FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR)).toBe(true)
  })
})
