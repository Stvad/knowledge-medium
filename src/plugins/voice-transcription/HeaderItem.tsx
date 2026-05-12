import { KeyRound, Mic } from 'lucide-react'
import {
  openVoiceTranscriptionSettings,
  startVoiceTranscription,
} from './events.ts'

export function VoiceTranscriptionHeaderItem() {
  return (
    <div className="inline-flex items-center gap-1">
      <button
        className="inline-flex h-8 items-center justify-center rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => openVoiceTranscriptionSettings()}
        title="OpenAI key settings"
        aria-label="OpenAI key settings"
      >
        <KeyRound className="h-4 w-4"/>
      </button>
      <button
        className="inline-flex h-8 items-center justify-center rounded-md px-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => startVoiceTranscription()}
        title="Start voice transcription"
        aria-label="Start voice transcription"
      >
        <Mic className="h-4 w-4"/>
      </button>
    </div>
  )
}
