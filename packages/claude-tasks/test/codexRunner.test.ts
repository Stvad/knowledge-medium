import {describe, expect, it} from 'vitest'
import {spawn} from 'node:child_process'
import {
  buildCodexArgs,
  CODEX_BILLING_ENV_DENYLIST,
  createCodexJsonlParser,
  runCodex,
  scrubCodexEnv,
  type CodexRunOptions,
  type SpawnImpl,
} from '../src/codexRunner'
import type {RunEvent} from '../src/runner'

const baseOptions: CodexRunOptions = {
  codexBin: 'codex',
  prompt: 'do the thing',
  timeoutMs: 5_000,
}

describe('buildCodexArgs', () => {
  it('builds a fresh read-only exec run WITHOUT the prompt in argv (stdin carries it, "-" last)', () => {
    const args = buildCodexArgs(baseOptions)
    expect(args).toEqual([
      'exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '--ignore-user-config', '-',
    ])
    expect(args.at(-1)).toBe('-')
  })

  it('threads resume/model through', () => {
    const args = buildCodexArgs({
      ...baseOptions,
      resumeSessionId: 'thread-1',
      model: 'gpt-5-codex',
    })
    expect(args).toEqual([
      'exec', 'resume', 'thread-1',
      '--json', '-s', 'read-only', '--skip-git-repo-check', '--ignore-user-config',
      '-m', 'gpt-5-codex',
      '-',
    ])
  })

  it('injects the km MCP server via -c overrides with valid JSON values, "-" still last', () => {
    const args = buildCodexArgs({
      ...baseOptions,
      mcpServer: {
        name: 'km',
        command: '/usr/bin/node',
        args: ['/path/to/mcp.js'],
        env: {AGENT_RUNTIME_PROFILE: 'claude-tasks'},
      },
    })
    expect(args.at(-1)).toBe('-')

    const cIndices = args.flatMap((arg, i) => (arg === '-c' ? [i] : []))
    expect(cIndices).toHaveLength(3)
    const overrides = cIndices.map(i => args[i + 1])

    const commandOverride = overrides.find(o => o.startsWith('mcp_servers.km.command='))
    const argsOverride = overrides.find(o => o.startsWith('mcp_servers.km.args='))
    const envOverride = overrides.find(o => o.startsWith('mcp_servers.km.env='))
    expect(commandOverride).toBeDefined()
    expect(argsOverride).toBeDefined()
    expect(envOverride).toBeDefined()

    expect(commandOverride).toBe('mcp_servers.km.command="/usr/bin/node"')
    expect(JSON.parse(argsOverride!.slice('mcp_servers.km.args='.length))).toEqual(['/path/to/mcp.js'])
    expect(JSON.parse(envOverride!.slice('mcp_servers.km.env='.length))).toEqual({AGENT_RUNTIME_PROFILE: 'claude-tasks'})
  })
})

describe('scrubCodexEnv', () => {
  it('removes billing-redirecting vars and keeps the rest', () => {
    const env = scrubCodexEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-api',
      OPENAI_BASE_URL: 'https://proxy.example',
      HOME: '/Users/x',
    })
    expect(env).toEqual({PATH: '/usr/bin', HOME: '/Users/x'})
    for (const key of CODEX_BILLING_ENV_DENYLIST) expect(env).not.toHaveProperty(key)
  })
})

describe('createCodexJsonlParser', () => {
  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`

  it('replays the REAL success transcript verbatim', () => {
    const events: RunEvent[] = []
    const parser = createCodexJsonlParser(event => events.push(event))

    parser.feed(line({type: 'thread.started', thread_id: '019f2a7e-1ba0-70b3-8292-61528d38f840'}))
    parser.feed(line({type: 'turn.started'}))
    parser.feed(line({type: 'item.completed', item: {id: 'item_0', type: 'agent_message', text: 'ok'}}))
    parser.feed(line({
      type: 'turn.completed',
      usage: {input_tokens: 13917, cached_input_tokens: 2432, output_tokens: 20, reasoning_output_tokens: 13},
    }))

    expect(events).toEqual([
      {kind: 'session', sessionId: '019f2a7e-1ba0-70b3-8292-61528d38f840'},
      {kind: 'text', text: 'ok'},
    ])

    const result = parser.finish()
    expect(result).toMatchObject({
      resultText: 'ok',
      sessionId: '019f2a7e-1ba0-70b3-8292-61528d38f840',
      isError: false,
      sawTurnCompleted: true,
      failed: false,
    })
  })

  it('replays the REAL failure transcript verbatim (exit code 1)', () => {
    const events: RunEvent[] = []
    const parser = createCodexJsonlParser(event => events.push(event))

    parser.feed(line({type: 'thread.started', thread_id: 'thread-fail'}))
    parser.feed(line({type: 'turn.started'}))
    parser.feed(line({type: 'error', message: '{"type":"error","status":400,"foo":"bar"}'}))
    parser.feed(line({type: 'turn.failed', error: {message: '{"type":"error","status":400,"foo":"bar"}'}}))

    expect(events).toEqual([
      {kind: 'session', sessionId: 'thread-fail'},
    ])

    const result = parser.finish()
    expect(result.isError).toBe(true)
    expect(result.failed).toBe(true)
    expect(result.sawTurnCompleted).toBe(false)
    expect(result.errorMessage).toBe('{"type":"error","status":400,"foo":"bar"}')
    expect(result.resultText).toBe('')
  })

  it('tolerates unknown/unobserved item types without throwing', () => {
    const events: RunEvent[] = []
    const parser = createCodexJsonlParser(event => events.push(event))

    expect(() => {
      parser.feed(line({type: 'thread.started', thread_id: 't1'}))
      parser.feed(line({type: 'item.started', item: {id: 'item_1', type: 'reasoning'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_1', type: 'reasoning'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_2', type: 'command_execution', command: 'ls'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_3', type: 'web_search', query: 'foo'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_4', type: 'mcp_tool_call', tool: 'mcp__km__search'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_5', type: 'some_brand_new_type', whatever: true}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_6', type: 'agent_message', text: 'done'}}))
      parser.feed(line({type: 'turn.completed', usage: {}}))
    }).not.toThrow()

    // Dedup is the ENGINE's job (see engine.ts's `lastActivity` gate) —
    // the parser just emits, so item.started + item.completed for the
    // SAME reasoning item both surface as an activity event here.
    expect(events).toEqual([
      {kind: 'session', sessionId: 't1'},
      {kind: 'activity', label: 'Thinking'},
      {kind: 'activity', label: 'Thinking'},
      {kind: 'activity', label: 'Running a command'},
      {kind: 'activity', label: 'Searching the web'},
      {kind: 'activity', label: 'km: search'},
      {kind: 'text', text: 'done'},
    ])
    expect(parser.finish()).toMatchObject({resultText: 'done', isError: false})
  })

  it('resume re-emits thread.started with the SAME thread id (session continuity)', () => {
    const events: RunEvent[] = []
    const parser = createCodexJsonlParser(event => events.push(event))

    parser.feed(line({type: 'thread.started', thread_id: 'same-thread-id'}))
    parser.feed(line({type: 'turn.started'}))
    parser.feed(line({type: 'item.completed', item: {type: 'agent_message', text: 'follow-up reply'}}))
    parser.feed(line({type: 'turn.completed', usage: {}}))

    expect(events[0]).toEqual({kind: 'session', sessionId: 'same-thread-id'})
    expect(parser.finish().sessionId).toBe('same-thread-id')
  })

  it('never throws from feed or finish, and tolerates a throwing onEvent handler', () => {
    const parser = createCodexJsonlParser(() => { throw new Error('consumer bug') })
    expect(() => parser.feed(line({type: 'thread.started', thread_id: 't'}))).not.toThrow()
    expect(() => parser.feed(line({type: 'item.completed', item: {type: 'agent_message', text: 'x'}}))).not.toThrow()
    expect(() => parser.feed('not json at all\n')).not.toThrow()
    expect(() => parser.feed(line({type: 'turn.completed', usage: {}}))).not.toThrow()
    expect(parser.finish()).toMatchObject({resultText: 'x', isError: false})
  })

  it('finish() flushes a trailing unterminated line', () => {
    const parser = createCodexJsonlParser()
    parser.feed(JSON.stringify({type: 'turn.completed', usage: {}}))
    expect(parser.finish()).toMatchObject({sawTurnCompleted: true, isError: false})
  })
})

/** Run the real runner against a scripted `node -e` child (mirrors
 *  runner.test.ts's fakeClaude pattern). */
const fakeCodex = (script: string): SpawnImpl =>
  ((_bin: string, _args: readonly string[], options: object) =>
    spawn(process.execPath, ['-e', script], options)) as SpawnImpl

const jsonlResult = (obj: Record<string, unknown>) =>
  `process.stdout.write(JSON.stringify(${JSON.stringify(obj)}) + '\\n')`

describe('runCodex', () => {
  it('returns ok with parsed result on a clean run', async () => {
    const script = [
      jsonlResult({type: 'thread.started', thread_id: 'sess-1'}),
      jsonlResult({type: 'item.completed', item: {type: 'agent_message', text: 'hi'}}),
      jsonlResult({type: 'turn.completed', usage: {}}),
    ].join('; ')

    const result = await runCodex(baseOptions, fakeCodex(script))
    expect(result).toMatchObject({ok: true, resultText: 'hi', sessionId: 'sess-1', exitCode: 0})
  })

  it('fails on nonzero exit and captures stderr', async () => {
    const result = await runCodex(baseOptions, fakeCodex(
      `process.stderr.write('boom'); process.exit(1)`,
    ))
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('boom')
  })

  it('fails when turn.failed is seen even with exit 0, surfacing the error message via stderr', async () => {
    const script = [
      jsonlResult({type: 'thread.started', thread_id: 'sess-2'}),
      jsonlResult({type: 'error', message: 'bad request'}),
      jsonlResult({type: 'turn.failed', error: {message: 'bad request'}}),
    ].join('; ')

    const result = await runCodex(baseOptions, fakeCodex(script))
    expect(result.ok).toBe(false)
    expect(result.stderr).toBe('bad request')
  })

  it('kills runs that exceed the timeout', async () => {
    const result = await runCodex(
      {...baseOptions, timeoutMs: 300},
      fakeCodex(`setTimeout(() => {}, 60_000)`),
    )
    expect(result.timedOut).toBe(true)
    expect(result.ok).toBe(false)
  })

  it('scrubs OPENAI_API_KEY from the child environment', async () => {
    const result = await runCodex(
      {...baseOptions, env: {...process.env, OPENAI_API_KEY: 'sk-leak'}},
      fakeCodex(
        `process.stdout.write(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: process.env.OPENAI_API_KEY ?? 'clean'}}) + '\\n');
         process.stdout.write(JSON.stringify({type: 'turn.completed', usage: {}}) + '\\n')`,
      ),
    )
    expect(result.resultText).toBe('clean')
  })

  it('delivers the prompt over stdin, not argv', async () => {
    const result = await runCodex(
      {...baseOptions, prompt: 'secret note content'},
      fakeCodex(
        `let input = '';
         process.stdin.on('data', chunk => { input += chunk });
         process.stdin.on('end', () => {
           const inArgv = process.argv.join(' ').includes('secret note content')
           process.stdout.write(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: inArgv ? 'LEAKED-TO-ARGV' : input}}) + '\\n')
           process.stdout.write(JSON.stringify({type: 'turn.completed', usage: {}}) + '\\n')
         })`,
      ),
    )
    expect(result.resultText).toBe('secret note content')
  })
})
