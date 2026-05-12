import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Mic, Square } from 'lucide-react'
import { ChangeScope } from '@/data/api'
import { useRepo } from '@/context/repo.tsx'
import { useRootUIStateBlock } from '@/data/globalState.ts'
import {
  focusedBlockIdProp,
  setFocusedBlockId,
  topLevelBlockIdProp,
} from '@/data/properties.ts'
import { Button } from '@/components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx'
import { Input } from '@/components/ui/input.tsx'
import {
  createTranscriptBlockProperties,
  createTranscriptSegmentProperties,
  transcriptStatusPatch,
} from './blocks.ts'
import {
  openVoiceTranscriptionSettingsEvent,
  startVoiceTranscriptionEvent,
  stopVoiceTranscription,
  stopVoiceTranscriptionEvent,
} from './events.ts'
import {
  startRealtimeTranscription,
  type RealtimeTranscriptionSession,
} from './realtime.ts'
import type { TranscriptSegment } from './model.ts'
import { transcriptAudioUrlProp } from './schema.ts'
import {
  clearOpenAiApiKey,
  hasStoredOpenAiApiKey,
  saveOpenAiApiKey,
} from './credentials.ts'
import { useActivePanelNodeTarget } from '@/plugins/left-sidebar/panelTarget.tsx'

type RecorderStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'error'

interface RecorderState {
  status: RecorderStatus
  transcriptBlockId: string | null
  draftText: string
  error: string | null
}

const initialState: RecorderState = {
  status: 'idle',
  transcriptBlockId: null,
  draftText: '',
  error: null,
}

const titleForRecording = (startedAt: number): string =>
  `Voice transcript ${new Date(startedAt).toLocaleString()}`

const blockIdFromActiveElement = (): string | null => {
  if (typeof document === 'undefined') return null
  const element = document.activeElement
  if (!(element instanceof HTMLElement)) return null
  return element.closest<HTMLElement>('[data-block-id]')?.dataset.blockId ?? null
}

export function VoiceTranscriptionRecorder() {
  const repo = useRepo()
  const uiStateBlock = useRootUIStateBlock()
  const {
    activePanelBlock,
    activeTopLevelBlockId,
  } = useActivePanelNodeTarget()
  const sessionRef = useRef<RealtimeTranscriptionSession | null>(null)
  const transcriptBlockIdRef = useRef<string | null>(null)
  const pendingStartRef = useRef(false)
  const [state, setState] = useState<RecorderState>(initialState)
  const [keyDialogOpen, setKeyDialogOpen] = useState(false)
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [keyMessage, setKeyMessage] = useState<string | null>(null)
  const [storedKeyAvailable, setStoredKeyAvailable] = useState(() => hasStoredOpenAiApiKey())

  const resolveRecordingTarget = useCallback(() => {
    const activeElementBlockId = blockIdFromActiveElement()
    if (activeElementBlockId) {
      return {
        parentId: activeElementBlockId,
        uiStateBlock: activePanelBlock ?? uiStateBlock,
      }
    }

    const panelFocusedBlockId = activePanelBlock?.peekProperty(focusedBlockIdProp)
    if (panelFocusedBlockId && activePanelBlock) {
      return {
        parentId: panelFocusedBlockId,
        uiStateBlock: activePanelBlock,
      }
    }

    const rootFocusedBlockId = uiStateBlock.peekProperty(focusedBlockIdProp)
    if (rootFocusedBlockId) {
      return {
        parentId: rootFocusedBlockId,
        uiStateBlock,
      }
    }

    if (activeTopLevelBlockId) {
      return {
        parentId: activeTopLevelBlockId,
        uiStateBlock: activePanelBlock ?? uiStateBlock,
      }
    }

    const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
    if (topLevelBlockId) {
      return {
        parentId: topLevelBlockId,
        uiStateBlock,
      }
    }

    return null
  }, [activePanelBlock, activeTopLevelBlockId, uiStateBlock])

  const setTranscriptStatus = useCallback(async (
    transcriptBlockId: string,
    status: 'complete' | 'error',
    error?: string,
  ) => {
    const block = repo.block(transcriptBlockId)
    const data = block.peek() ?? await block.load()
    if (!data) return

    await repo.tx(async tx => {
      const current = await tx.get(transcriptBlockId)
      if (!current) return
      await tx.update(transcriptBlockId, {
        properties: transcriptStatusPatch(
          current.properties,
          status,
          Date.now(),
          error,
        ),
      })
    }, {
      scope: ChangeScope.BlockDefault,
      description: `mark voice transcription ${status}`,
    })
  }, [repo])

  const appendSegment = useCallback(async (
    transcriptBlockId: string,
    segment: TranscriptSegment,
  ) => {
    await repo.mutate.createChild({
      parentId: transcriptBlockId,
      content: segment.text,
      properties: createTranscriptSegmentProperties(segment),
    })
  }, [repo])

  const stopRecording = useCallback(async () => {
    const session = sessionRef.current
    sessionRef.current = null
    session?.stop()

    const transcriptBlockId = transcriptBlockIdRef.current
    transcriptBlockIdRef.current = null

    if (transcriptBlockId) {
      await setTranscriptStatus(transcriptBlockId, 'complete')
    }

    setState(initialState)
  }, [setTranscriptStatus])

  const failRecording = useCallback(async (
    transcriptBlockId: string | null,
    error: Error,
  ) => {
    sessionRef.current?.stop()
    sessionRef.current = null
    transcriptBlockIdRef.current = null

    if (transcriptBlockId) {
      await setTranscriptStatus(transcriptBlockId, 'error', error.message)
    }

    setState({
      status: 'error',
      transcriptBlockId,
      draftText: '',
      error: error.message,
    })
  }, [setTranscriptStatus])

  const startRecording = useCallback(async () => {
    if (state.status === 'starting' || state.status === 'recording') return
    if (!hasStoredOpenAiApiKey()) {
      pendingStartRef.current = true
      setStoredKeyAvailable(false)
      setKeyMessage(null)
      setKeyDialogOpen(true)
      return
    }
    if (repo.isReadOnly) {
      setState({
        status: 'error',
        transcriptBlockId: null,
        draftText: '',
        error: 'Workspace is read-only',
      })
      return
    }

    const recordingTarget = resolveRecordingTarget()
    if (!recordingTarget) {
      setState({
        status: 'error',
        transcriptBlockId: null,
        draftText: '',
        error: 'No active view to attach the transcript to',
      })
      return
    }

    const startedAt = Date.now()
    setState({
      status: 'starting',
      transcriptBlockId: null,
      draftText: '',
      error: null,
    })

    let transcriptBlockId: string | null = null
    try {
      transcriptBlockId = await repo.mutate.createChild({
        parentId: recordingTarget.parentId,
        content: titleForRecording(startedAt),
        properties: createTranscriptBlockProperties('recording', startedAt),
      })
      transcriptBlockIdRef.current = transcriptBlockId
      setFocusedBlockId(recordingTarget.uiStateBlock, transcriptBlockId)
      setState({
        status: 'starting',
        transcriptBlockId,
        draftText: '',
        error: null,
      })

      const session = await startRealtimeTranscription({
        onOpen: () => {
          setState(current => ({
            ...current,
            status: 'recording',
          }))
        },
        onDelta: draft => {
          setState(current => ({
            ...current,
            draftText: draft.text,
          }))
        },
        onSegment: segment => {
          const currentTranscriptBlockId = transcriptBlockIdRef.current
          if (!currentTranscriptBlockId) return
          void appendSegment(currentTranscriptBlockId, segment)
            .then(() => {
              setState(current => ({
                ...current,
                draftText: '',
              }))
            })
            .catch(error => {
              console.error('[voice-transcription] Failed to append transcript segment', error)
            })
        },
        onAudioUrl: audioUrl => {
          const currentTranscriptBlockId = transcriptBlockIdRef.current ?? transcriptBlockId
          if (!currentTranscriptBlockId) return
          void repo.block(currentTranscriptBlockId).set(transcriptAudioUrlProp, audioUrl)
            .catch(error => {
              console.error('[voice-transcription] Failed to attach transcript audio URL', error)
            })
        },
        onError: error => {
          const currentTranscriptBlockId = transcriptBlockIdRef.current
          void failRecording(currentTranscriptBlockId, error)
        },
      })

      sessionRef.current = session
    } catch (error) {
      await failRecording(transcriptBlockId, error instanceof Error ? error : new Error(String(error)))
    }
  }, [
    appendSegment,
    failRecording,
    repo,
    resolveRecordingTarget,
    state.status,
  ])

  useEffect(() => {
    const handleStart = () => {
      void startRecording()
    }
    const handleStop = () => {
      void stopRecording()
    }
    const handleOpenSettings = () => {
      pendingStartRef.current = false
      setStoredKeyAvailable(hasStoredOpenAiApiKey())
      setKeyMessage(null)
      setKeyDialogOpen(true)
    }

    window.addEventListener(openVoiceTranscriptionSettingsEvent, handleOpenSettings)
    window.addEventListener(startVoiceTranscriptionEvent, handleStart)
    window.addEventListener(stopVoiceTranscriptionEvent, handleStop)
    return () => {
      window.removeEventListener(openVoiceTranscriptionSettingsEvent, handleOpenSettings)
      window.removeEventListener(startVoiceTranscriptionEvent, handleStart)
      window.removeEventListener(stopVoiceTranscriptionEvent, handleStop)
      sessionRef.current?.stop()
    }
  }, [startRecording, stopRecording])

  const saveKey = () => {
    try {
      saveOpenAiApiKey(apiKeyInput)
      setApiKeyInput('')
      setKeyMessage(null)
      setKeyDialogOpen(false)
      setStoredKeyAvailable(true)
      if (pendingStartRef.current) {
        pendingStartRef.current = false
        void startRecording()
      }
    } catch (error) {
      setKeyMessage(error instanceof Error ? error.message : String(error))
    }
  }

  const clearKey = () => {
    clearOpenAiApiKey()
    setApiKeyInput('')
    setStoredKeyAvailable(false)
    setKeyMessage('Stored OpenAI key cleared.')
  }

  const busy = state.status === 'starting'
  const recording = state.status === 'recording'

  return (
    <>
      <Dialog
        open={keyDialogOpen}
        onOpenChange={open => {
          if (open) setStoredKeyAvailable(hasStoredOpenAiApiKey())
          setKeyDialogOpen(open)
          if (!open) {
            pendingStartRef.current = false
            setApiKeyInput('')
            setKeyMessage(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>OpenAI key</DialogTitle>
            <DialogDescription>
              In the OpenAI key editor, use Restricted with Write for Realtime
              client secrets (<code>/v1/realtime/client_secrets</code>) and
              None for everything else. Stored in this browser; any app code
              running here can read it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              type="password"
              autoComplete="off"
              placeholder={storedKeyAvailable ? 'Stored key is set' : 'sk-...'}
              value={apiKeyInput}
              onChange={event => setApiKeyInput(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') saveKey()
              }}
            />
            {keyMessage && (
              <div className="text-xs text-muted-foreground">
                {keyMessage}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={clearKey}
            >
              Clear
            </Button>
            <Button
              type="button"
              onClick={saveKey}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {state.status !== 'idle' && (
        <div className="fixed bottom-3 left-1/2 z-50 flex w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-background p-3 text-sm shadow-lg">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            {busy ? <Loader2 className="h-4 w-4 animate-spin"/> : <Mic className="h-4 w-4"/>}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">
              {state.error ?? (recording ? 'Recording transcript' : 'Starting transcript')}
            </div>
            {state.draftText && (
              <div className="truncate text-xs text-muted-foreground">
                {state.draftText}
              </div>
            )}
          </div>
          {recording && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => stopVoiceTranscription()}
              title="Stop voice transcription"
              aria-label="Stop voice transcription"
            >
              <Square className="mr-1 h-3.5 w-3.5"/>
              Stop
            </Button>
          )}
          {state.error && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setState(initialState)}
            >
              Dismiss
            </Button>
          )}
        </div>
      )}
    </>
  )
}
