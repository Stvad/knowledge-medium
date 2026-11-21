import {
  ChangeScope,
  seedProperty,
} from '@/data/api'

/** The pane view mode (`panelViewModeProp` / the `;view=` URL key) under
 *  which the video-notes renderer is selected. The old per-BLOCK
 *  `video:playerView` property is retired — stale values on blocks are
 *  dead data and deliberately ignored (no migration). */
export const VIDEO_NOTES_VIEW_MODE = 'video-notes'

export const DEFAULT_VIDEO_NOTES_PANE_RATIO = 0.8

export const videoNotesPaneRatioProp = seedProperty({
  seedKey: 'system:video-player/property/notes-pane-ratio',
  revision: 1,
  name: 'video:notesPaneRatio',
  preset: 'number',
  defaultValue: DEFAULT_VIDEO_NOTES_PANE_RATIO,
  changeScope: ChangeScope.UserPrefs,
})
