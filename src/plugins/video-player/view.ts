import {
  ChangeScope,
  CodecError,
  defineProperty,
  type Codec,
} from '@/data/api'

export type VideoPlayerView = 'default' | 'notes'

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
