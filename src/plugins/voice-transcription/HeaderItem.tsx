import { Mic } from 'lucide-react'
import { startVoiceTranscription } from './events.ts'

export function VoiceTranscriptionHeaderItem() {
  return (
    <button
      className="inline-flex h-8 items-center justify-center rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      onClick={() => startVoiceTranscription()}
      title="Start voice transcription"
      aria-label="Start voice transcription"
    >
      <Mic className="h-4 w-4"/>
    </button>
  )
}
