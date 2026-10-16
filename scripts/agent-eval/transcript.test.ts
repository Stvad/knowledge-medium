import { describe, expect, it } from 'vitest'
import { extractAnswer, parseTranscript } from './transcript'

const usage = (input: number, created: number, read: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: created,
  cache_read_input_tokens: read,
  output_tokens: output,
})

const assistant = (id: string, content: unknown[], messageUsage: ReturnType<typeof usage>) =>
  JSON.stringify({type: 'assistant', message: {id, role: 'assistant', content, usage: messageUsage}})

const capNotice = 'Error: result (644,156 characters across 2,001 lines) exceeds maximum allowed tokens. Output has been saved to /x.txt.'

const toolResult = (toolUseId: string, text: string, isError = false) =>
  JSON.stringify({type: 'user', message: {role: 'user', content: [
    {type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: [{type: 'text', text}]},
  ]}})

// The stream's real shape: one assistant line PER CONTENT BLOCK, each
// repeating the message id and usage of the API call that produced it.
const transcript = [
  JSON.stringify({type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-test', claude_code_version: '9.9.9'}),
  assistant('m1', [{type: 'tool_use', id: 't1', name: 'mcp__km__page', input: {name: 'Kestrel'}}], usage(2, 5000, 0, 20)),
  toolResult('t1', 'é'.repeat(10)),
  assistant('m2', [{type: 'tool_use', id: 't2', name: 'mcp__km__search', input: {query: 'x'}}], usage(2, 400, 5000, 30)),
  assistant('m2', [{type: 'tool_use', id: 't3', name: 'mcp__km__backlinks', input: {id: 'b'}}], usage(2, 400, 5000, 30)),
  toolResult('t2', capNotice),
  toolResult('t3', 'boom', true),
  assistant('m3', [{type: 'text', text: 'done\nANSWER: {"ok": true}'}], usage(2, 100, 5400, 10)),
  JSON.stringify({type: 'result', subtype: 'success', is_error: false, num_turns: 4, duration_ms: 1234,
    total_cost_usd: 0.01, terminal_reason: 'completed', result: 'done\nANSWER: {"ok": true}',
    usage: usage(6, 5500, 10400, 60)}),
  'not json',
].join('\n')

describe('parseTranscript', () => {
  const metrics = parseTranscript(transcript)

  it('records each tool call once with the UTF-8 bytes it returned', () => {
    expect(metrics.toolCalls).toEqual([
      {id: 't1', name: 'mcp__km__page', inputBytes: 18, outputBytes: 20, capped: false, returnedBytes: 20, isError: false},
      {id: 't2', name: 'mcp__km__search', inputBytes: 13, outputBytes: capNotice.length, capped: true, returnedBytes: 644_156, isError: false},
      {id: 't3', name: 'mcp__km__backlinks', inputBytes: 10, outputBytes: 4, capped: false, returnedBytes: 4, isError: true},
    ])
  })

  it('counts API calls by message id, not by stream line', () => {
    expect(metrics.apiCalls).toBe(3)
  })

  it('takes totals from the result line and the peak from the largest call', () => {
    expect(metrics.tokens).toEqual({
      input: 6, cacheCreation: 5500, cacheRead: 10400, output: 60,
      contextTotal: 15_906, peakContext: 5502,
    })
  })

  it('falls back to summing per-call usage when the run ended without a result line', () => {
    const truncated = parseTranscript(transcript.split('\n').slice(0, 7).join('\n'))
    expect(truncated.tokens.contextTotal).toBe(5002 + 5402)
    expect(truncated.toolCalls.map(call => call.outputBytes)).toEqual([20, capNotice.length, 4])
    expect(truncated.numTurns).toBeNull()
  })

  it('reads run metadata from the init and result lines', () => {
    expect(metrics).toMatchObject({
      sessionId: 's-1', model: 'claude-test', claudeCodeVersion: '9.9.9',
      numTurns: 4, durationMs: 1234, costUsd: 0.01, terminalReason: 'completed', isError: false,
    })
  })
})

describe('extractAnswer', () => {
  it('parses the last ANSWER line', () => {
    expect(extractAnswer('ANSWER: {"a": 1}\nthinking more\nANSWER: {"a": 2}')).toEqual({a: 2})
  })

  it('tolerates the decoration models put around the line', () => {
    expect(extractAnswer('Here you go.\n`ANSWER: {"dates": ["2026-06-04"]}`')).toEqual({dates: ['2026-06-04']})
    expect(extractAnswer('**ANSWER:** {"n": 5}')).toEqual({n: 5})
    expect(extractAnswer('**ANSWER**: {"n": 5}')).toEqual({n: 5})
    expect(extractAnswer('ANSWER: {"n": 5}.')).toEqual({n: 5})
    expect(extractAnswer('ANSWER: `{"n": 5}`')).toEqual({n: 5})
    expect(extractAnswer('- ANSWER: {"n": 5}')).toEqual({n: 5})
    expect(extractAnswer('> ANSWER: {"s": "a } in a string"}')).toEqual({s: 'a } in a string'})
    expect(extractAnswer('ANSWER:\n```json\n{\n  "n": 5\n}\n```\nThat is all {really}.')).toEqual({n: 5})
  })

  it('is undefined when the line is missing or malformed', () => {
    expect(extractAnswer('no answer here')).toBeUndefined()
    expect(extractAnswer('ANSWER: {not json')).toBeUndefined()
  })
})
