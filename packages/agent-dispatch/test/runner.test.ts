import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  BILLING_ENV_DENYLIST,
  buildClaudeArgs,
  unexpectedClaudeInventory,
  formatRunUsage,
  createStreamJsonParser,
  runClaude,
  scrubEnv,
  type AgentRunOptions,
  type RunEvent,
  type SpawnImpl,
} from '../src/runner'
import {WORKSPACE_APPROVED_TOOLS, WORKSPACE_TOOLS, workspaceTmpDir} from '../src/workspace'

const baseOptions: AgentRunOptions = {
  claudeBin: 'claude',
  prompt: 'do the thing',
  allowedTools: [],
  timeoutMs: 5_000,
}

describe('buildClaudeArgs', () => {
  it('builds a print-mode stream-json run WITHOUT the prompt in argv (stdin carries it)', () => {
    expect(buildClaudeArgs(baseOptions)).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--setting-sources', 'project,local', '--strict-mcp-config',
      '--disable-slash-commands', '--tools', '',
    ])
  })

  it('threads resume/model/effort/mcp/tools through, pinning strict mcp config', () => {
    const args = buildClaudeArgs({
      ...baseOptions,
      resumeSessionId: 'sess-1',
      model: 'claude-sonnet-5',
      effort: 'high',
      mcpConfig: {path: 'dispatch.json', serverNames: ['km']},
      allowedTools: ['mcp__km__get_block', 'mcp__km__search'],
    })
    expect(args).toEqual([
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages', '--setting-sources', 'project,local', '--strict-mcp-config',
      '--resume', 'sess-1',
      '--model', 'claude-sonnet-5',
      '--effort', 'high',
      '--mcp-config', 'dispatch.json',
      '--disable-slash-commands', '--tools', '',
      '--allowedTools', 'mcp__km__get_block,mcp__km__search',
    ])
  })

  it('offers only the built-in tools the run may use, named without their permission patterns', () => {
    const args = buildClaudeArgs({
      ...baseOptions,
      allowedTools: ['mcp__km__search', 'WebSearch', 'Bash(git *)', 'Bash(ls)', 'Read', 'Agent', 'KillShell'],
    })
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2))
      .toEqual(['--tools', 'WebSearch,Bash,Read,Agent,KillShell'])
  })

  it('keeps skills and slash commands off while the allow list leaves Skill out', () => {
    const args = buildClaudeArgs({...baseOptions, allowedTools: ['mcp__km__search', 'Bash', 'Read']})
    expect(args).toContain('--disable-slash-commands')
  })

  it('lets a run whose allow list names Skill load skills', () => {
    const args = buildClaudeArgs({...baseOptions, allowedTools: ['mcp__km__search', 'Bash', 'Skill']})
    expect(args).not.toContain('--disable-slash-commands')
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash,Skill')
  })

  describe('in a workspace', () => {
    const workspace = {root: '/ws/notes-agent', allowedDomains: []}
    const args = buildClaudeArgs({
      ...baseOptions,
      cwd: '/ws/notes-agent/threads/b1',
      workspace,
      allowedTools: ['mcp__km__search', 'WebFetch', 'Bash(git *)', 'Write', 'Read'],
    })
    const value = (flag: string) => args[args.indexOf(flag) + 1]

    it('confines the file tools and ignores settings files the run could write', () => {
      expect(args).toContain('--restricted')
      expect(value('--add-dir')).toBe('/ws/notes-agent')
    })

    it('carries the sandbox and its grants in one settings document', () => {
      const settings = JSON.parse(value('--settings'))
      expect(settings.permissions.allow).toEqual(WORKSPACE_APPROVED_TOOLS)
      expect(settings.sandbox).toMatchObject({enabled: true, allowUnsandboxedCommands: false})
    })

    it('hides every credential Claude Code may hold from sandboxed commands', () => {
      const names = JSON.parse(value('--settings')).sandbox.credentials.envVars.map((entry: {name: string}) => entry.name)
      expect(names).toEqual(expect.arrayContaining([...BILLING_ENV_DENYLIST, 'CLAUDE_CODE_OAUTH_TOKEN']))
    })

    it('offers the workspace tools, and leaves their grants out of --allowedTools', () => {
      // A grant there would survive a dropped settings document and run Bash unsandboxed.
      expect(value('--tools').split(',')).toEqual(expect.arrayContaining(['WebFetch', ...WORKSPACE_TOOLS]))
      expect(value('--allowedTools').split(',')).toEqual(['mcp__km__search', 'WebFetch', 'Read'])
    })

    it.each(['Read,Bash', 'WebFetch Bash', 'Bash(git *) ', 'Read(./a),Bash(x)'])(
      'keeps a grant out of --allowedTools even inside a malformed rule: %j',
      rule => {
        // Claude Code splits --allowedTools on commas and spaces.
        const allowed = buildClaudeArgs({...baseOptions, cwd: '/ws/notes-agent', workspace, allowedTools: [rule, 'Read']})
        expect(allowed[allowed.indexOf('--allowedTools') + 1]).toBe('Read')
      },
    )

    it('starts a new thread under the session id that names its folder', () => {
      const started = buildClaudeArgs({...baseOptions, cwd: '/ws/notes-agent/threads/s1', workspace, newSessionId: 's1'})
      expect(started[started.indexOf('--session-id') + 1]).toBe('s1')
    })

    it('tells the run where its workspace is', () => {
      expect(value('--append-system-prompt')).toContain('/ws/notes-agent/threads/b1')
    })
  })
})

describe('unexpectedClaudeInventory', () => {
  const intended = {acceptedBuiltIns: new Set(['Read']), serverNames: ['fixture']}
  const server = {name: 'fixture', source: 'dynamic'}
  const clean = {tools: ['Read', 'mcp__fixture__lookup'], mcp_servers: [server], plugins: [{source: 'fixture@builtin'}]}

  it('accepts a requested built-in and tools of a configured server', () => {
    expect(unexpectedClaudeInventory(clean, intended)).toEqual([])
  })

  it.each([
    ['extra built-in', {...clean, tools: ['Read', 'Edit']}, 'Edit'],
    ['extra MCP tool', {...clean, tools: ['mcp__fixture2__lookup']}, 'mcp__fixture2__lookup'],
    ['extra server', {...clean, mcp_servers: [{name: 'other', source: 'dynamic'}]}, 'other'],
    ['unexpected source for an expected server', {...clean, mcp_servers: [{...server, source: 'plugin'}]}, 'fixture'],
    ['missing tools', {mcp_servers: []}, 'tools'],
    ['missing servers', {tools: []}, 'mcp_servers'],
    ['missing plugins', {tools: [], mcp_servers: []}, 'plugins'],
    ['malformed plugin', {...clean, plugins: [null]}, 'plugin'],
    ['missing plugin source', {...clean, plugins: [{name: 'fixture'}]}, 'source'],
    ['malformed tool', {...clean, tools: [null]}, 'tool'],
    ['malformed server', {...clean, mcp_servers: [null]}, 'server'],
  ] as const)('reports %s', (_, init, detail) => {
    expect(unexpectedClaudeInventory(init, intended).join(' ')).toContain(detail)
  })
})

describe('formatRunUsage', () => {
  it('summarizes the counts compactly for a log line', () => {
    expect(formatRunUsage({inputTokens: 244, cacheReadTokens: 25_134_938, cacheWriteTokens: 983_213, outputTokens: 95_722}))
      .toBe('tokens: in 244 · cache read 25.1M · cache write 983.2k · out 95.7k')
  })

  it('leaves out a cache-write count the executor does not report', () => {
    expect(formatRunUsage({inputTokens: 11_485, cacheReadTokens: 2432, cacheWriteTokens: null, outputTokens: 20}))
      .toBe('tokens: in 11.5k · cache read 2.4k · out 20')
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

  it('starts finalized tool uses by step id and ends valid tool results', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))
    const tool = (id: string) => {
      const item = {type: 'tool_use', id, name: 'mcp__km__comments'}
      parser.feed(line({type: 'assistant', message: {content: [item]}}))
    }
    const result = (id: string) => parser.feed(line({type: 'user', message: {content: [
      null, {type: 'tool_result', tool_use_id: id, content: 'result'},
    ]}}))
    tool('tool-1')
    tool('tool-2')
    parser.feed(line({type: 'user', message: {content: [
      null,
      {type: 'tool_result', tool_use_id: 42, content: 'bad id'},
      {type: 'tool_result', tool_use_id: ['tool-1'], content: 'bad id'},
      {type: 'tool_result', tool_use_id: '', content: 'empty id'},
      {type: 'text', tool_use_id: 'tool-1'},
      {type: 'tool_result', content: 'missing id'},
    ]}}))
    result('tool-1')
    result('tool-1')
    result('tool-2')
    expect(events).toEqual([
      {kind: 'activity', label: 'km: comments', stepId: 'tool-1'},
      {kind: 'activity', label: 'km: comments', stepId: 'tool-2'},
      {kind: 'activity-end', stepId: 'tool-1'},
      {kind: 'activity-end', stepId: 'tool-1'},
      {kind: 'activity-end', stepId: 'tool-2'},
    ])
  })

  it('does not start streamed tool_use until the finalized assistant message', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))
    const contentBlock = {type: 'tool_use', id: 'tool-streamed', name: 'mcp__km__comments'}
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_start', content_block: contentBlock}}))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_delta', delta: {
      type: 'input_json_delta', partial_json: '{"query":"a long streamed argument"}',
    }}}))
    expect(events).toEqual([])

    parser.feed(line({type: 'assistant', message: {content: [contentBlock]}}))
    expect(events).toEqual([{kind: 'activity', label: 'km: comments', stepId: 'tool-streamed'}])
  })

  it('never starts an orphaned streamed tool_use', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_start', content_block: {
      type: 'tool_use', id: 'tool-orphan', name: 'mcp__km__comments',
    }}}))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_delta', delta: {
      type: 'input_json_delta', partial_json: '{"query":"an incomplete call"}',
    }}}))
    expect(parser.finish()).toBeNull()
    expect(events).toEqual([])
  })

  it('ignores finalized tool uses with missing, empty, or malformed ids or names', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))
    for (const item of [
      {type: 'tool_use', name: 'WebSearch'},
      {type: 'tool_use', id: '', name: 'WebSearch'},
      {type: 'tool_use', id: 42, name: 'WebSearch'},
      {type: 'tool_use', id: 'tool-1', name: ''},
      {type: 'tool_use', id: 'tool-2', name: 42},
    ]) parser.feed(line({type: 'assistant', message: {content: [item]}}))
    expect(events).toEqual([])
  })

  it('full happy path: init -> tool_use activity -> text deltas cumulative -> result', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))

    parser.feed(line({type: 'system', subtype: 'init', session_id: 'sess-1'}))
    parser.feed(line({
      type: 'stream_event',
      event: {type: 'content_block_start', content_block: {type: 'tool_use', id: 'tool-get-block', name: 'mcp__km__get_block'}},
    }))
    parser.feed(line({type: 'stream_event', event: {type: 'message_start'}}))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'Hel'}}}))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'lo'}}}))
    parser.feed(line({type: 'result', result: 'Hello', session_id: 'sess-1', is_error: false}))

    expect(events).toEqual([
      {kind: 'session', sessionId: 'sess-1'},
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

  it('the last result line wins: a run that waited on a background subagent ends with a second one', () => {
    const parser = createStreamJsonParser()
    parser.feed(line({type: 'result', result: 'Launched the agent; I will reply when it returns.', session_id: 's', is_error: false}))
    parser.feed(line({type: 'result', result: 'The final answer', session_id: 's', is_error: false}))
    expect(parser.finish()).toMatchObject({resultText: 'The final answer'})
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

  it('a multi-text-block assistant summary never shrinks the delta-built cumulative text', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))

    // A web-search turn is one message with TWO text blocks around the
    // server tool call. The deltas build the full running text; the
    // finalized summary re-lists the blocks and must NOT rewind it.
    parser.feed(line({type: 'stream_event', event: {type: 'message_start'}}))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'Let me search'}}}))
    parser.feed(line({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'the answer'}}}))
    parser.feed(line({type: 'assistant', message: {content: [
      {type: 'text', text: 'Let me search'},
      {type: 'tool_use', id: 'tool-search', name: 'WebSearch'},
      {type: 'text', text: 'the answer'},
    ]}}))

    const textEvents = events.filter(e => e.kind === 'text').map(e => (e as {text: string}).text)
    // Monotonic and complete — the last streamed text is the FULL answer,
    // never the trailing block alone ('the answer').
    expect(textEvents).toEqual(['Let me search', 'Let me searchthe answer'])
    // The summary still drives the activity chip from its tool_use block.
    expect(events).toContainEqual({kind: 'activity', label: 'Searching the web', stepId: 'tool-search'})
  })

  it('a multi-text-block summary still delivers full text when no deltas fired', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))

    // No partial-message deltas — the summary is the only text source.
    parser.feed(line({type: 'assistant', message: {content: [
      {type: 'text', text: 'Alpha'},
      {type: 'tool_use', id: 'tool-search', name: 'WebSearch'},
      {type: 'text', text: 'Omega'},
    ]}}))

    const textEvents = events.filter(e => e.kind === 'text').map(e => (e as {text: string}).text)
    expect(textEvents).toEqual(['AlphaOmega'])
  })

  it('humanizes tool names, including the mcp__km__ mapping', () => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event))

    parser.feed(line({type: 'assistant', message: {content: [
      {type: 'tool_use', id: 'tool-search', name: 'mcp__km__search'},
      {type: 'tool_use', id: 'tool-web-search', name: 'WebSearch'},
      {type: 'tool_use', id: 'tool-web-fetch', name: 'WebFetch'},
      {type: 'tool_use', id: 'tool-bash', name: 'Bash'},
    ]}}))

    expect(events).toEqual([
      {kind: 'activity', label: 'km: search', stepId: 'tool-search'},
      {kind: 'activity', label: 'Searching the web', stepId: 'tool-web-search'},
      {kind: 'activity', label: 'Fetching a page', stepId: 'tool-web-fetch'},
      {kind: 'activity', label: 'Bash', stepId: 'tool-bash'},
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
const fakeProcess = (script: string): SpawnImpl =>
  ((_bin: string, _args: readonly string[], options: object) =>
    spawn(process.execPath, ['-e', script], options)) as SpawnImpl

/** Write a single stream-json JSONL result line (mirrors real `claude`
 *  `--output-format stream-json` output). */
const streamResult = (obj: Record<string, unknown>) =>
  `process.stdout.write(JSON.stringify(${JSON.stringify(obj)}) + '\\n')`

const cleanInit = {type: 'system', subtype: 'init', tools: [], mcp_servers: [], plugins: []}
const fakeClaude = (script: string): SpawnImpl => fakeProcess(streamResult(cleanInit) + '; ' + script)

describe('runClaude', () => {
  it.each([
    ['unexpected inventory', {...cleanInit, session_id: 'refused', tools: ['NewBuiltin']}, 'NewBuiltin'],
    ['non-builtin plugin', {...cleanInit, session_id: 'refused', plugins: [{source: 'fixture@builtin-extra'}]}, 'fixture@builtin-extra'],
    ['assistant with hook subtype before init', {type: 'assistant', subtype: 'hook_started'}, 'before'],
    ['task before init', {type: 'system', subtype: 'task_started'}, 'before'],
    ['result before init', {type: 'result', result: 'early'}, 'before'],
  ])('kills the child on %s before another event arrives', async (_, first, detail) => {
    const events: RunEvent[] = []
    const script = streamResult(first as Record<string, unknown>) + '; setInterval(() => {}, 60_000)'
    const result = await runClaude({...baseOptions, onEvent: event => events.push(event)}, fakeProcess(script))
    expect(result).toMatchObject({ok: false, timedOut: false, exitCode: null, resultText: '', sessionId: null})
    expect(result.stderr).toContain(detail)
    expect(result.stderr).toContain('managed settings')
    expect(events).toEqual([])
  })

  it('keeps waiting for init through startup hook notifications', async () => {
    const hooks = ['hook_started', 'hook_progress', 'hook_response'].map(subtype => streamResult({type: 'system', subtype}))
    const final = streamResult({type: 'result', result: 'ok'})
    const run = (...tail: string[]) => runClaude(baseOptions, fakeProcess([...hooks, ...tail].join('; ')))
    expect((await run(streamResult(cleanInit), final)).ok).toBe(true)
    expect((await run(final)).stderr).toContain('before a validated init')
  })

  it('rejects a changed inventory at EOF even after a success result', async () => {
    const result = await runClaude(baseOptions, fakeClaude([
      streamResult({type: 'result', result: 'earlier turn', session_id: 'previous'}),
      `process.stdout.write(JSON.stringify(${JSON.stringify({...cleanInit, tools: ['Unrequested']})}))`,
    ].join('; ')))
    expect(result).toMatchObject({ok: false, exitCode: 0, resultText: '', sessionId: null})
    expect(result.stderr).toContain('Unrequested')
  })

  it.each(['\n', ''])('discards a buffered session after refusal with terminator %j', terminator => {
    const events: RunEvent[] = []
    const parser = createStreamJsonParser(event => events.push(event), {acceptedBuiltIns: new Set<string>(), serverNames: []})
    const refused = JSON.stringify({...cleanInit, tools: ['Extra']})
    const buffered = JSON.stringify({...cleanInit, session_id: 'late'})
    parser.feed(`${refused}\n${buffered}${terminator}`)
    parser.finish()
    expect(events).toEqual([])
  })

  it('keeps recovery instructions visible when the engine truncates a long error', async () => {
    const tools = Array.from({length: 100}, (_, index) => `Unexpected${index}`)
    const result = await runClaude(baseOptions, fakeProcess(streamResult({...cleanInit, tools})))
    expect(result.stderr.slice(0, 500)).toContain('CLI')
    expect(result.stderr.slice(0, 500)).toContain('Unexpected0')
    expect(result.stderr).toContain('Unexpected99')
  })

  it('refuses an unconfigured MCP tool even when a spaced rule names it', async () => {
    const name = 'mcp__extra__marker'
    const result = await runClaude({...baseOptions, allowedTools: [` ${name} `]}, fakeProcess(
      streamResult({...cleanInit, tools: [name]}),
    ))
    expect(result.stderr).toContain(name)
  })

  const toolUse = (name: string) => ({type: 'tool_use', id: 'step', name})
  const streamed = (block: unknown) => ({type: 'stream_event', event: {type: 'content_block_start', content_block: block}})
  const assistant = (...content: unknown[]) => ({type: 'assistant', message: {content}})

  it.each([
    ['streamed unconfigured MCP tool', streamed(toolUse('mcp__other__marker')), 'mcp__other__marker'],
    ['finalized unrequested built-in', assistant(toolUse('Task'), toolUse('Write')), 'Write'],
    ['malformed streamed request', streamed({type: 'tool_use'}), 'malformed tool name'],
    ['alias for an unrequested tool', assistant(toolUse('TaskStop')), 'TaskStop'],
  ])('kills on %s after a clean init, before delivering activity', async (_, event, name) => {
    const events: RunEvent[] = []
    const result = await runClaude({...baseOptions, allowedTools: ['Agent'], onEvent: e => events.push(e)}, fakeProcess([
      streamResult({...cleanInit, tools: ['Task']}),
      streamResult(event as Record<string, unknown>),
      'setInterval(() => {}, 60_000)',
    ].join('; ')))
    expect(result).toMatchObject({ok: false, timedOut: false, exitCode: null, sessionId: null})
    expect(result.stderr).toContain(name)
    expect(events).toEqual([])
  })

  it('ignores non-tool blocks and payloads outside tool request events', () => {
    const other = toolUse('Unused')
    const parser = createStreamJsonParser(undefined, {acceptedBuiltIns: new Set<string>(), serverNames: []})
    const records = [
      cleanInit,
      assistant(null, {type: 'text', text: 'ok'}, {type: 'server_tool_use', name: 'server_operation'}),
      {type: 'assistant', message: {content: 'text'}},
      {type: 'assistant', message: null},
      {type: 'system', event: {type: 'content_block_start', content_block: other}},
      {type: 'stream_event', event: {type: 'content_block_delta', content_block: other}},
      {type: 'result', result: 'ok'},
    ]
    for (const record of records) expect(parser.feed(JSON.stringify(record) + '\n')).toBe(true)
    expect(parser.finish()?.resultText).toBe('ok')
  })

  it('accepts Task at init and Agent during a background subagent call', async () => {
    const init = {...cleanInit, session_id: 'parent', tools: ['Task']}
    const events: RunEvent[] = []
    const script = [
      init,
      streamed(toolUse('Agent')),
      assistant(toolUse('Agent')),
      {type: 'result', result: 'Subagent launched'},
      init,
      {type: 'result', result: 'hi'},
    ].map(streamResult).join('; ')
    const result = await runClaude({...baseOptions, allowedTools: ['Agent'], onEvent: event => events.push(event)}, fakeProcess(script))
    expect(result).toMatchObject({ok: true, resultText: 'hi'})
    expect(events.map(event => event.kind)).toEqual(['session', 'activity', 'session'])
  })

  it('accepts reported aliases and configured MCP tools at init and during use', async () => {
    const tools = ['Task', 'TaskStop', 'WebFetch', 'WebSearch', 'mcp__km__marker']
    const script = [
      {...cleanInit, tools, mcp_servers: [{name: 'km', source: 'dynamic'}]},
      ...tools.flatMap(name => [streamed(toolUse(name)), assistant(toolUse(name))]),
      {type: 'result', result: 'ok'},
    ].map(streamResult).join('; ')
    const result = await runClaude({...baseOptions, allowedTools: ['Agent', 'KillShell', 'WebFetch', 'WebSearch'],
      mcpConfig: {path: 'dispatch.json', serverNames: ['km']}}, fakeProcess(script))
    expect(result.ok).toBe(true)
  })

  it('accepts the server names passed with the generated config', async () => {
    const result = await runClaude({
      ...baseOptions, allowedTools: ['Read'], mcpConfig: {path: 'dispatch.json', serverNames: ['fixture']},
    }, fakeProcess([
      streamResult({...cleanInit, tools: ['Read', 'mcp__fixture__lookup'], mcp_servers: [{name: 'fixture', source: 'dynamic'}]}),
      streamResult({type: 'result', result: 'ok'}),
    ].join('; ')))
    expect(result.ok).toBe(true)
  })

  it.each(['subscription', 'api'] as const)('removes inherited plugin directories with %s billing', async billing => {
    const result = await runClaude({
      ...baseOptions, billing, env: {...process.env, CLAUDE_CODE_PLUGIN_DIRS: 'synthetic'},
    }, fakeClaude("console.log(JSON.stringify({type: 'result', result: String('CLAUDE_CODE_PLUGIN_DIRS' in process.env)}))"))
    expect(result.resultText).toBe('false')
  })

  it('reports the run\'s token usage from the result line', async () => {
    const result = await runClaude(baseOptions, fakeClaude(streamResult({
      type: 'result', result: 'hi', session_id: 's1', is_error: false,
      usage: {input_tokens: 4, cache_creation_input_tokens: 14625, cache_read_input_tokens: 14244, output_tokens: 34},
    })))
    expect(result.usage).toEqual({inputTokens: 4, cacheWriteTokens: 14625, cacheReadTokens: 14244, outputTokens: 34})
  })

  it('totals usage over the whole process — every model and subagent — from modelUsage', async () => {
    // A background subagent makes claude emit a result line per parent turn;
    // each line's `usage` covers that turn only, while `modelUsage` is the
    // process-wide total.
    const result = await runClaude(baseOptions, fakeClaude(streamResult({
      type: 'result', result: 'hi', session_id: 's1', is_error: false,
      usage: {input_tokens: 2, cache_creation_input_tokens: 723, cache_read_input_tokens: 18720, output_tokens: 12},
      modelUsage: {
        'claude-opus-5-5': {inputTokens: 6, cacheReadInputTokens: 37_032, cacheCreationInputTokens: 33_302, outputTokens: 1132},
        'claude-haiku-5-5': {inputTokens: 4, cacheReadInputTokens: 100, cacheCreationInputTokens: 200, outputTokens: 30},
      },
    })))
    expect(result.usage).toEqual({inputTokens: 10, cacheReadTokens: 37_132, cacheWriteTokens: 33_502, outputTokens: 1162})
  })

  it('reports no usage when the result line carries none', async () => {
    const result = await runClaude(baseOptions, fakeClaude(
      streamResult({type: 'result', result: 'hi', session_id: 's1', is_error: false}),
    ))
    expect(result.usage).toBeNull()
  })

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

  it('kills an in-flight run when its abort signal fires (Stop)', async () => {
    // A child that would hang for a minute — the abort must kill it well
    // before the (60s) timeout, so timedOut stays false. Without the abort
    // handling this run never returns and the test times out.
    const controller = new AbortController()
    const running = runClaude(
      {...baseOptions, timeoutMs: 60_000, signal: controller.signal},
      fakeClaude(`process.stdout.write('x'); setTimeout(() => {}, 60_000)`),
    )
    setTimeout(() => controller.abort(), 150)
    const result = await running
    expect(controller.signal.aborted).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.timedOut).toBe(false) // killed by abort, not the timeout
  })

  it('retains the session id from a run killed before the result line', async () => {
    // The init line arrives, then the child hangs and is killed — no result
    // line. The (billed) session id must still come back so a retry can
    // --resume it. Killed once the init line is seen, so the kill can never
    // land before it.
    const controller = new AbortController()
    const result = await runClaude(
      {
        ...baseOptions,
        timeoutMs: 60_000,
        signal: controller.signal,
        onEvent: event => { if (event.kind === 'session') controller.abort() },
      },
      fakeProcess(`${streamResult({...cleanInit, session_id: 'sess-killed'})}; setTimeout(() => {}, 60_000)`),
    )
    expect(result.ok).toBe(false)
    expect(result.sessionId).toBe('sess-killed')
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

  it('billing=api opts in: the credential env is passed through, not scrubbed', async () => {
    const result = await runClaude(
      {...baseOptions, billing: 'api', env: {...process.env, ANTHROPIC_API_KEY: 'sk-live'}},
      fakeClaude(
        `process.stdout.write(JSON.stringify({type: 'result', result: process.env.ANTHROPIC_API_KEY ?? 'clean', session_id: 's', is_error: false}) + '\\n')`,
      ),
    )
    expect(result.resultText).toBe('sk-live')
  })

  describe('in a workspace', () => {
    let root: string
    beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'km-runner-ws-')) })
    afterEach(async () => {
      await fs.rm(root, {recursive: true, force: true})
      await fs.rm(workspaceTmpDir(root), {recursive: true, force: true})
    })

    it('creates its folder and passes only the workspace environment', async () => {
      const cwd = path.join(root, 'threads', 'b1')
      const result = await runClaude(
        {...baseOptions, cwd, workspace: {root, allowedDomains: []}, env: {...process.env, GITHUB_TOKEN: 'ghp-leak', CLAUDE_CODE_OAUTH_TOKEN: 'oauth'}},
        fakeClaude(
          `process.stdout.write(JSON.stringify({type: 'result', result: JSON.stringify([process.cwd(), process.env.GITHUB_TOKEN ?? null, process.env.CLAUDE_CODE_TMPDIR, process.env.CLAUDE_CODE_OAUTH_TOKEN]), session_id: 's', is_error: false}) + '\\n')`,
        ),
      )
      // The subscription sign-in still reaches Claude Code; the settings hide it from Bash.
      expect(JSON.parse(result.resultText)).toEqual([await fs.realpath(cwd), null, workspaceTmpDir(root), 'oauth'])
    })

    it('stops a run that started anywhere but its folder', async () => {
      // A concurrent run can swap the folder for a link between the check and the spawn.
      const result = await runClaude(
        {...baseOptions, cwd: path.join(root, 'threads', 'b1'), workspace: {root, allowedDomains: []}, timeoutMs: 10_000},
        fakeClaude(
          // An inventory of the workspace's tools, which the run is offered beyond its allow list.
          `process.stdout.write(JSON.stringify(${JSON.stringify({...cleanInit, tools: WORKSPACE_TOOLS, session_id: 's', cwd: '/elsewhere'})}) + '\\n'); setTimeout(() => {}, 60_000)`,
        ),
      )
      expect(result).toMatchObject({ok: false, timedOut: false})
      // Named without paths: the failure note is a synced reply block.
      expect(result.stderr).toContain('did not start in its thread folder')
      expect(result.stderr).not.toContain('/elsewhere')
    })
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
      streamResult({...cleanInit, session_id: 'sess-e2e', tools: ['mcp__km__get_block'], mcp_servers: [{name: 'km', source: 'dynamic'}]}),
      streamResult({type: 'assistant', message: {content: [{type: 'tool_use', id: 'tool-get-block', name: 'mcp__km__get_block'}]}}),
      streamResult({type: 'stream_event', event: {type: 'message_start'}}),
      streamResult({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'partial'}}}),
      streamResult({type: 'result', result: 'final answer', session_id: 'sess-e2e', is_error: false}),
    ].join('; ')

    const result = await runClaude({...baseOptions, mcpConfig: {path: 'dispatch.json', serverNames: ['km']}, onEvent: event => events.push(event)}, fakeProcess(script))

    expect(result).toMatchObject({ok: true, resultText: 'final answer', sessionId: 'sess-e2e'})
    expect(events).toEqual([
      {kind: 'session', sessionId: 'sess-e2e'},
      {kind: 'activity', label: 'km: get_block', stepId: 'tool-get-block'},
      {kind: 'text', text: 'partial'},
    ])
  })
})
