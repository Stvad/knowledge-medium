import {describe, expect, it} from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {configSchema, parseConfig} from '../src/config'

describe('parseConfig', () => {
  it('refuses a channel port fetch will not connect to', () => {
    // `new URL` accepts these, so only the request fails — locally and
    // identically every time, which the retry path reads as a transport
    // outage and defers forever. Caught HERE so it reports as the config
    // error it is (clean exit, no launchd restart loop) and is found while
    // reading the config, even when no watcher uses channel delivery.
    expect(() => parseConfig({watchers: [], channelPort: 6000})).toThrow(/refuses to connect/)
    expect(() => parseConfig({watchers: [], channelPort: 70_000})).toThrow()
    expect(parseConfig({watchers: [], channelPort: 8791}).channelPort).toBe(8791)
  })

  it('applies defaults for a minimal mention-watcher config', () => {
    const config = parseConfig({
      workspaceId: 'ws-test',
      watchers: [{kind: 'backlinks', name: 'claude-mentions', target: 'claude'}],
    })

    expect(config.profile).toBe('agent-dispatch')
    expect(config.pollIntervalMs).toBe(5_000)
    expect(config.maxConcurrent).toBe(2)
    expect(config.billing).toBe('subscription') // safe default
    const watcher = config.watchers[0]
    expect(watcher).toMatchObject({
      kind: 'backlinks',
      target: 'claude',
      resume: true,
      runner: {
        executor: 'claude',
        allowedTools: [],
        timeoutMs: 10 * 60_000,
      },
    })
  })

  it('rejects unknown watcher kinds and missing fields', () => {
    expect(() => parseConfig({workspaceId: 'ws-test', watchers: [{kind: 'webhook', name: 'x'}]})).toThrow()
    expect(() => parseConfig({workspaceId: 'ws-test', watchers: [{kind: 'query', name: 'q'}]})).toThrow()
  })

  it('rejects query-watcher SQL that is not read-only (would execute on every poll)', () => {
    const query = (sql: string) => ({workspaceId: 'ws-test', watchers: [{kind: 'query', name: 'q', sql}]})
    expect(() => parseConfig(query('UPDATE blocks SET content = ? RETURNING id'))).toThrow(/read-only/)
    expect(() => parseConfig(query('WITH c AS (SELECT 1) UPDATE blocks SET content = ? RETURNING id'))).toThrow(/read-only/)
    expect(() => parseConfig(query('SELECT powersync_clear(1)'))).toThrow(/read-only/)
    expect(parseConfig(query('SELECT id FROM blocks')).watchers).toHaveLength(1)
  })

  // Calls that name no workspace act on whichever one the user's focused app
  // tab has open; an unattended daemon must not move with them.
  it('requires the workspace the daemon acts on', () => {
    expect(() => parseConfig({watchers: []})).toThrow(/workspaceId is required/)
    expect(() => parseConfig({workspaceId: '  ', watchers: []})).toThrow(/workspaceId is required/)
    expect(parseConfig({workspaceId: ' ws-1 ', watchers: []}).workspaceId).toBe('ws-1')
  })

  it('rejects an invalid profile name at parse time (config error, not a launchd crash-loop)', () => {
    expect(() => parseConfig({workspaceId: 'ws-test', profile: 'bad name', watchers: []})).toThrow(/[Pp]rofile/)
  })

  it('rejects duplicate watcher names (they would silently share cursor/baseline state)', () => {
    expect(() => parseConfig({workspaceId: 'ws-test', watchers: [
      {kind: 'query', name: 'inbox', sql: 'SELECT id FROM a'},
      {kind: 'query', name: 'inbox', sql: 'SELECT id FROM b'},
    ]})).toThrow(/duplicate/i)
    expect(() => parseConfig({workspaceId: 'ws-test', watchers: [
      {kind: 'backlinks', name: 'same', target: 'claude'},
      {kind: 'query', name: 'same', sql: 'SELECT id FROM blocks'},
    ]})).toThrow(/duplicate/i)
  })

  it('filters disabled watchers out of the active runtime config', () => {
    const config = parseConfig({workspaceId: 'ws-test', watchers: [
      {kind: 'backlinks', name: 'old-mentions', target: 'old', disabled: true, runner: {executor: 'codex'}},
      {kind: 'backlinks', name: 'new-mentions', target: 'new'},
    ]})

    expect(config.configuredWatcherCount).toBe(2)
    expect(config.watchers).toHaveLength(1)
    expect(config.watchers[0]).toMatchObject({name: 'new-mentions', target: 'new'})
    expect(config.watchers[0]).not.toHaveProperty('disabled')
  })

  it('exports configSchema as the same active runtime schema parseConfig uses', () => {
    const config = configSchema.parse({workspaceId: 'ws-test', watchers: [
      {kind: 'backlinks', name: 'old-mentions', target: 'old', disabled: true},
      {kind: 'backlinks', name: 'new-mentions', target: 'new'},
    ]})

    expect(config.configuredWatcherCount).toBe(2)
    expect(config.watchers).toHaveLength(1)
    expect(config.watchers[0]).toMatchObject({name: 'new-mentions', target: 'new'})
    expect(config.watchers[0]).not.toHaveProperty('disabled')
  })

  it('rejects duplicate watcher names even when one watcher is disabled', () => {
    expect(() => parseConfig({workspaceId: 'ws-test', watchers: [
      {kind: 'backlinks', name: 'mentions', target: 'parked', disabled: true},
      {kind: 'backlinks', name: 'mentions', target: 'live'},
    ]})).toThrow(/duplicate/i)

    const directResult = configSchema.safeParse({workspaceId: 'ws-test', watchers: [
      {kind: 'backlinks', name: 'mentions', target: 'parked', disabled: true},
      {kind: 'backlinks', name: 'mentions', target: 'live'},
    ]})
    expect(directResult.success).toBe(false)
    if (!directResult.success) expect(directResult.error.issues[0]?.message).toMatch(/duplicate watcher name "mentions"/)
  })

  it('still validates disabled watchers as real watchers before filtering them out', () => {
    expect(() => parseConfig({workspaceId: 'ws-test', watchers: [
      {kind: 'query', name: 'parked-query', disabled: true},
    ]})).toThrow()
    expect(() => parseConfig({workspaceId: 'ws-test', watchers: [
      {kind: 'query', name: 'parked-query', disabled: true, sql: 'UPDATE blocks SET content = ? RETURNING id'},
    ]})).toThrow(/read-only/)
  })

  it('rejects misspelled keys instead of silently dropping them', () => {
    expect(() => parseConfig({workspaceId: 'ws-test', maxconcurrent: 5, watchers: []})).toThrow()
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{kind: 'backlinks', name: 'm', target: 'claude', allowedtools: ['Bash']}],
    })).toThrow()
  })

  it('rejects old flat runner keys; runner-specific config must be nested', () => {
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{kind: 'backlinks', name: 'm', target: 'claude', executor: 'codex'}],
    })).toThrow()
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{kind: 'backlinks', name: 'm', target: 'claude', allowedTools: ['Bash']}],
    })).toThrow()
  })

  it('caps runner timeoutMs below the stale-running sweep window', () => {
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{kind: 'backlinks', name: 'm', target: 'claude', runner: {executor: 'claude', timeoutMs: 40 * 60_000}}],
    })).toThrow()
  })

  it('expands ~ in runner cwd, codex addDirs, and statePath', () => {
    const config = parseConfig({
      workspaceId: 'ws-test',
      statePath: '~/state.json',
      watchers: [{
        kind: 'backlinks',
        name: 'm',
        target: 'claude',
        runner: {
          executor: 'codex',
          cwd: '~/code/repo',
          sandbox: 'workspace-write',
          addDirs: ['~/tmp/agent-runs'],
        },
      }],
    })
    expect(config.statePath).toBe(path.join(os.homedir(), 'state.json'))
    expect(config.watchers[0].runner.cwd).toBe(path.join(os.homedir(), 'code/repo'))
    if (config.watchers[0].runner.executor === 'codex') {
      expect(config.watchers[0].runner.addDirs).toEqual([path.join(os.homedir(), 'tmp/agent-runs')])
    }
  })

  it('parses codex runner permissions explicitly', () => {
    const config = parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'backlinks',
        name: 'codex',
        target: 'codex',
        runner: {
          executor: 'codex',
          model: 'gpt-5-codex',
          sandbox: 'workspace-write',
          addDirs: ['/private/tmp'],
          networkAccess: true,
          approvalPolicy: 'on-request',
          approvalsReviewer: 'auto_review',
        },
      }],
    })
    expect(config.watchers[0].runner).toMatchObject({
      executor: 'codex',
      model: 'gpt-5-codex',
      timeoutMs: 10 * 60_000,
      sandbox: 'workspace-write',
      addDirs: ['/private/tmp'],
      networkAccess: true,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    })
  })

  it('rejects codex permission combinations the CLI cannot honor', () => {
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'backlinks',
        name: 'codex',
        target: 'codex',
        runner: {executor: 'codex', networkAccess: true},
      }],
    })).toThrow(/networkAccess/)
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'backlinks',
        name: 'codex',
        target: 'codex',
        runner: {executor: 'codex', addDirs: ['/private/tmp']},
      }],
    })).toThrow(/addDirs/)
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'backlinks',
        name: 'codex',
        target: 'codex',
        runner: {executor: 'codex', approvalPolicy: 'on-request'},
      }],
    })).toThrow(/approvalsReviewer/)
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'backlinks',
        name: 'codex',
        target: 'codex',
        runner: {executor: 'codex', approvalPolicy: 'untrusted'},
      }],
    })).toThrow()
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'backlinks',
        name: 'codex',
        target: 'codex',
        runner: {executor: 'codex', approvalsReviewer: 'auto_review'},
      }],
    })).toThrow(/approvalPolicy/)
  })

  it('rejects channel delivery for codex runners', () => {
    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'backlinks',
        name: 'codex-channel',
        target: 'codex',
        delivery: 'channel',
        runner: {executor: 'codex'},
      }],
    })).toThrow(/Codex has no channel transport/)

    expect(() => parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'query',
        name: 'codex-query-channel',
        sql: 'SELECT id FROM blocks',
        delivery: 'channel',
        runner: {executor: 'codex'},
      }],
    })).toThrow(/Codex has no channel transport/)

    expect(parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'backlinks',
        name: 'claude-channel',
        target: 'claude',
        delivery: 'channel',
        runner: {executor: 'claude'},
      }],
    }).watchers[0]).toMatchObject({delivery: 'channel', runner: {executor: 'claude'}})
  })

  it('accepts an explicit opt-in to usage-based billing', () => {
    expect(parseConfig({workspaceId: 'ws-test', billing: 'api', watchers: []}).billing).toBe('api')
    expect(() => parseConfig({workspaceId: 'ws-test', billing: 'wallet', watchers: []})).toThrow()
  })

  it('parses query watchers with params', () => {
    const config = parseConfig({
      workspaceId: 'ws-test',
      watchers: [{
        kind: 'query',
        name: 'inbox-growth',
        sql: 'SELECT id FROM blocks WHERE parent_id = ?',
        params: ['inbox-id'],
      }],
    })
    expect(config.watchers[0]).toMatchObject({kind: 'query', params: ['inbox-id']})
  })
})
