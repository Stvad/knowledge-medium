import {
  ChangeScope,
  CodecError,
  codecs,
  defineBlockType,
  defineProperty,
  type Codec,
} from '@/data/api'

export const VOICE_TRANSCRIPT_TYPE = 'voice-transcript'
export const TRANSCRIPT_SEGMENT_TYPE = 'voice-transcript-segment'

export type VoiceTranscriptionStatus =
  | 'idle'
  | 'recording'
  | 'complete'
  | 'error'

const literalCodec = <T extends string>(
  expected: readonly T[],
  label: string,
): Codec<T> => ({
  type: 'string',
  encode: value => {
    if (!expected.includes(value)) throw new CodecError(label, value)
    return value
  },
  decode: json => {
    if (typeof json !== 'string' || !expected.includes(json as T)) {
      throw new CodecError(label, json)
    }
    return json as T
  },
  where: {
    encode: value => {
      if (typeof value !== 'string' || !expected.includes(value as T)) {
        throw new CodecError(label, value)
      }
      return value
    },
  },
})

export const transcriptStatusProp = defineProperty<VoiceTranscriptionStatus>('voice-transcription:status', {
  codec: literalCodec<VoiceTranscriptionStatus>(
    ['idle', 'recording', 'complete', 'error'],
    'voice transcription status',
  ),
  defaultValue: 'idle',
  changeScope: ChangeScope.BlockDefault,
})

export const transcriptStartedAtProp = defineProperty<number | undefined>('voice-transcription:started-at', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const transcriptEndedAtProp = defineProperty<number | undefined>('voice-transcription:ended-at', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const transcriptAudioUrlProp = defineProperty<string | undefined>('voice-transcription:audio-url', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const transcriptErrorProp = defineProperty<string | undefined>('voice-transcription:error', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const transcriptSegmentStartMsProp = defineProperty<number | undefined>('voice-transcription:segment-start-ms', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const transcriptSegmentEndMsProp = defineProperty<number | undefined>('voice-transcription:segment-end-ms', {
  codec: codecs.optionalNumber,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const transcriptSegmentItemIdProp = defineProperty<string | undefined>('voice-transcription:item-id', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const voiceTranscriptType = defineBlockType({
  id: VOICE_TRANSCRIPT_TYPE,
  label: 'Voice transcript',
  properties: [
    transcriptStatusProp,
    transcriptStartedAtProp,
    transcriptEndedAtProp,
    transcriptAudioUrlProp,
    transcriptErrorProp,
  ],
})

export const transcriptSegmentType = defineBlockType({
  id: TRANSCRIPT_SEGMENT_TYPE,
  label: 'Transcript segment',
  properties: [
    transcriptSegmentStartMsProp,
    transcriptSegmentEndMsProp,
    transcriptSegmentItemIdProp,
  ],
})

export const voiceTranscriptionPropertySchemas = [
  transcriptStatusProp,
  transcriptStartedAtProp,
  transcriptEndedAtProp,
  transcriptAudioUrlProp,
  transcriptErrorProp,
  transcriptSegmentStartMsProp,
  transcriptSegmentEndMsProp,
  transcriptSegmentItemIdProp,
] as const

export const voiceTranscriptionTypes = [
  voiceTranscriptType,
  transcriptSegmentType,
] as const
