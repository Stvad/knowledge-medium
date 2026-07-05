import {describe, expect, it} from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {parseConfig} from '../src/config'

describe('parseConfig', () => {
  it('applies defaults for a minimal mention-watcher config', () => {
    const config = parseConfig({
      watchers: [{kind: 'backlinks', name: 'claude-mentions', target: 'claude'}],
    })

    expect(config.profile).toBe('claude-tasks')
    expect(config.pollIntervalMs).toBe(5_000)
    expect(config.maxConcurrent).toBe(2)
    expect(config.billing).toBe('subscription') // safe default
    const watcher = config.watchers[0]
    expect(watcher).toMatchObject({
      kind: 'backlinks',
      target: 'claude',
      resume: true,
      allowedTools: [],
    })
  })

  it('rejects unknown watcher kinds and missing fields', () => {
    expect(() => parseConfig({watchers: [{kind: 'webhook', name: 'x'}]})).toThrow()
    expect(() => parseConfig({watchers: [{kind: 'query', name: 'q'}]})).toThrow()
  })

  it('rejects query-watcher SQL that is not read-only (would execute on every poll)', () => {
    const query = (sql: string) => ({watchers: [{kind: 'query', name: 'q', sql}]})
    expect(() => parseConfig(query('UPDATE blocks SET content = ? RETURNING id'))).toThrow(/read-only/)
    expect(() => parseConfig(query('WITH c AS (SELECT 1) UPDATE blocks SET content = ? RETURNING id'))).toThrow(/read-only/)
    expect(() => parseConfig(query('SELECT powersync_clear(1)'))).toThrow(/read-only/)
    expect(parseConfig(query('SELECT id FROM blocks')).watchers).toHaveLength(1)
  })

  it('rejects an invalid profile name at parse time (config error, not a launchd crash-loop)', () => {
    expect(() => parseConfig({profile: 'bad name', watchers: []})).toThrow(/[Pp]rofile/)
  })

  it('rejects duplicate watcher names (they would silently share cursor/baseline state)', () => {
    expect(() => parseConfig({watchers: [
      {kind: 'query', name: 'inbox', sql: 'SELECT id FROM a'},
      {kind: 'query', name: 'inbox', sql: 'SELECT id FROM b'},
    ]})).toThrow(/duplicate/i)
    expect(() => parseConfig({watchers: [
      {kind: 'backlinks', name: 'same', target: 'claude'},
      {kind: 'query', name: 'same', sql: 'SELECT id FROM blocks'},
    ]})).toThrow(/duplicate/i)
  })

  it('filters disabled watchers out of the active runtime config', () => {
    const config = parseConfig({watchers: [
      {kind: 'backlinks', name: 'old-mentions', target: 'old', disabled: true, executor: 'codex'},
      {kind: 'backlinks', name: 'new-mentions', target: 'new'},
    ]})

    expect(config.watchers).toHaveLength(1)
    expect(config.watchers[0]).toMatchObject({name: 'new-mentions', target: 'new'})
  })

  it('does not count disabled watchers when checking active watcher name uniqueness', () => {
    const config = parseConfig({watchers: [
      {kind: 'backlinks', name: 'mentions', target: 'parked', disabled: true},
      {kind: 'backlinks', name: 'mentions', target: 'live'},
    ]})

    expect(config.watchers).toHaveLength(1)
    expect(config.watchers[0]).toMatchObject({name: 'mentions', target: 'live'})
  })

  it('rejects misspelled keys instead of silently dropping them', () => {
    expect(() => parseConfig({maxconcurrent: 5, watchers: []})).toThrow()
    expect(() => parseConfig({
      watchers: [{kind: 'backlinks', name: 'm', target: 'claude', allowedtools: ['Bash']}],
    })).toThrow()
  })

  it('caps timeoutMs below the stale-running sweep window', () => {
    expect(() => parseConfig({
      watchers: [{kind: 'backlinks', name: 'm', target: 'claude', timeoutMs: 40 * 60_000}],
    })).toThrow()
  })

  it('expands ~ in watcher cwd and statePath', () => {
    const config = parseConfig({
      statePath: '~/state.json',
      watchers: [{kind: 'backlinks', name: 'm', target: 'claude', cwd: '~/code/repo'}],
    })
    expect(config.statePath).toBe(path.join(os.homedir(), 'state.json'))
    expect(config.watchers[0].cwd).toBe(path.join(os.homedir(), 'code/repo'))
  })

  it('accepts an explicit opt-in to usage-based billing', () => {
    expect(parseConfig({billing: 'api', watchers: []}).billing).toBe('api')
    expect(() => parseConfig({billing: 'wallet', watchers: []})).toThrow()
  })

  it('parses query watchers with params', () => {
    const config = parseConfig({
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
