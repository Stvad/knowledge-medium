export const startVoiceTranscriptionEvent = 'voice-transcription:start'
export const stopVoiceTranscriptionEvent = 'voice-transcription:stop'

export const startVoiceTranscription = (): void => {
  window.dispatchEvent(new CustomEvent(startVoiceTranscriptionEvent))
}

export const stopVoiceTranscription = (): void => {
  window.dispatchEvent(new CustomEvent(stopVoiceTranscriptionEvent))
}
