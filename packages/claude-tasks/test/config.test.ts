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
