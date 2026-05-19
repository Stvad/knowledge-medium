import { defineBlockType } from '@/data/api'
import { USER_PREFS_TYPE } from '@/data/userPrefs.ts'
import { typesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'

/** Type marker for the root user-prefs block. The block itself no longer
 *  carries plugin properties — each plugin owns a typed sub-block under
 *  this one (`getPluginPrefsBlock` in `globalState.ts`). This type exists
 *  so the property panel can label the parent row and so the type registry
 *  recognises the marker written by `ensureUserPrefsChild`. */
export const userPrefsType = defineBlockType({
  id: USER_PREFS_TYPE,
  label: 'User preferences',
})

export const userPrefsDataExtension: AppExtension = [
  typesFacet.of(userPrefsType, {source: 'user-prefs'}),
]
