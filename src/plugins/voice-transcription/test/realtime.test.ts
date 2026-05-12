import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearOpenAiApiKey,
  saveOpenAiApiKey,
} from '../credentials.ts'
import {
  OPENAI_REALTIME_WHISPER_MODEL,
} from '../model.ts'
import {
  startRealtimeTranscription,
} from '../realtime.ts'

class FakeDataChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting'
  readonly send = vi.fn()
  readonly close = vi.fn(() => {
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  })
}

class FakePeerConnection extends EventTarget {
  static latest: FakePeerConnection | null = null

  readonly dataChannel = new FakeDataChannel()
  connectionState: RTCPeerConnectionState = 'new'
  readonly addTrack = vi.fn()
  readonly createOffer = vi.fn(async () => ({sdp: 'offer-sdp'}))
  readonly setLocalDescription = vi.fn()
  readonly setRemoteDescription = vi.fn()
  readonly close = vi.fn(() => {
    this.connectionState = 'closed'
    this.dispatchEvent(new Event('connectionstatechange'))
  })

  constructor() {
    super()
    FakePeerConnection.latest = this
  }

  createDataChannel() {
    return this.dataChannel
  }

  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state
    this.dispatchEvent(new Event('connectionstatechange'))
  }
}

class FakeMediaRecorder extends EventTarget {
  static latest: FakeMediaRecorder | null = null

  state: RecordingState = 'inactive'
  readonly mimeType = 'audio/webm'

  constructor() {
    super()
    FakeMediaRecorder.latest = this
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }
}

describe('voice transcription realtime API', () => {
  afterEach(() => {
    clearOpenAiApiKey()
    FakePeerConnection.latest = null
    FakeMediaRecorder.latest = null
    vi.unstubAllGlobals()
  })

  it('creates BYOK realtime calls with transcription session config', async () => {
    const stopTrack = vi.fn()
    const stream = {
      getTracks: () => [{stop: stopTrack}],
    }
    const fetchMock = vi.fn(async () =>
      new Response('answer-sdp', {
        status: 200,
        headers: {'content-type': 'application/sdp'},
      }),
    )
    const onOpen = vi.fn()
    const onSegment = vi.fn()
    const onClose = vi.fn()

    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream),
      },
    })
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    saveOpenAiApiKey('sk-test-local-only')

    const session = await startRealtimeTranscription({onOpen, onSegment, onClose})
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/realtime/calls')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      authorization: 'Bearer sk-test-local-only',
    })
    expect(init.body).toBeInstanceOf(FormData)
    const body = init.body as FormData
    expect(body.get('sdp')).toBe('offer-sdp')
    const sessionConfig = JSON.parse(String(body.get('session'))) as {
      type: string
      audio: {
        input: Record<string, unknown>
      }
    }
    expect(sessionConfig.type).toBe('transcription')
    expect(sessionConfig.audio.input.transcription).toEqual({
      model: OPENAI_REALTIME_WHISPER_MODEL,
      language: 'en',
    })
    expect(sessionConfig.audio.input.turn_detection).toBeNull()

    const peerConnection = FakePeerConnection.latest
    const recorder = FakeMediaRecorder.latest
    expect(peerConnection).not.toBeNull()
    expect(recorder?.state).toBe('recording')

    if (peerConnection) peerConnection.dataChannel.readyState = 'open'
    peerConnection?.dataChannel.dispatchEvent(new Event('open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(peerConnection?.dataChannel.send).not.toHaveBeenCalled()

    peerConnection?.setConnectionState('disconnected')
    expect(recorder?.state).toBe('recording')
    expect(stopTrack).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    const stopPromise = session.stop()
    expect(peerConnection?.dataChannel.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'input_audio_buffer.commit',
    }))
    expect(recorder?.state).toBe('recording')

    peerConnection?.dataChannel.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        transcript: 'hello world',
        audio_end_ms: 1_200,
      }),
    }))
    await stopPromise

    expect(onSegment).toHaveBeenCalledWith({
      itemId: 'item-1',
      text: 'hello world',
      startMs: 0,
      endMs: 1_200,
    })
    expect(recorder?.state).toBe('inactive')
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith(undefined)
  })

  it('falls back to no turn detection when both manual and server VAD are unsupported', async () => {
    const stopTrack = vi.fn()
    const stream = {
      getTracks: () => [{stop: stopTrack}],
    }
    const manualUnsupportedResponse = JSON.stringify({
      error: {
        type: 'invalid_request_error',
        param: 'session.audio.input.turn_detection',
        message: 'Turn detection is not supported for this transcription model.',
      },
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(manualUnsupportedResponse, {
        status: 400,
        headers: {'content-type': 'application/json'},
      }))
      .mockResolvedValueOnce(new Response(manualUnsupportedResponse, {
        status: 400,
        headers: {'content-type': 'application/json'},
      }))
      .mockResolvedValueOnce(new Response('answer-sdp', {
        status: 200,
        headers: {'content-type': 'application/sdp'},
      }))
    const onClose = vi.fn()

    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream),
      },
    })
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    saveOpenAiApiKey('sk-test-local-only')

    const session = await startRealtimeTranscription({onClose})
    const peerConnection = FakePeerConnection.latest
    const recorder = FakeMediaRecorder.latest
    expect(peerConnection).not.toBeNull()
    expect(recorder?.state).toBe('recording')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [, initManual] = fetchMock.mock.calls[0] as [string, RequestInit]
    const [, initServerVad] = fetchMock.mock.calls[1] as [string, RequestInit]
    const [, initOmitted] = fetchMock.mock.calls[2] as [string, RequestInit]
    const manualSession = JSON.parse(String((initManual.body as FormData).get('session'))) as {
      type: string
      audio: {input: Record<string, unknown>}
    }
    const serverVadSession = JSON.parse(String((initServerVad.body as FormData).get('session'))) as {
      type: string
      audio: {input: Record<string, unknown>}
    }
    const omittedSession = JSON.parse(String((initOmitted.body as FormData).get('session'))) as {
      type: string
      audio: {input: Record<string, unknown>}
    }
    expect(manualSession.audio.input.turn_detection).toBeNull()
    expect(serverVadSession.audio.input.turn_detection).toMatchObject({
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 500,
    })
    expect('turn_detection' in omittedSession.audio.input).toBe(false)

    if (peerConnection) peerConnection.dataChannel.readyState = 'open'
    peerConnection?.dataChannel.dispatchEvent(new Event('open'))
    await new Promise(resolve => {
      setTimeout(resolve, 0)
    })

    await session.stop()
    expect(peerConnection?.dataChannel.send).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledWith(undefined)
  })

  it('reports peer connection diagnostics when the realtime session fails', async () => {
    const stopTrack = vi.fn()
    const stream = {
      getTracks: () => [{stop: stopTrack}],
    }
    const fetchMock = vi.fn(async () =>
      new Response('answer-sdp', {
        status: 200,
        headers: {'content-type': 'application/sdp'},
      }),
    )
    const onClose = vi.fn()

    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream),
      },
    })
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    saveOpenAiApiKey('sk-test-local-only')

    await startRealtimeTranscription({onClose})
    const peerConnection = FakePeerConnection.latest
    const recorder = FakeMediaRecorder.latest
    expect(peerConnection).not.toBeNull()
    expect(recorder?.state).toBe('recording')

    peerConnection?.dataChannel.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'session.created',
      }),
    }))
    peerConnection?.setConnectionState('failed')

    expect(recorder?.state).toBe('inactive')
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
    const [error] = onClose.mock.calls[0] as [Error]
    expect(error.message).toContain('Realtime transcription connection failed')
    expect(error.message).toContain('peer=failed')
    expect(error.message).toContain('dataChannel=')
    expect(error.message).toContain('lastEvent=session.created')
  })

  it('reports data channel close diagnostics', async () => {
    const stopTrack = vi.fn()
    const stream = {
      getTracks: () => [{stop: stopTrack}],
    }
    const fetchMock = vi.fn(async () =>
      new Response('answer-sdp', {
        status: 200,
        headers: {'content-type': 'application/sdp'},
      }),
    )
    const onClose = vi.fn()

    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream),
      },
    })
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
    saveOpenAiApiKey('sk-test-local-only')

    await startRealtimeTranscription({onClose})
    const peerConnection = FakePeerConnection.latest
    const recorder = FakeMediaRecorder.latest
    expect(peerConnection).not.toBeNull()

    peerConnection?.dataChannel.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'session.created',
      }),
    }))
    peerConnection?.dataChannel.dispatchEvent(new Event('close'))

    expect(recorder?.state).toBe('inactive')
    expect(stopTrack).toHaveBeenCalledTimes(1)
    const [error] = onClose.mock.calls[0] as [Error]
    expect(error.message).toContain('Realtime transcription data channel closed')
    expect(error.message).toContain('lastEvent=session.created')
  })
})
