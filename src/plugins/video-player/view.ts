import {
  ChangeScope,
  codecs,
  defineProperty,
} from '@/data/api'

export type VideoPlayerView = 'default' | 'notes'
export const DEFAULT_VIDEO_NOTES_PANE_RATIO = 0.8

export const videoPlayerViewProp = defineProperty<VideoPlayerView>('video:playerView', {
  codec: codecs.enum(['default', 'notes']),
  defaultValue: 'default',
  changeScope: ChangeScope.UiState,
})

export const videoNotesPaneRatioProp = defineProperty<number>('video:notesPaneRatio', {
  codec: codecs.number,
  defaultValue: DEFAULT_VIDEO_NOTES_PANE_RATIO,
  changeScope: ChangeScope.UserPrefs,
})
