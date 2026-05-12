import {
  OPENAI_REALTIME_WHISPER_MODEL,
  createTranscriptEventState,
  reduceTranscriptEvent,
  type TranscriptSegment,
} from './model.ts'
import { readStoredOpenAiApiKey } from './credentials.ts'

export interface RealtimeTranscriptionCallbacks {
  onOpen?: () => void
  onDelta?: (draft: {itemId: string; text: string; startMs: number}) => void
  onSegment?: (segment: TranscriptSegment) => void
  onAudioUrl?: (url: string) => void
  onError?: (error: Error) => void
  onClose?: (error?: Error) => void
}

export interface RealtimeTranscriptionSession {
  stop: (options?: {discard?: boolean}) => Promise<void>
}

const realtimeCallsUrl = 'https://api.openai.com/v1/realtime/calls'
const finalTranscriptWaitMs = 3_000

type TurnDetectionMode = 'server_vad' | 'manual'

const serverVadConfig = {
  type: 'server_vad',
  threshold: 0.5,
  prefix_padding_ms: 300,
  silence_duration_ms: 500,
} as const

const transcriptionSessionConfig = (turnDetectionMode: TurnDetectionMode) => ({
  type: 'transcription',
  audio: {
    input: {
      transcription: {
        model: OPENAI_REALTIME_WHISPER_MODEL,
        language: 'en',
      },
      turn_detection: turnDetectionMode === 'server_vad' ? serverVadConfig : null,
    },
  },
})

const isUnsupportedTurnDetectionError = (text: string): boolean => {
  try {
    const payload = JSON.parse(text) as unknown
    if (typeof payload !== 'object' || payload === null) return false
    const error = (payload as Record<string, unknown>).error
    if (typeof error !== 'object' || error === null) return false
    const message = stringField(error, 'message') ?? ''
    const param = stringField(error, 'param')
    return param === 'session.audio.input.turn_detection' &&
      /turn detection is not supported/i.test(message)
  } catch {
    return false
  }
}

const createRealtimeCallWithConfig = async (
  apiKey: string,
  sdp: string,
  turnDetectionMode: TurnDetectionMode,
): Promise<string> => {
  const formData = new FormData()
  formData.set('sdp', sdp)
  formData.set('session', JSON.stringify(transcriptionSessionConfig(turnDetectionMode)))

  const response = await fetch(realtimeCallsUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Realtime WebRTC offer failed with HTTP ${response.status}`)
  }

  return response.text()
}

const createRealtimeCall = async (
  apiKey: string,
  sdp: string,
): Promise<{answerSdp: string; turnDetectionMode: TurnDetectionMode}> => {
  try {
    return {
      answerSdp: await createRealtimeCallWithConfig(apiKey, sdp, 'server_vad'),
      turnDetectionMode: 'server_vad',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!isUnsupportedTurnDetectionError(message)) throw error
  }

  return {
    answerSdp: await createRealtimeCallWithConfig(apiKey, sdp, 'manual'),
    turnDetectionMode: 'manual',
  }
}

const stopStream = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) track.stop()
}

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

const nestedErrorMessage = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const error = (value as Record<string, unknown>).error
  if (typeof error === 'string') return error
  if (typeof error !== 'object' || error === null) return undefined
  return stringField(error, 'message')
}

const nestedErrorCode = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const error = (value as Record<string, unknown>).error
  if (typeof error !== 'object' || error === null) return undefined
  return stringField(error, 'code')
}

const isEmptyManualCommitError = (value: unknown): boolean => {
  const code = nestedErrorCode(value)
  const message = nestedErrorMessage(value) ?? ''
  return code === 'input_audio_buffer_commit_empty' ||
    /input audio buffer.*empty/i.test(message)
}

const preferredRecorderMimeType = (): string | undefined => {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    return undefined
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ]
  return candidates.find(candidate => MediaRecorder.isTypeSupported(candidate))
}

const startAudioRecorder = (
  stream: MediaStream,
  onAudioUrl: ((url: string) => void) | undefined,
): MediaRecorder | null => {
  if (typeof MediaRecorder === 'undefined') return null

  const chunks: Blob[] = []
  const mimeType = preferredRecorderMimeType()
  const recorder = mimeType
    ? new MediaRecorder(stream, {mimeType})
    : new MediaRecorder(stream)
  recorder.addEventListener('dataavailable', event => {
    if (event.data.size > 0) chunks.push(event.data)
  })
  recorder.addEventListener('stop', () => {
    if (chunks.length === 0) return
    const type = recorder.mimeType || chunks[0]?.type || 'audio/webm'
    onAudioUrl?.(URL.createObjectURL(new Blob(chunks, {type})))
  })
  recorder.start(1_000)
  return recorder
}

export const startRealtimeTranscription = async (
  callbacks: RealtimeTranscriptionCallbacks,
): Promise<RealtimeTranscriptionSession> => {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser does not expose microphone capture')
  }
  if (typeof RTCPeerConnection === 'undefined') {
    throw new Error('This browser does not expose WebRTC peer connections')
  }

  const apiKey = readStoredOpenAiApiKey()
  if (!apiKey) throw new Error('OpenAI API key is not configured')

  const stream = await navigator.mediaDevices.getUserMedia({audio: true})
  const recorder = startAudioRecorder(stream, callbacks.onAudioUrl)
  const peerConnection = new RTCPeerConnection()
  const dataChannel = peerConnection.createDataChannel('oai-events')
  const startedAt = performance.now()
  let eventState = createTranscriptEventState()
  let closed = false
  let turnDetectionMode: TurnDetectionMode = 'server_vad'
  let lastServerEventType: string | null = null
  let lastServerError: string | null = null
  let stopPromise: Promise<void> | null = null
  let resolveStop: (() => void) | null = null
  let stopTimeout: ReturnType<typeof setTimeout> | null = null
  let waitingForManualCommit = false
  let closePromise: Promise<void> | null = null
  let resolveClose: (() => void) | null = null

  const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt))

  const realtimeStateSummary = (): string => {
    const parts = [
      `peer=${peerConnection.connectionState}`,
      `ice=${peerConnection.iceConnectionState}`,
      `signaling=${peerConnection.signalingState}`,
      `dataChannel=${dataChannel.readyState}`,
    ]
    if (lastServerEventType) parts.push(`lastEvent=${lastServerEventType}`)
    if (lastServerError) parts.push(`lastError=${lastServerError}`)
    return parts.join(', ')
  }

  const resolveStopPromise = (): void => {
    if (stopTimeout) {
      clearTimeout(stopTimeout)
      stopTimeout = null
    }
    const resolve = resolveStop
    resolveStop = null
    stopPromise = null
    waitingForManualCommit = false
    resolve?.()
  }

  const finishClose = (): void => {
    resolveStopPromise()
    resolveClose?.()
    resolveClose = null
  }

  const close = (error?: Error, options: {expected?: boolean} = {}): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve()
    closed = true
    closePromise = new Promise(resolve => {
      resolveClose = resolve
    })
    if (recorder && recorder.state !== 'inactive') {
      recorder.addEventListener('stop', () => {
        stopStream(stream)
        finishClose()
      }, {once: true})
      recorder.requestData?.()
      recorder.stop()
    } else {
      stopStream(stream)
      finishClose()
    }
    dataChannel.close()
    peerConnection.close()
    callbacks.onClose?.(
      error ??
      (options.expected ? undefined : new Error(`Realtime transcription connection closed (${realtimeStateSummary()})`)),
    )
    return closePromise
  }

  dataChannel.addEventListener('open', () => {
    callbacks.onOpen?.()
  })

  dataChannel.addEventListener('message', event => {
    let payload: unknown
    try {
      payload = JSON.parse(String(event.data))
    } catch {
      return
    }
    lastServerEventType = stringField(payload, 'type') ?? lastServerEventType
    lastServerError = nestedErrorMessage(payload) ?? lastServerError
    const type = stringField(payload, 'type')

    if (waitingForManualCommit && type === 'error' && isEmptyManualCommitError(payload)) {
      void close(undefined, {expected: true})
      return
    }

    const result = reduceTranscriptEvent(eventState, payload, elapsedMs())
    eventState = result.state

    for (const effect of result.effects) {
      if (effect.kind === 'delta') {
        callbacks.onDelta?.({
          itemId: effect.itemId,
          text: effect.text,
          startMs: effect.startMs,
        })
      } else if (effect.kind === 'segment') {
        callbacks.onSegment?.(effect.segment)
      } else {
        callbacks.onError?.(new Error(effect.message))
      }
    }

    if (
      waitingForManualCommit &&
      type === 'conversation.item.input_audio_transcription.completed'
    ) {
      void close(undefined, {expected: true})
    }
  })

  dataChannel.addEventListener('error', () => {
    void close(new Error(`Realtime transcription data channel error (${realtimeStateSummary()})`))
  })
  dataChannel.addEventListener('close', () => {
    void close(new Error(`Realtime transcription data channel closed (${realtimeStateSummary()})`))
  })

  peerConnection.addEventListener('connectionstatechange', () => {
    if (
      peerConnection.connectionState === 'failed' ||
      peerConnection.connectionState === 'closed'
    ) {
      void close(new Error(`Realtime transcription connection ${peerConnection.connectionState} (${realtimeStateSummary()})`))
    }
  })

  try {
    for (const track of stream.getTracks()) {
      peerConnection.addTrack(track, stream)
    }

    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    if (!offer.sdp) throw new Error('WebRTC offer did not include SDP')

    const call = await createRealtimeCall(apiKey, offer.sdp)
    turnDetectionMode = call.turnDetectionMode

    await peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: call.answerSdp,
    })
  } catch (error) {
    void close(error instanceof Error ? error : new Error(String(error)))
    throw error
  }

  return {
    stop: ({discard = false} = {}) => {
      if (closed) return Promise.resolve()
      if (discard || turnDetectionMode !== 'manual' || dataChannel.readyState !== 'open') {
        return close(undefined, {expected: true})
      }
      if (stopPromise) return stopPromise

      waitingForManualCommit = true
      dataChannel.send(JSON.stringify({type: 'input_audio_buffer.commit'}))
      stopPromise = new Promise(resolve => {
        resolveStop = resolve
        stopTimeout = setTimeout(() => {
          void close(undefined, {expected: true})
        }, finalTranscriptWaitMs)
      })
      return stopPromise
    },
  }
}
