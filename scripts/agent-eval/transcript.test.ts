import { describe, expect, it } from 'vitest'
import { extractAnswer, parseTranscript, toolUses } from './transcript'

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

  it('records each tool call once with the characters it returned', () => {
    expect(metrics.toolCalls).toEqual([
      {id: 't1', name: 'mcp__km__page', uses: ['mcp__km__page'], seenChars: 10, capped: false, returnedChars: 10, isError: false},
      {id: 't2', name: 'mcp__km__search', uses: ['mcp__km__search'], seenChars: capNotice.length, capped: true, returnedChars: 644_156, isError: false},
      {id: 't3', name: 'mcp__km__backlinks', uses: ['mcp__km__backlinks'], seenChars: 4, capped: false, returnedChars: 4, isError: true},
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
    expect(truncated.toolCalls.map(call => call.seenChars)).toEqual([10, capNotice.length, 4])
    expect(truncated.numTurns).toBeNull()
  })

  it('reads run metadata from the init and result lines', () => {
    expect(metrics).toMatchObject({
      model: 'claude-test', claudeCodeVersion: '9.9.9',
      numTurns: 4, costUsd: 0.01, terminalReason: 'completed', isError: false,
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

describe('toolUses', () => {
  const bash = (command: string) => toolUses({type: 'tool_use', name: 'Bash', input: {command}})

  it('counts a shell call once for each CLI verb it runs, piped or not', () => {
    expect(bash('kmagent subtree abc')).toEqual(['kmagent subtree'])
    expect(bash('kmagent sql all "SELECT 1" | jq .')).toEqual(['kmagent sql'])
    expect(bash('kmagent data-model; kmagent page Project Orchard')).toEqual(['kmagent data-model', 'kmagent page'])
    expect(bash('kmagent --help')).toEqual(['kmagent --help'])
  })

  it('names any other command by its program, never by an argument or a path', () => {
    expect(bash('ls -la')).toEqual(['bash ls'])
    expect(bash('f=/home/someone/.cache/out.txt; grep x $f')).toEqual(['bash grep'])
    expect(bash('/usr/bin/env true')).toEqual(['bash'])
  })

  it('keeps any other tool\'s name', () => {
    expect(toolUses({type: 'tool_use', name: 'mcp__km__page', input: {name: 'x'}})).toEqual(['mcp__km__page'])
  })
})

describe('a shell result over the cap', () => {
  const preview = '<persisted-output>\nOutput too large (97.7KB). Full output saved to: /x.txt\n\nPreview (first 2KB):\nabc\n...\n</persisted-output>'
  const shellCall = (size?: number) => [
    assistant('m1', [{type: 'tool_use', id: 't1', name: 'Bash', input: {command: 'kmagent subtree x'}}], usage(1, 1, 1, 1)),
    JSON.stringify({type: 'user', message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't1', content: preview}]},
      tool_use_result: {stdout: 'abc', persistedOutputSize: size}}),
  ].join('\n')

  it('is capped: the preview is what the model saw, the saved size what the tool returned', () => {
    expect(parseTranscript(shellCall(100_000)).toolCalls).toEqual([expect.objectContaining({
      uses: ['kmagent subtree'], capped: true, seenChars: preview.length, returnedChars: 100_000,
    })])
  })

  it('returned an unknown size when the stream does not carry one', () => {
    expect(parseTranscript(shellCall()).toolCalls[0]).toEqual(expect.objectContaining({capped: true, returnedChars: null}))
  })
})
