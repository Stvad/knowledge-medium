import {
  OPENAI_REALTIME_WHISPER_MODEL,
  createTranscriptEventState,
  extractRealtimeClientSecret,
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
  onClose?: () => void
}

export interface RealtimeTranscriptionSession {
  stop: () => void
}

const realtimeCallsUrl = 'https://api.openai.com/v1/realtime/calls'

const transcriptionClientSecretRequest = () => ({
  session: {
    type: 'transcription',
    audio: {
      input: {
        transcription: {
          model: OPENAI_REALTIME_WHISPER_MODEL,
        },
      },
    },
  },
})

export const requestRealtimeClientSecret = async (): Promise<string> => {
  const apiKey = readStoredOpenAiApiKey()
  if (!apiKey) throw new Error('OpenAI API key is not configured')

  const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(transcriptionClientSecretRequest()),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `OpenAI Realtime client secret request failed with HTTP ${response.status}`)
  }

  return extractRealtimeClientSecret(await response.json())
}

const stopStream = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) track.stop()
}

const startAudioRecorder = (
  stream: MediaStream,
  onAudioUrl: ((url: string) => void) | undefined,
): MediaRecorder | null => {
  if (typeof MediaRecorder === 'undefined') return null

  const chunks: Blob[] = []
  const recorder = new MediaRecorder(stream)
  recorder.addEventListener('dataavailable', event => {
    if (event.data.size > 0) chunks.push(event.data)
  })
  recorder.addEventListener('stop', () => {
    if (chunks.length === 0) return
    const type = recorder.mimeType || chunks[0]?.type || 'audio/webm'
    onAudioUrl?.(URL.createObjectURL(new Blob(chunks, {type})))
  })
  recorder.start()
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

  const clientSecret = await requestRealtimeClientSecret()
  const stream = await navigator.mediaDevices.getUserMedia({audio: true})
  const recorder = startAudioRecorder(stream, callbacks.onAudioUrl)
  const peerConnection = new RTCPeerConnection()
  const dataChannel = peerConnection.createDataChannel('oai-events')
  const startedAt = performance.now()
  let eventState = createTranscriptEventState()
  let closed = false

  const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt))

  const close = (): void => {
    if (closed) return
    closed = true
    if (recorder && recorder.state !== 'inactive') {
      recorder.addEventListener('stop', () => stopStream(stream), {once: true})
      recorder.stop()
    } else {
      stopStream(stream)
    }
    dataChannel.close()
    peerConnection.close()
    callbacks.onClose?.()
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
  })

  peerConnection.addEventListener('connectionstatechange', () => {
    if (
      peerConnection.connectionState === 'failed' ||
      peerConnection.connectionState === 'closed'
    ) {
      close()
    }
  })

  try {
    for (const track of stream.getTracks()) {
      peerConnection.addTrack(track, stream)
    }

    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    if (!offer.sdp) throw new Error('WebRTC offer did not include SDP')

    const response = await fetch(realtimeCallsUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${clientSecret}`,
        'content-type': 'application/sdp',
      },
      body: offer.sdp,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || `Realtime WebRTC offer failed with HTTP ${response.status}`)
    }

    await peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: await response.text(),
    })
  } catch (error) {
    close()
    throw error
  }

  return {
    stop: close,
  }
}
