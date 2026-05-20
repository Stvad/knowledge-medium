import { describe, expect, it } from 'vitest'
import { actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.ts'
import { mutatorsFacet, queriesFacet } from '@/data/facets.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
  FIND_REPLACE_SEARCH_CONTENT_QUERY,
  findReplaceAction,
  findReplaceDataExtension,
  findReplaceHeaderItem,
  findReplaceMount,
  findReplacePlugin,
} from '../index.ts'

describe('findReplacePlugin', () => {
  it('contributes the dialog, action, header item, query, and mutator', () => {
    const runtime = resolveFacetRuntimeSync(findReplacePlugin)

    expect(runtime.read(appMountsFacet)).toEqual([findReplaceMount])
    expect(runtime.read(actionsFacet)).toEqual([findReplaceAction])
    expect(runtime.read(headerItemsFacet)).toEqual([findReplaceHeaderItem])
    expect(runtime.read(queriesFacet).has(FIND_REPLACE_SEARCH_CONTENT_QUERY)).toBe(true)
    expect(runtime.read(mutatorsFacet).has(FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR)).toBe(true)
    expect(findReplaceAction.defaultBinding?.keys).toEqual(['cmd+shift+f', 'ctrl+shift+f'])
  })

  it('exposes data-layer contributions separately for repo bootstrap', () => {
    const runtime = resolveFacetRuntimeSync(findReplaceDataExtension)

    expect(runtime.read(appMountsFacet)).toEqual([])
    expect(runtime.read(queriesFacet).has(FIND_REPLACE_SEARCH_CONTENT_QUERY)).toBe(true)
    expect(runtime.read(mutatorsFacet).has(FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR)).toBe(true)
  })
})
