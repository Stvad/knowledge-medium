import {describe, expect, it} from 'vitest'
import {spawn} from 'node:child_process'
import {
  BILLING_ENV_DENYLIST,
  buildClaudeArgs,
  createStreamJsonParser,
  runClaude,
  scrubEnv,
  type ClaudeRunOptions,
  type RunEvent,
  type SpawnImpl,
} from '../src/runner'

const baseOptions: ClaudeRunOptions = {
  claudeBin: 'claude',
  prompt: 'do the thing',
  allowedTools: [],
  timeoutMs: 5_000,
}

describe('buildClaudeArgs', () => {
  it('builds a print-mode stream-json run WITHOUT the prompt in argv (stdin carries it)', () => {
    expect(buildClaudeArgs(baseOptions)).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    ])
  })

  it('threads resume/model/mcp/tools through, pinning strict mcp config', () => {
    const args = buildClaudeArgs({
      ...baseOptions,
      resumeSessionId: 'sess-1',
      model: 'claude-sonnet-5',
      mcpConfigPath: '/tmp/km.json',
      allowedTools: ['mcp__km__get_block', 'mcp__km__search'],
    })
    expect(args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--resume', 'sess-1',
      '--model', 'claude-sonnet-5',
      '--mcp-config', '/tmp/km.json', '--strict-mcp-config',
      '--allowedTools', 'mcp__km__get_block,mcp__km__search',
    ])
  })
})

describe('scrubEnv', () => {
  it('removes billing-redirecting vars and keeps the rest', () => {
    const env = scrubEnv({
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'sk-api',
      ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      HOME: '/Users/x',
    })
    expect(env).toEqual({PATH: '/usr/bin', HOME: '/Users/x'})
    for (const key of BILLING_ENV_DENYLIST) expect(env).not.toHaveProperty(key)
  })
})

describe('createStreamJsonParser', () => {
  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`

  it('full happy path: init -> tool_use activity -> text deltas cumulative -> result', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))

    parser.feed(line({type: 'system', subtype: 'init', session_id: 'sess-1'}))
    parser.feed(line({
      type: 'stream_event',
      event: {type: 'content_block_start', content_block: {type: 'tool_use', name: 'mcp__km__get_block'}},
    }))
    parser.feed(line({type: 'stream_event', event: {type: 'message_start'}}))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'Hel'}}}))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'lo'}}}))
    parser.feed(line({type: 'result', result: 'Hello', session_id: 'sess-1', is_error: false}))

    expect(events).toEqual([
      {kind: 'session', sessionId: 'sess-1'},
      {kind: 'activity', label: 'km: get_block'},
      {kind: 'text', text: 'Hel'},
      {kind: 'text', text: 'Hello'},
    ])

    const result = parser.finish()
    expect(result).toMatchObject({resultText: 'Hello', sessionId: 'sess-1', isError: false})
  })

  it('handles a chunk split MID-LINE across feed calls', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))
    const full = line({type: 'system', subtype: 'init', session_id: 'sess-mid'})
    const splitAt = Math.floor(full.length / 2)

    parser.feed(full.slice(0, splitAt))
    expect(events).toEqual([]) // nothing yet — line isn't terminated
    parser.feed(full.slice(splitAt))
    expect(events).toEqual([{kind: 'session', sessionId: 'sess-mid'}])
  })

  it('skips garbage and unknown lines without throwing', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))

    parser.feed('not json at all\n')
    parser.feed(line([1, 2, 3])) // valid JSON, not an object
    parser.feed(line({type: 'some_future_type', whatever: true}))
    parser.feed(line({type: 'result', result: 'ok', session_id: 's', is_error: false}))

    expect(events).toEqual([])
    expect(parser.finish()).toMatchObject({resultText: 'ok'})
  })

  it('finish() returns null when no result line was seen', () => {
    const parser = createStreamJsonParser()
    parser.feed(line({type: 'system', subtype: 'init', session_id: 's'}))
    expect(parser.finish()).toBeNull()
  })

  it('sessionId() survives a missing result line (timeout/crash) via the init line', () => {
    const parser = createStreamJsonParser()
    parser.feed(line({type: 'system', subtype: 'init', session_id: 'sess-init'}))
    // No result line — as on a timeout.
    expect(parser.finish()).toBeNull()
    expect(parser.sessionId()).toBe('sess-init')
  })

  it('finish() flushes a trailing unterminated line', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))
    // No trailing newline — must still be picked up by finish().
    parser.feed(JSON.stringify({type: 'result', result: 'flushed', session_id: null, is_error: false}))
    expect(parser.finish()).toMatchObject({resultText: 'flushed'})
  })

  it('an assistant complete-text message resets/dedupes the partial-delta accumulator', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))

    parser.feed(line({type: 'stream_event', event: {type: 'message_start'}}))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'Partial'}}}))
    parser.feed(line({type: 'assistant', message: {content: [{type: 'text', text: 'Full final text'}]}}))

    expect(events).toEqual([
      {kind: 'text', text: 'Partial'},
      {kind: 'text', text: 'Full final text'},
    ])
  })

  it('humanizes tool names, including the mcp__km__ mapping', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))

    parser.feed(line({type: 'assistant', message: {content: [
      {type: 'tool_use', name: 'mcp__km__search'},
      {type: 'tool_use', name: 'WebSearch'},
      {type: 'tool_use', name: 'WebFetch'},
      {type: 'tool_use', name: 'Bash'},
    ]}}))

    expect(events).toEqual([
      {kind: 'activity', label: 'km: search'},
      {kind: 'activity', label: 'Searching the web'},
      {kind: 'activity', label: 'Fetching a page'},
      {kind: 'activity', label: 'Bash'},
    ])
  })

  it('never throws from feed or finish, and tolerates a throwing onEvent handler', () => {
    const parser = createStreamJsonParser(() => { throw new Error('consumer bug') })
    expect(() => parser.feed(line({type: 'system', subtype: 'init', session_id: 's'}))).not.toThrow()
    expect(() => parser.feed(line({type: 'result', result: 'ok', session_id: 's', is_error: false}))).not.toThrow()
    expect(parser.finish()).toMatchObject({resultText: 'ok'})
  })
})

/** Run the real runner against a scripted `node -e` child. */
const fakeClaude = (script: string): SpawnImpl =>
  ((_bin: string, _args: readonly string[], options: object) =>
    spawn(process.execPath, ['-e', script], options)) as SpawnImpl

/** Write a single stream-json JSONL result line (mirrors real `claude`
 *  `--output-format stream-json` output). */
const streamResult = (obj: Record<string, unknown>) =>
  `process.stdout.write(JSON.stringify(${JSON.stringify(obj)}) + '\\n')`

describe('runClaude', () => {
  it('returns ok with parsed result on a clean run', async () => {
    const result = await runClaude(baseOptions, fakeClaude(
      streamResult({type: 'result', result: 'hi', session_id: 's1', is_error: false}),
    ))
    expect(result).toMatchObject({ok: true, resultText: 'hi', sessionId: 's1', exitCode: 0})
  })

  it('fails on nonzero exit and captures stderr', async () => {
    const result = await runClaude(baseOptions, fakeClaude(
      `process.stderr.write('boom'); process.exit(3)`,
    ))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('boom')
  })

  it('fails when the envelope reports is_error even with exit 0', async () => {
    const result = await runClaude(baseOptions, fakeClaude(
      streamResult({type: 'result', result: 'refused', session_id: null, is_error: true}),
    ))
    expect(result.ok).toBe(false)
    expect(result.resultText).toBe('refused')
  })

  it('kills runs that exceed the timeout', async () => {
    const result = await runClaude(
      {...baseOptions, timeoutMs: 300},
      fakeClaude(`setTimeout(() => {}, 60_000)`),
    )
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('retains the session id from a run that timed out before the result line', async () => {
    // The init line arrives, then the child hangs past the timeout — no
    // result line. The (billed) session id must still come back so a
    // retry can --resume it.
    const result = await runClaude(
      {...baseOptions, timeoutMs: 300},
      fakeClaude(`${streamResult({type: 'system', subtype: 'init', session_id: 'sess-timeout'})}; setTimeout(() => {}, 60_000)`),
    )
    expect(result.timedOut).toBe(true)
    expect(result.sessionId).toBe('sess-timeout')
  })

  it('scrubs billing vars from the child environment', async () => {
    const result = await runClaude(
      {...baseOptions, env: {...process.env, ANTHROPIC_API_KEY: 'sk-leak'}},
      fakeClaude(
        `process.stdout.write(JSON.stringify({type: 'result', result: process.env.ANTHROPIC_API_KEY ?? 'clean', session_id: 's', is_error: false}) + '\\n')`,
      ),
    )
    expect(result.resultText).toBe('clean')
  })

  it('delivers the prompt over stdin, not argv', async () => {
    const result = await runClaude(
      {...baseOptions, prompt: 'secret note content'},
      fakeClaude(
        `let input = '';
         process.stdin.on('data', chunk => { input += chunk });
         process.stdin.on('end', () => {
           const inArgv = process.argv.join(' ').includes('secret note content')
           process.stdout.write(JSON.stringify({type: 'result', result: inArgv ? 'LEAKED-TO-ARGV' : input, session_id: 's', is_error: false}) + '\\n')
         })`,
      ),
    )
    expect(result.resultText).toBe('secret note content')
  })

  it('reports progress events observed during the run, mirroring the final result', async () => {
    const events: RunEvent[] = []
    const script = [
      streamResult({type: 'system', subtype: 'init', session_id: 'sess-e2e'}),
      streamResult({type: 'assistant', message: {content: [{type: 'tool_use', name: 'mcp__km__get_block'}]}}),
      streamResult({type: 'stream_event', event: {type: 'message_start'}}),
      streamResult({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'partial'}}}),
      streamResult({type: 'result', result: 'final answer', session_id: 'sess-e2e', is_error: false}),
    ].join('; ')

    const result = await runClaude({...baseOptions, onEvent: event => events.push(event)}, fakeClaude(script))

    expect(result).toMatchObject({ok: true, resultText: 'final answer', sessionId: 'sess-e2e'})
    expect(events).toEqual([
      {kind: 'session', sessionId: 'sess-e2e'},
      {kind: 'activity', label: 'km: get_block'},
      {kind: 'text', text: 'partial'},
    ])
  })
})
