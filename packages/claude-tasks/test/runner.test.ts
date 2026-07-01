import {describe, expect, it} from 'vitest'
import {spawn} from 'node:child_process'
import {
  BILLING_ENV_DENYLIST,
  buildClaudeArgs,
  parseClaudeJson,
  runClaude,
  scrubEnv,
  type ClaudeRunOptions,
  type SpawnImpl,
} from '../src/runner'

const baseOptions: ClaudeRunOptions = {
  claudeBin: 'claude',
  prompt: 'do the thing',
  allowedTools: [],
  timeoutMs: 5_000,
}

describe('buildClaudeArgs', () => {
  it('builds a print-mode json run', () => {
    expect(buildClaudeArgs(baseOptions)).toEqual(['-p', 'do the thing', '--output-format', 'json'])
  })

  it('threads resume/model/mcp/tools through', () => {
    const args = buildClaudeArgs({
      ...baseOptions,
      resumeSessionId: 'sess-1',
      model: 'claude-sonnet-5',
      mcpConfigPath: '/tmp/km.json',
      allowedTools: ['mcp__km__get_block', 'mcp__km__search'],
    })
    expect(args).toEqual([
      '-p', 'do the thing',
      '--output-format', 'json',
      '--resume', 'sess-1',
      '--model', 'claude-sonnet-5',
      '--mcp-config', '/tmp/km.json',
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
      HOME: '/Users/x',
    })
    expect(env).toEqual({PATH: '/usr/bin', HOME: '/Users/x'})
    for (const key of BILLING_ENV_DENYLIST) expect(env).not.toHaveProperty(key)
  })
})

describe('parseClaudeJson', () => {
  it('extracts result + session id from the json envelope', () => {
    const parsed = parseClaudeJson(JSON.stringify({
      type: 'result',
      result: 'Done: created 3 blocks',
      session_id: 'sess-42',
      is_error: false,
    }))
    expect(parsed).toMatchObject({resultText: 'Done: created 3 blocks', sessionId: 'sess-42', isError: false})
  })

  it('tolerates noise around the JSON object and flags errors', () => {
    const parsed = parseClaudeJson(`some warning\n${JSON.stringify({result: 'x', is_error: true})}\n`)
    expect(parsed).toMatchObject({resultText: 'x', isError: true})
    expect(parseClaudeJson('not json at all')).toBeNull()
  })
})

/** Run the real runner against a scripted `node -e` child. */
const fakeClaude = (script: string): SpawnImpl =>
  ((_bin: string, _args: readonly string[], options: object) =>
    spawn(process.execPath, ['-e', script], options)) as SpawnImpl

describe('runClaude', () => {
  it('returns ok with parsed result on a clean run', async () => {
    const result = await runClaude(baseOptions, fakeClaude(
      `process.stdout.write(JSON.stringify({result: 'hi', session_id: 's1', is_error: false}))`,
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
      `process.stdout.write(JSON.stringify({result: 'refused', is_error: true}))`,
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

  it('scrubs billing vars from the child environment', async () => {
    const result = await runClaude(
      {...baseOptions, env: {...process.env, ANTHROPIC_API_KEY: 'sk-leak'}},
      fakeClaude(
        `process.stdout.write(JSON.stringify({result: process.env.ANTHROPIC_API_KEY ?? 'clean', session_id: 's'}))`,
      ),
    )
    expect(result.resultText).toBe('clean')
  })
})
