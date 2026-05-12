import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearOpenAiApiKey,
  saveOpenAiApiKey,
} from '../credentials.ts'
import {
  OPENAI_REALTIME_WHISPER_MODEL,
} from '../model.ts'
import {
  requestRealtimeClientSecret,
  startRealtimeTranscription,
} from '../realtime.ts'

class FakeDataChannel extends EventTarget {
  readonly send = vi.fn()
  readonly close = vi.fn(() => {
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

  it('requests transcription client secrets without unsupported turn detection', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({value: 'ek-test'}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    saveOpenAiApiKey('sk-test-local-only')

    await expect(requestRealtimeClientSecret()).resolves.toBe('ek-test')

    const call = fetchMock.mock.calls[0]
    expect(call).toBeDefined()
    const [url, init] = call as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/realtime/client_secrets')
    expect(init.method).toBe('POST')

    const body = JSON.parse(String(init.body)) as {
      session: {
        type: string
        audio: {
          input: Record<string, unknown>
        }
      }
    }
    expect(body.session.type).toBe('transcription')
    expect(body.session.audio.input.transcription).toEqual({
      model: OPENAI_REALTIME_WHISPER_MODEL,
    })
    expect(body.session.audio.input).not.toHaveProperty('turn_detection')
  })

  it('keeps recording across data-channel close and transient disconnects', async () => {
    const stopTrack = vi.fn()
    const stream = {
      getTracks: () => [{stop: stopTrack}],
    }
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.openai.com/v1/realtime/client_secrets') {
        return new Response(JSON.stringify({value: 'ek-test'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }
      return new Response('answer-sdp', {
        status: 200,
        headers: {'content-type': 'application/sdp'},
      })
    })
    const onOpen = vi.fn()
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

    const session = await startRealtimeTranscription({onOpen, onClose})
    const peerConnection = FakePeerConnection.latest
    const recorder = FakeMediaRecorder.latest
    expect(peerConnection).not.toBeNull()
    expect(recorder?.state).toBe('recording')

    peerConnection?.dataChannel.dispatchEvent(new Event('open'))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(peerConnection?.dataChannel.send).not.toHaveBeenCalled()

    peerConnection?.dataChannel.dispatchEvent(new Event('close'))
    peerConnection?.setConnectionState('disconnected')
    expect(recorder?.state).toBe('recording')
    expect(stopTrack).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()

    session.stop()
    expect(recorder?.state).toBe('inactive')
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
