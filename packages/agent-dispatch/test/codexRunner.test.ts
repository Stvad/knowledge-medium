import {describe, expect, it} from 'vitest'
import {spawn} from 'node:child_process'
import {
  buildCodexArgs,
  CODEX_BILLING_ENV_DENYLIST,
  codexUsageFrom,
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

  it('threads resume/model and codex permissions through', () => {
    const args = buildCodexArgs({
      ...baseOptions,
      resumeSessionId: 'thread-1',
      model: 'gpt-5-codex',
      sandbox: 'workspace-write',
      addDirs: ['/private/tmp', '/repo/worktree'],
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    })
    expect(args).toEqual([
      'exec',
      '--json', '-s', 'workspace-write', '--skip-git-repo-check', '--ignore-user-config',
      '--add-dir', '/private/tmp',
      '--add-dir', '/repo/worktree',
      '-c', 'sandbox_workspace_write.network_access=true',
      '-c', 'approval_policy="on-request"',
      '-c', 'approvals_reviewer="auto_review"',
      '-m', 'gpt-5-codex',
      'resume',
      'thread-1',
      '-',
    ])
  })

  it('injects the km MCP server via -c overrides as TOML-compatible values, "-" still last', () => {
    const args = buildCodexArgs({
      ...baseOptions,
      mcpServer: {
        name: 'km',
        command: '/usr/bin/node',
        args: ['/path/to/mcp.js'],
        // Blocked-wikilinks value carries embedded quotes — the escaping
        // must survive TOML basic-string parsing.
        env: {AGENT_RUNTIME_PROFILE: 'agent-dispatch', KM_MCP_BLOCKED_WIKILINKS: '["claude"]'},
      },
    })
    expect(args.at(-1)).toBe('-')

    const cIndices = args.flatMap((arg, i) => (arg === '-c' ? [i] : []))
    expect(cIndices).toHaveLength(5)
    const overrides = cIndices.map(i => args[i + 1])

    // -c values parse as TOML: strings and string arrays are fine, but a
    // JSON object is NOT a TOML map — env must go as dotted per-key
    // overrides (live-verified failure: "expected a map"). The approval
    // mode is required for headless runs — without it every MCP call is
    // auto-cancelled ("user cancelled MCP tool call").
    expect(overrides).toEqual([
      'mcp_servers.km.command="/usr/bin/node"',
      'mcp_servers.km.args=["/path/to/mcp.js"]',
      'mcp_servers.km.default_tools_approval_mode="approve"',
      'mcp_servers.km.env.AGENT_RUNTIME_PROFILE="agent-dispatch"',
      'mcp_servers.km.env.KM_MCP_BLOCKED_WIKILINKS="[\\"claude\\"]"',
    ])
  })
})

describe('scrubCodexEnv', () => {
  it('removes every billing-redirecting credential var and keeps the rest', () => {
    const env = scrubCodexEnv({
      PATH: '/usr/bin',
      OPENAI_API_KEY: 'sk-api',
      OPENAI_BASE_URL: 'https://proxy.example',
      CODEX_API_KEY: 'sk-codex',
      CODEX_ACCESS_TOKEN: 'tok-codex',
      HOME: '/Users/x',
    })
    expect(env).toEqual({PATH: '/usr/bin', HOME: '/Users/x'})
    for (const key of CODEX_BILLING_ENV_DENYLIST) expect(env).not.toHaveProperty(key)
  })

  it('scrubs the codex-native credential vars (not just the OPENAI_* ones)', () => {
    // Regression: codex-cli reads CODEX_API_KEY / CODEX_ACCESS_TOKEN as
    // live credential sources ahead of the ChatGPT-plan OAuth session, so
    // an exported one would silently bill the API despite the scrub.
    expect(CODEX_BILLING_ENV_DENYLIST).toContain('CODEX_API_KEY')
    expect(CODEX_BILLING_ENV_DENYLIST).toContain('CODEX_ACCESS_TOKEN')
  })
})

describe('createCodexJsonlParser', () => {
  const line = (obj: unknown) => `${JSON.stringify(obj)}\n`

  it('preserves MCP server labels and fallback tool names for active items', () => {
    const events: RunEvent[] = []
    const parser = createCodexJsonlParser(event => events.push(event))
    const fields = [
      {tool: 'mcp__km__comments'},
      {server: '', tool: 'mcp__km__comments'},
      {server: 'km', toolName: 'comments'},
      {server: 'km', tool: ''},
      {server: 'km', tool: ['comments']},
      {server: 'km'},
      {server: 42, tool: 'mcp__km__comments'},
      {name: 'mcp__km__comments'},
      {},
    ]
    fields.forEach((fields, index) => parser.feed(line({type: 'item.started', item: {id: `step-${index}`, type: 'mcp_tool_call', ...fields}})))
    expect(events.map(event => event.kind === 'activity' ? event.label : null)).toEqual([
      'km: comments', 'km: comments', 'km: comments', 'km', 'km', 'km', 'km: comments', 'km: comments', 'Using a tool',
    ])
  })

  it('does not start completed tool items and ignores invalid step ids', () => {
    const events: RunEvent[] = []
    const parser = createCodexJsonlParser(event => events.push(event))
    for (const id of [undefined, '', 42]) {
      parser.feed(line({type: 'item.started', item: {id, type: 'mcp_tool_call', server: 'km', tool: 'comments'}}))
      parser.feed(line({type: 'item.updated', item: {id, type: 'command_execution'}}))
    }
    parser.feed(line({type: 'item.completed', item: {id: 'tool-1', type: 'mcp_tool_call', server: 'km', tool: 'comments'}}))
    parser.feed(line({type: 'item.completed', item: {id: 'tool-2', type: 'some_brand_new_type'}}))
    expect(events).toEqual([
      {kind: 'activity-end', stepId: 'tool-1'},
    ])
  })

  it('preserves step ids across repeated reports and emits completion for each completed item', () => {
    const events: RunEvent[] = []
    const parser = createCodexJsonlParser(event => events.push(event))
    for (const id of ['tool-1', 'tool-2']) {
      const item = {id, type: 'mcp_tool_call', server: 'km', tool: 'comments'}
      for (const type of ['item.started', 'item.updated', 'item.completed']) {
        parser.feed(line({type, item}))
      }
    }
    expect(events).toEqual([
      {kind: 'activity', label: 'km: comments', stepId: 'tool-1'},
      {kind: 'activity', label: 'km: comments', stepId: 'tool-1'},
      {kind: 'activity-end', stepId: 'tool-1'},
      {kind: 'activity', label: 'km: comments', stepId: 'tool-2'},
      {kind: 'activity', label: 'km: comments', stepId: 'tool-2'},
      {kind: 'activity-end', stepId: 'tool-2'},
    ])
  })

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
      sawTurnCompleted: true,
      failed: false,
    })
  })

  it('reads the run\'s token usage off turn.completed, where input_tokens includes the cached ones', () => {
    const parser = createCodexJsonlParser()
    parser.feed(line({
      type: 'turn.completed',
      usage: {input_tokens: 13917, cached_input_tokens: 2432, output_tokens: 20, reasoning_output_tokens: 13},
    }))
    expect(codexUsageFrom(parser.finish().raw))
      .toEqual({inputTokens: 11485, cacheReadTokens: 2432, cacheWriteTokens: null, outputTokens: 20})
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
    expect(result.failed).toBe(true)
    expect(result.sawTurnCompleted).toBe(false)
    expect(result.errorMessage).toBe('{"type":"error","status":400,"foo":"bar"}')
    expect(result.resultText).toBe('')
  })

  it('starts only known tool items while active, ignores reasoning, and ends completed tools', () => {
    const events: RunEvent[] = []
    const parser = createCodexJsonlParser(event => events.push(event))

    expect(() => {
      parser.feed(line({type: 'thread.started', thread_id: 't1'}))
      parser.feed(line({type: 'item.started', item: {id: 'item_1', type: 'reasoning'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_1', type: 'reasoning'}}))
      parser.feed(line({type: 'item.started', item: {id: 'item_2', type: 'command_execution', command: 'ls'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_2', type: 'command_execution', command: 'ls'}}))
      parser.feed(line({type: 'item.updated', item: {id: 'item_3', type: 'web_search', query: 'foo'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_3', type: 'web_search', query: 'foo'}}))
      parser.feed(line({type: 'item.started', item: {id: 'item_4', type: 'mcp_tool_call', tool: 'mcp__km__search'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_4', type: 'mcp_tool_call', tool: 'mcp__km__search'}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_5', type: 'some_brand_new_type', whatever: true}}))
      parser.feed(line({type: 'item.completed', item: {id: 'item_6', type: 'agent_message', text: 'done'}}))
      parser.feed(line({type: 'turn.completed', usage: {}}))
    }).not.toThrow()

    expect(events).toEqual([
      {kind: 'session', sessionId: 't1'},
      {kind: 'activity', label: 'Running a command', stepId: 'item_2'},
      {kind: 'activity-end', stepId: 'item_2'},
      {kind: 'activity', label: 'Searching the web', stepId: 'item_3'},
      {kind: 'activity-end', stepId: 'item_3'},
      {kind: 'activity', label: 'km: search', stepId: 'item_4'},
      {kind: 'activity-end', stepId: 'item_4'},
      {kind: 'text', text: 'done'},
    ])
    expect(parser.finish()).toMatchObject({resultText: 'done', sawTurnCompleted: true, failed: false})
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
    expect(parser.finish()).toMatchObject({resultText: 'x', sawTurnCompleted: true, failed: false})
  })

  it('finish() flushes a trailing unterminated line', () => {
    const parser = createCodexJsonlParser()
    parser.feed(JSON.stringify({type: 'turn.completed', usage: {}}))
    expect(parser.finish()).toMatchObject({sawTurnCompleted: true, failed: false})
  })

  it('accumulates multiple agent_message items in one turn (keeps the earlier one)', () => {
    const events: RunEvent[] = []
    const parser = createCodexJsonlParser(event => events.push(event))
    parser.feed(line({type: 'thread.started', thread_id: 't1'}))
    parser.feed(line({type: 'item.completed', item: {type: 'agent_message', text: 'first part'}}))
    parser.feed(line({type: 'item.completed', item: {type: 'agent_message', text: 'second part'}}))
    parser.feed(line({type: 'turn.completed', usage: {}}))

    expect(parser.finish().resultText).toBe('first part\n\nsecond part')
    // Cumulative contract: each text event carries the running total.
    expect(events.filter(e => e.kind === 'text')).toEqual([
      {kind: 'text', text: 'first part'},
      {kind: 'text', text: 'first part\n\nsecond part'},
    ])
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

  it('surfaces the structured error even when stderr carries unrelated noise', async () => {
    // codex logs warnings/update notices to stderr; the real failure
    // reason lives in the structured error line. The engine's ⚠️ reason
    // must show the latter, not be masked by the former.
    const script = [
      `process.stderr.write('warning: a new version of codex is available\\n')`,
      jsonlResult({type: 'turn.failed', error: {message: 'rate limit exceeded'}}),
    ].join('; ')

    const result = await runCodex(baseOptions, fakeCodex(script))
    expect(result.ok).toBe(false)
    expect(result.stderr).toContain('rate limit exceeded')
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

  it('billing=api opts in: OPENAI_API_KEY is passed through, not scrubbed', async () => {
    const result = await runCodex(
      {...baseOptions, billing: 'api', env: {...process.env, OPENAI_API_KEY: 'sk-live'}},
      fakeCodex(
        `process.stdout.write(JSON.stringify({type: 'item.completed', item: {type: 'agent_message', text: process.env.OPENAI_API_KEY ?? 'clean'}}) + '\\n');
         process.stdout.write(JSON.stringify({type: 'turn.completed', usage: {}}) + '\\n')`,
      ),
    )
    expect(result.resultText).toBe('sk-live')
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
