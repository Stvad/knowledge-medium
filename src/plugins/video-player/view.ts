import {
  ChangeScope,
  seedProperty,
} from '@/data/api'

export type VideoPlayerView = 'default' | 'notes'
export const DEFAULT_VIDEO_NOTES_PANE_RATIO = 0.8

export const videoPlayerViewProp = seedProperty<VideoPlayerView>({
  seedKey: 'system:video-player/property/player-view',
  revision: 1,
  name: 'video:playerView',
  preset: 'strict-enum',
  config: {options: [
    {value: 'default', label: 'default'},
    {value: 'notes', label: 'notes'},
  ]},
  defaultValue: 'default',
  changeScope: ChangeScope.UiState,
})

export const videoNotesPaneRatioProp = seedProperty({
  seedKey: 'system:video-player/property/notes-pane-ratio',
  revision: 1,
  name: 'video:notesPaneRatio',
  preset: 'number',
  defaultValue: DEFAULT_VIDEO_NOTES_PANE_RATIO,
  changeScope: ChangeScope.UserPrefs,
})
