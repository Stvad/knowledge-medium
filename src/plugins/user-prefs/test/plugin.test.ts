// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { typesFacet } from '@/data/facets.ts'
import { USER_PREFS_TYPE } from '@/data/userPrefs.ts'
import { dailyNoteBacklinksDefaultsProp } from '@/plugins/backlinks/dailyNoteDefaults.ts'
import { backlinksViewProp } from '@/plugins/backlinks-view/prop.ts'
import { blockTagsConfigProp } from '@/plugins/block-tagging/config.ts'
import { groupedBacklinksDefaultsProp } from '@/plugins/grouped-backlinks/config.ts'
import { videoNotesPaneRatioProp } from '@/plugins/video-player/view.ts'
import { userPrefsDataExtension, userPrefsType } from '../dataExtension.ts'

describe('userPrefsDataExtension', () => {
  it('contributes the user-prefs type with user-facing preference rows', () => {
    const runtime = resolveFacetRuntimeSync(userPrefsDataExtension)
    const types = runtime.read(typesFacet)

    expect(types.get(USER_PREFS_TYPE)).toBe(userPrefsType)
    expect(userPrefsType.properties).toEqual([
      backlinksViewProp,
      dailyNoteBacklinksDefaultsProp,
      blockTagsConfigProp,
      groupedBacklinksDefaultsProp,
      videoNotesPaneRatioProp,
    ])
  })
})
