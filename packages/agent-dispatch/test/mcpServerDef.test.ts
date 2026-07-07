import {describe, expect, it} from 'vitest'
import path from 'node:path'
import {parseConfig} from '../src/config'
import {BLOCKED_WIKILINKS_ENV, decodeBlockedWikilinks} from '../src/blockedWikilinks'
import {buildMcpServerDef} from '../src/mcpServerDef'

describe('buildMcpServerDef', () => {
  it('uses the dispatch MCP wrapper and blocks active backlink watcher targets', () => {
    const config = parseConfig({
      profile: 'agent-dispatch',
      watchers: [
        {name: 'claude mentions', kind: 'backlinks', target: 'claude'},
        {name: 'codex mentions', kind: 'backlinks', target: 'codex'},
        {name: 'parked mentions', kind: 'backlinks', target: 'parked', disabled: true},
        {name: 'query watcher', kind: 'query', sql: 'SELECT id FROM blocks'},
      ],
    })

    const serverDef = buildMcpServerDef(config)

    expect(serverDef).toMatchObject({
      name: 'km',
      command: process.execPath,
      env: {AGENT_RUNTIME_PROFILE: 'agent-dispatch'},
    })
    expect(serverDef.args).toHaveLength(1)
    expect(path.basename(serverDef.args[0])).toBe('mcp.js')
    expect(serverDef.args[0]).toContain(`${path.sep}packages${path.sep}agent-dispatch${path.sep}`)
    expect(serverDef.args[0]).not.toContain(`${path.sep}packages${path.sep}agent-cli${path.sep}`)
    expect(decodeBlockedWikilinks(serverDef.env[BLOCKED_WIKILINKS_ENV])).toEqual(['claude', 'codex'])
  })
})
