import { describe, expect, it } from 'vitest'
import {
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
} from '@/extensions/core.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  configureVoiceTranscriptionAction,
  startVoiceTranscriptionAction,
  stopVoiceTranscriptionAction,
  voiceTranscriptionHeaderItem,
  voiceTranscriptionPlugin,
  voiceTranscriptionRecorderMount,
} from '../index.ts'

describe('voiceTranscriptionPlugin', () => {
  it('contributes recording UI and command palette actions', () => {
    const runtime = resolveFacetRuntimeSync(voiceTranscriptionPlugin)

    expect(runtime.read(appMountsFacet)).toEqual([voiceTranscriptionRecorderMount])
    expect(runtime.read(headerItemsFacet)).toEqual([voiceTranscriptionHeaderItem])
    expect(runtime.read(actionsFacet)).toEqual([
      startVoiceTranscriptionAction,
      stopVoiceTranscriptionAction,
      configureVoiceTranscriptionAction,
    ])
  })
})
