import {
  ChangeScope,
  CodecError,
  codecs,
  defineProperty,
  type Codec,
} from '@/data/api'

export type VideoPlayerView = 'default' | 'notes'
export const DEFAULT_VIDEO_NOTES_PANE_RATIO = 0.8

const videoPlayerViewCodec: Codec<VideoPlayerView> = {
  encode: value => value,
  decode: value => {
    if (value === 'default' || value === 'notes') return value
    throw new CodecError('video player view', value)
  },
}

export const videoPlayerViewProp = defineProperty<VideoPlayerView>('video:playerView', {
  codec: videoPlayerViewCodec,
  defaultValue: 'default',
  changeScope: ChangeScope.UiState,
  kind: 'string',
})

export const videoNotesPaneRatioProp = defineProperty<number>('video:notesPaneRatio', {
  codec: codecs.number,
  defaultValue: DEFAULT_VIDEO_NOTES_PANE_RATIO,
  changeScope: ChangeScope.UserPrefs,
  kind: 'number',
})
