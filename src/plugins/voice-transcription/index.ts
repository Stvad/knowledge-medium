import {
  actionsFacet,
  appMountsFacet,
  blockRenderersFacet,
  headerItemsFacet,
  type AppMountContribution,
  type HeaderItemContribution,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { propertySchemasFacet, typesFacet } from '@/data/facets.ts'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { VoiceTranscriptionHeaderItem } from './HeaderItem.tsx'
import { VoiceTranscriptionRecorder } from './Recorder.tsx'
import {
  TranscriptSegmentRenderer,
  VoiceTranscriptRenderer,
} from './TranscriptRenderer.tsx'
import { startVoiceTranscription, stopVoiceTranscription } from './events.ts'
import {
  voiceTranscriptionPropertySchemas,
  voiceTranscriptionTypes,
} from './schema.ts'
import { transcriptSegmentCodeMirrorExtensions } from './split.ts'

export const voiceTranscriptionHeaderItem: HeaderItemContribution = {
  id: 'voice-transcription.header',
  region: 'end',
  component: VoiceTranscriptionHeaderItem,
}

export const voiceTranscriptionRecorderMount: AppMountContribution = {
  id: 'voice-transcription.recorder',
  component: VoiceTranscriptionRecorder,
}

export const startVoiceTranscriptionAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'voice_transcription.start',
  description: 'Start voice transcription',
  context: ActionContextTypes.GLOBAL,
  handler: () => startVoiceTranscription(),
  defaultBinding: {
    keys: ['cmd+shift+r', 'ctrl+shift+r'],
  },
}

export const stopVoiceTranscriptionAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'voice_transcription.stop',
  description: 'Stop voice transcription',
  context: ActionContextTypes.GLOBAL,
  handler: () => stopVoiceTranscription(),
}

export const voiceTranscriptionPlugin: AppExtension = [
  voiceTranscriptionPropertySchemas.map(schema =>
    propertySchemasFacet.of(schema, {source: 'voice-transcription'}),
  ),
  voiceTranscriptionTypes.map(type =>
    typesFacet.of(type, {source: 'voice-transcription'}),
  ),
  blockRenderersFacet.of({
    id: 'voice-transcript',
    renderer: VoiceTranscriptRenderer,
  }, {source: 'voice-transcription'}),
  blockRenderersFacet.of({
    id: 'voice-transcript-segment',
    renderer: TranscriptSegmentRenderer,
  }, {source: 'voice-transcription'}),
  codeMirrorExtensionsFacet.of(transcriptSegmentCodeMirrorExtensions, {source: 'voice-transcription'}),
  appMountsFacet.of(voiceTranscriptionRecorderMount, {source: 'voice-transcription'}),
  headerItemsFacet.of(voiceTranscriptionHeaderItem, {
    source: 'voice-transcription',
    precedence: 11,
  }),
  actionsFacet.of(startVoiceTranscriptionAction, {source: 'voice-transcription'}),
  actionsFacet.of(stopVoiceTranscriptionAction, {source: 'voice-transcription'}),
]

export {
  startVoiceTranscription,
  stopVoiceTranscription,
} from './events.ts'
export {
  OPENAI_REALTIME_WHISPER_MODEL,
  formatTranscriptTime,
  formatTranscriptTimeRange,
} from './model.ts'
