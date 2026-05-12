import { addBlockTypeToProperties } from '@/data/properties.ts'
import {
  TRANSCRIPT_SEGMENT_TYPE,
  VOICE_TRANSCRIPT_TYPE,
  transcriptEndedAtProp,
  transcriptErrorProp,
  transcriptSegmentEndMsProp,
  transcriptSegmentItemIdProp,
  transcriptSegmentStartMsProp,
  transcriptStartedAtProp,
  transcriptStatusProp,
  type VoiceTranscriptionStatus,
} from './schema.ts'
import type { TranscriptSegment } from './model.ts'

export const createTranscriptBlockProperties = (
  status: VoiceTranscriptionStatus,
  startedAt: number,
): Record<string, unknown> => {
  const properties = addBlockTypeToProperties({}, VOICE_TRANSCRIPT_TYPE)
  properties[transcriptStatusProp.name] = transcriptStatusProp.codec.encode(status)
  properties[transcriptStartedAtProp.name] = transcriptStartedAtProp.codec.encode(startedAt)
  return properties
}

export const transcriptStatusPatch = (
  properties: Record<string, unknown>,
  status: VoiceTranscriptionStatus,
  endedAt?: number,
  error?: string,
): Record<string, unknown> => ({
  ...properties,
  [transcriptStatusProp.name]: transcriptStatusProp.codec.encode(status),
  [transcriptEndedAtProp.name]: transcriptEndedAtProp.codec.encode(endedAt),
  [transcriptErrorProp.name]: transcriptErrorProp.codec.encode(error),
})

export const createTranscriptSegmentProperties = (
  segment: TranscriptSegment,
): Record<string, unknown> => {
  const properties = addBlockTypeToProperties({}, TRANSCRIPT_SEGMENT_TYPE)
  properties[transcriptSegmentStartMsProp.name] = transcriptSegmentStartMsProp.codec.encode(segment.startMs)
  properties[transcriptSegmentEndMsProp.name] = transcriptSegmentEndMsProp.codec.encode(segment.endMs)
  properties[transcriptSegmentItemIdProp.name] = transcriptSegmentItemIdProp.codec.encode(segment.itemId)
  return properties
}

export const transcriptSegmentTimingPatch = (
  properties: Record<string, unknown>,
  startMs: number,
  endMs: number,
): Record<string, unknown> => ({
  ...properties,
  [transcriptSegmentStartMsProp.name]: transcriptSegmentStartMsProp.codec.encode(startMs),
  [transcriptSegmentEndMsProp.name]: transcriptSegmentEndMsProp.codec.encode(endMs),
})
