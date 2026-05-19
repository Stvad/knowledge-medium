// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { typesFacet } from '@/data/facets.ts'
import { USER_PREFS_TYPE } from '@/data/userPrefs.ts'
import { userPrefsDataExtension, userPrefsType } from '../dataExtension.ts'

describe('userPrefsDataExtension', () => {
  it('registers the root user-prefs type as a labelled container with no plugin-owned properties', () => {
    // Plugin preferences each live on their own typed sub-block under the
    // root user-prefs block, so the root carries only the type marker —
    // no `properties` here. See `getPluginPrefsBlock` in globalState.ts.
    const runtime = resolveFacetRuntimeSync(userPrefsDataExtension)
    const types = runtime.read(typesFacet)

    expect(types.get(USER_PREFS_TYPE)).toBe(userPrefsType)
    expect(userPrefsType.properties).toBeUndefined()
  })
})
