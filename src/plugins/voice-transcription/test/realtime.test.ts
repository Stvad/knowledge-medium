import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearOpenAiApiKey,
  saveOpenAiApiKey,
} from '../credentials.ts'
import {
  OPENAI_REALTIME_WHISPER_MODEL,
} from '../model.ts'
import { requestRealtimeClientSecret } from '../realtime.ts'

describe('voice transcription realtime API', () => {
  afterEach(() => {
    clearOpenAiApiKey()
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
})
