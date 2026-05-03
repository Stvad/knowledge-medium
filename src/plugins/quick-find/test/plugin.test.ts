import { describe, expect, it } from 'vitest'
import { actionsFacet, appMountsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { quickFindAction, quickFindMount, quickFindPlugin } from '../index.ts'

describe('quickFindPlugin', () => {
  it('contributes the quick find mount and action', () => {
    const runtime = resolveFacetRuntimeSync(quickFindPlugin)

    expect(runtime.read(appMountsFacet)).toEqual([quickFindMount])
    expect(runtime.read(actionsFacet)).toEqual([quickFindAction])
    expect(quickFindAction.defaultBinding?.keys).toEqual([
      'cmd+p',
      'ctrl+p',
      'cmd+shift+k',
      'ctrl+shift+k',
    ])
  })
})
