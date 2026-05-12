export const OPENAI_REALTIME_WHISPER_MODEL = 'gpt-realtime-whisper'

export interface TranscriptSegment {
  itemId: string
  text: string
  startMs: number
  endMs: number
}

export interface TranscriptEventDraft {
  itemId: string
  text: string
  startMs: number
}

export interface TranscriptEventState {
  itemDrafts: ReadonlyMap<string, TranscriptEventDraft>
  lastSegmentEndMs: number
  speechStartMs: number | null
}

export type TranscriptEventEffect =
  | {kind: 'delta'; itemId: string; text: string; startMs: number}
  | {kind: 'segment'; segment: TranscriptSegment}
  | {kind: 'error'; message: string}

export interface TranscriptEventReduceResult {
  state: TranscriptEventState
  effects: readonly TranscriptEventEffect[]
}

const FALLBACK_ITEM_ID = 'default'

export const createTranscriptEventState = (): TranscriptEventState => ({
  itemDrafts: new Map(),
  lastSegmentEndMs: 0,
  speechStartMs: null,
})

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

const numberField = (value: unknown, key: string): number | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

const nestedErrorMessage = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const error = (value as Record<string, unknown>).error
  if (typeof error === 'string') return error
  if (typeof error !== 'object' || error === null) return undefined
  return stringField(error, 'message')
}

export const reduceTranscriptEvent = (
  state: TranscriptEventState,
  event: unknown,
  elapsedMs: number,
): TranscriptEventReduceResult => {
  const type = stringField(event, 'type')
  const itemDrafts = new Map(state.itemDrafts)
  const effects: TranscriptEventEffect[] = []

  if (type === 'input_audio_buffer.speech_started') {
    return {
      state: {
        ...state,
        speechStartMs: numberField(event, 'audio_start_ms') ?? elapsedMs,
      },
      effects,
    }
  }

  if (type === 'input_audio_buffer.speech_stopped') {
    return {
      state: {
        ...state,
        speechStartMs: state.speechStartMs ?? numberField(event, 'audio_end_ms') ?? elapsedMs,
      },
      effects,
    }
  }

  if (type === 'conversation.item.input_audio_transcription.delta') {
    const itemId = stringField(event, 'item_id') ?? FALLBACK_ITEM_ID
    const delta = stringField(event, 'delta') ?? ''
    const existing = itemDrafts.get(itemId)
    const startMs = existing?.startMs ?? state.speechStartMs ?? state.lastSegmentEndMs
    const text = `${existing?.text ?? ''}${delta}`
    itemDrafts.set(itemId, {itemId, text, startMs})
    effects.push({kind: 'delta', itemId, text, startMs})

    return {
      state: {...state, itemDrafts},
      effects,
    }
  }

  if (type === 'conversation.item.input_audio_transcription.completed') {
    const itemId = stringField(event, 'item_id') ?? FALLBACK_ITEM_ID
    const existing = itemDrafts.get(itemId)
    const transcript = stringField(event, 'transcript') ?? existing?.text ?? ''
    const text = transcript.trim()
    const endMs = Math.max(
      existing?.startMs ?? state.lastSegmentEndMs,
      numberField(event, 'audio_end_ms') ?? elapsedMs,
    )
    const startMs = Math.min(
      endMs,
      existing?.startMs ?? state.speechStartMs ?? state.lastSegmentEndMs,
    )
    itemDrafts.delete(itemId)

    if (text.length > 0) {
      effects.push({
        kind: 'segment',
        segment: {
          itemId,
          text,
          startMs,
          endMs,
        },
      })
    }

    return {
      state: {
        itemDrafts,
        lastSegmentEndMs: endMs,
        speechStartMs: null,
      },
      effects,
    }
  }

  if (type === 'error') {
    effects.push({
      kind: 'error',
      message: nestedErrorMessage(event) ?? stringField(event, 'message') ?? 'Realtime transcription failed',
    })
  }

  return {state, effects}
}

export const formatTranscriptTime = (ms: number | undefined): string => {
  const totalSeconds = Math.max(0, Math.floor((ms ?? 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const paddedSeconds = seconds.toString().padStart(2, '0')

  if (hours === 0) return `${minutes}:${paddedSeconds}`

  return [
    hours,
    minutes.toString().padStart(2, '0'),
    paddedSeconds,
  ].join(':')
}

export const formatTranscriptTimeRange = (
  startMs: number | undefined,
  endMs: number | undefined,
): string =>
  `${formatTranscriptTime(startMs)}-${formatTranscriptTime(endMs ?? startMs)}`

export const splitSegmentTimeRange = (
  startMs: number,
  endMs: number,
  textLength: number,
  offset: number,
): number => {
  if (endMs <= startMs) return startMs
  const ratio = Math.min(1, Math.max(0, offset / Math.max(1, textLength)))
  return Math.round(startMs + (endMs - startMs) * ratio)
}

export const extractRealtimeClientSecret = (payload: unknown): string => {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Realtime client secret response returned a non-object payload')
  }

  const record = payload as Record<string, unknown>
  const direct = record.value ?? record.secret ?? record.client_secret
  if (typeof direct === 'string' && direct.trim()) return direct.trim()

  const nested = record.client_secret
  if (typeof nested === 'object' && nested !== null) {
    const value = (nested as Record<string, unknown>).value
    if (typeof value === 'string' && value.trim()) return value.trim()
  }

  throw new Error('Realtime client secret response did not return a client secret')
}
