import { describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { propertySchemasFacet } from '@/data/facets.ts'
import { actionsFacet, appMountsFacet, headerItemsFacet } from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  quickFindAction,
  quickFindHeaderItem,
  quickFindMount,
  quickFindPlugin,
} from '../index.ts'
import { recentBlockIdsProp } from '../recents.ts'

describe('quickFindPlugin', () => {
  it('contributes the quick find mount and action', () => {
    const runtime = resolveFacetRuntimeSync(quickFindPlugin)

    expect(runtime.read(appMountsFacet)).toEqual([quickFindMount])
    expect(runtime.read(propertySchemasFacet).get(recentBlockIdsProp.name)).toBe(recentBlockIdsProp)
    expect(recentBlockIdsProp.changeScope).toBe(ChangeScope.UserPrefs)
    expect(runtime.read(actionsFacet)).toEqual([quickFindAction])
    expect(runtime.read(headerItemsFacet)).toEqual([quickFindHeaderItem])
    expect(quickFindAction.defaultBinding?.keys).toEqual([
      'cmd+p',
      'ctrl+p',
      'cmd+shift+k',
      'ctrl+shift+k',
    ])
  })
})
