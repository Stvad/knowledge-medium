import { describe, expect, it } from 'vitest'
import {
  createTranscriptEventState,
  extractRealtimeClientSecret,
  formatTranscriptTime,
  reduceTranscriptEvent,
  splitSegmentTimeRange,
} from '../model.ts'

describe('voice transcription model helpers', () => {
  it('formats transcript timestamps', () => {
    expect(formatTranscriptTime(0)).toBe('0:00')
    expect(formatTranscriptTime(61_400)).toBe('1:01')
    expect(formatTranscriptTime(3_661_000)).toBe('1:01:01')
  })

  it('splits a segment timing range proportionally to text offset', () => {
    expect(splitSegmentTimeRange(1_000, 5_000, 20, 10)).toBe(3_000)
    expect(splitSegmentTimeRange(1_000, 5_000, 20, 0)).toBe(1_000)
    expect(splitSegmentTimeRange(1_000, 5_000, 20, 20)).toBe(5_000)
  })

  it('extracts client secrets from OpenAI and local endpoint response shapes', () => {
    expect(extractRealtimeClientSecret({value: 'ek_direct'})).toBe('ek_direct')
    expect(extractRealtimeClientSecret({client_secret: {value: 'ek_nested'}})).toBe('ek_nested')
    expect(extractRealtimeClientSecret({secret: 'ek_alias'})).toBe('ek_alias')
  })

  it('reduces realtime transcription deltas into completed timed segments', () => {
    let state = createTranscriptEventState()

    let result = reduceTranscriptEvent(state, {
      type: 'input_audio_buffer.speech_started',
      audio_start_ms: 120,
    }, 125)
    state = result.state
    expect(result.effects).toEqual([])

    result = reduceTranscriptEvent(state, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'hello ',
    }, 500)
    state = result.state
    expect(result.effects).toEqual([{
      kind: 'delta',
      itemId: 'item-1',
      text: 'hello ',
      startMs: 120,
    }])

    result = reduceTranscriptEvent(state, {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item-1',
      delta: 'world',
    }, 900)
    state = result.state
    expect(result.effects[0]).toMatchObject({
      kind: 'delta',
      text: 'hello world',
      startMs: 120,
    })

    result = reduceTranscriptEvent(state, {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'item-1',
      transcript: 'hello world',
      audio_end_ms: 1_300,
    }, 1_320)

    expect(result.effects).toEqual([{
      kind: 'segment',
      segment: {
        itemId: 'item-1',
        text: 'hello world',
        startMs: 120,
        endMs: 1_300,
      },
    }])
    expect(result.state.lastSegmentEndMs).toBe(1_300)
  })
})
