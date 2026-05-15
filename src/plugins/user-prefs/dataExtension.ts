import { defineBlockType } from '@/data/api'
import { USER_PREFS_TYPE } from '@/data/userPrefs.ts'
import { typesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { dailyNoteBacklinksDefaultsProp } from '@/plugins/backlinks/dailyNoteDefaults.ts'
import { backlinksViewProp } from '@/plugins/backlinks-view/prop.ts'
import { groupedBacklinksDefaultsProp } from '@/plugins/grouped-backlinks/config.ts'
import { videoNotesPaneRatioProp } from '@/plugins/video-player/view.ts'

export const userPrefsType = defineBlockType({
  id: USER_PREFS_TYPE,
  label: 'User preferences',
  properties: [
    backlinksViewProp,
    dailyNoteBacklinksDefaultsProp,
    groupedBacklinksDefaultsProp,
    videoNotesPaneRatioProp,
  ],
})

export const userPrefsDataExtension: AppExtension = [
  typesFacet.of(userPrefsType, {source: 'user-prefs'}),
]
