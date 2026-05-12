export const startVoiceTranscriptionEvent = 'voice-transcription:start'
export const stopVoiceTranscriptionEvent = 'voice-transcription:stop'
export const openVoiceTranscriptionSettingsEvent = 'voice-transcription:open-settings'

export const startVoiceTranscription = (): void => {
  window.dispatchEvent(new CustomEvent(startVoiceTranscriptionEvent))
}

export const stopVoiceTranscription = (): void => {
  window.dispatchEvent(new CustomEvent(stopVoiceTranscriptionEvent))
}

export const openVoiceTranscriptionSettings = (): void => {
  window.dispatchEvent(new CustomEvent(openVoiceTranscriptionSettingsEvent))
}
