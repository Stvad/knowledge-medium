import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {execFile} from 'node:child_process'
import http from 'node:http'
import {AddressInfo} from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'
import {saveContributorSelection} from '@knowledge-medium/agent-cli/config'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const daemonScript = path.resolve(here, '../dist/daemon.js')

let tempDir: string
let configPath: string
let tokenFile: string
let selectionDir: string
let bridge: http.Server
let bridgeUrl: string
const requests: string[] = []
const commands: Array<Record<string, unknown>> = []
/** Set, the stub serves `source-1` as a pending mention whose properties
 *  follow the daemon's writes, so a run gets claimed and replied to; unset, it
 *  serves a running block with a cancel no run owns. */
let pendingMention: Record<string, unknown> | null = null

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dispatch-selection-'))
  configPath = path.join(tempDir, 'dispatch.json')
  tokenFile = path.join(tempDir, 'tokens.json')
  selectionDir = path.join(tempDir, 'contributors')
  requests.length = 0
  commands.length = 0
  pendingMention = null
  await fs.writeFile(tokenFile, JSON.stringify({profiles: {'dispatch-test': {token: 'STUB-TOKEN'}}}))
  await fs.writeFile(configPath, JSON.stringify({
    profile: 'dispatch-test',
    workspaceId: 'workspace-test',
    push: false,
    watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude'}],
  }))

  bridge = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`)
      const send = (status: number, value: unknown) => {
        res.writeHead(status, {'content-type': 'application/json'})
        res.end(JSON.stringify(value))
      }
      if (req.method === 'GET' && req.url === '/runtime/whoami') {
        return send(200, {
          clientId: 'client-1',
          audience: {userId: 'user-1', workspaceId: 'workspace-test', label: 'test'},
          scope: 'read-write',
          connected: true,
          clientLastSeen: Date.now(),
        })
      }
      if (req.method === 'POST' && req.url === '/runtime/commands') {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        commands.push(command)
        if (pendingMention && command.type === 'update-block') {
          Object.assign(pendingMention, command.properties as Record<string, unknown>)
        }
        return send(202, {id: `command-${commands.length}`})
      }
      const commandMatch = req.method === 'GET' && req.url?.match(/^\/runtime\/commands\/([^/]+)$/)
      if (commandMatch) {
        const command = commands[Number(commandMatch[1]!.slice('command-'.length)) - 1]
        const mention = pendingMention && command?.type === 'get-block'
          ? {id: 'source-1', content: '[[claude]] x', properties: pendingMention, userUpdatedAt: 1}
          : pendingMention && command?.type === 'sql' && String(command.sql).includes('edited_at')
            ? [{id: 'source-1', properties_json: JSON.stringify(pendingMention), edited_at: 1}]
            : pendingMention && command?.type === 'sql'
              ? []
              : undefined
        const value = mention !== undefined ? mention : command?.type === 'page'
          ? {match: {id: 'page-1'}}
          : command?.type === 'backlinks'
            ? {backlinks: [{id: 'source-1', deepLink: 'link:source-1', content: '[[claude]]'}]}
            : command?.type === 'sql' && String(command.sql).includes('properties_json')
              ? [{id: 'source-1', properties_json: '{"agent:cancel":true,"agent:status":"running"}', edited_at: 1}]
              : []
        return send(200, {
          id: commandMatch[1],
          status: 'completed',
          result: {ok: true, value},
          clientId: 'client-1',
          targetClientId: 'client-1',
          createdAt: 1,
          deliveredAt: 2,
          completedAt: 3,
        })
      }
      return send(404, {error: 'not found'})
    })
  })
  await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve))
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>(resolve => bridge.close(() => resolve()))
  await fs.rm(tempDir, {recursive: true, force: true})
  vi.unstubAllEnvs()
})

/** Kills a daemon that never exits. A run is a cold node start plus a few HTTP
 *  round trips to the stub bridge in this process: ~130ms alone, but up to
 *  ~5.5s with three gates on the machine, far past the usual 3-6x. Sized at
 *  ~3.5x that, and below the describe's budget. */
const DAEMON_KILL_MS = 20_000

const runDaemon = async () => execFileAsync(process.execPath, [daemonScript, '--config', configPath, '--once'], {
  timeout: DAEMON_KILL_MS,
  env: {
    ...process.env,
    AGENT_RUNTIME_CONFIG_DIR: tempDir,
    AGENT_RUNTIME_CONTRIBUTOR_DIR: selectionDir,
    AGENT_RUNTIME_TOKEN_FILE: tokenFile,
    AGENT_RUNTIME_URL: bridgeUrl,
  },
})

describe('dispatch contributor selection', {timeout: DAEMON_KILL_MS + 10_000}, () => {
  it('uses the normalized profile for both token lookup and saved contributor selection', async () => {
    vi.stubEnv('AGENT_RUNTIME_CONTRIBUTOR_DIR', selectionDir)
    await saveContributorSelection('dispatch-test', 'workspace-test', 'contributor-agent')
    const statePath = path.join(tempDir, 'state.json')
    await fs.writeFile(configPath, JSON.stringify({
      profile: '  dispatch-test  ',
      workspaceId: 'workspace-test',
      statePath,
      push: false,
      watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude'}],
    }))
    await fs.writeFile(statePath, JSON.stringify({backlinkBaselines: {mentions: 0}}))

    await runDaemon()

    const mcpConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'agent-dispatch-mcp.json'), 'utf8'))
    expect(mcpConfig.mcpServers.km.env).toMatchObject({AGENT_RUNTIME_CONTRIBUTOR_ID: 'contributor-agent'})
    expect(mcpConfig.mcpServers.km.alwaysLoad).toBe(true)
    // The token was found: the run reached the bridge.
    expect(commands.map(command => command.type)).toContain('update-block')
  })

  it('refuses an unset exact profile/workspace selection before bridge or pidfile startup', async () => {
    // An unrelated choice must not become a fallback for this daemon.
    vi.stubEnv('AGENT_RUNTIME_CONTRIBUTOR_DIR', selectionDir)
    await saveContributorSelection('another-profile', 'workspace-test', 'wrong-profile-id')
    await saveContributorSelection('dispatch-test', 'another-workspace', 'wrong-workspace-id')

    const result = await runDaemon()

    expect(result.stderr).toContain('No contributor selection saved for profile "dispatch-test" and workspace "workspace-test"')
    expect(result.stderr).toContain('kmagent --profile dispatch-test contributor use <id|none> --workspace workspace-test')
    expect(requests).toEqual([])
    await expect(fs.access(path.join(tempDir, 'agent-dispatch.pid'))).rejects.toMatchObject({code: 'ENOENT'})
  })

  it('clears disabled watcher registration without a contributor or attributed command', async () => {
    await fs.writeFile(configPath, JSON.stringify({
      profile: 'dispatch-test',
      workspaceId: 'workspace-test',
      push: false,
      watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude', disabled: true}],
    }))

    const result = await runDaemon()

    expect(result.stdout).toContain('no active watchers')
    expect(result.stdout).toContain('push: watch-events registration cleared')
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({type: 'watch-events', consumer: 'agent-dispatch', watchers: []})
    expect(commands[0]).not.toHaveProperty('contributorId')
    expect(requests).not.toContain('GET /runtime/whoami')
    await expect(fs.access(path.join(tempDir, 'agent-dispatch.pid'))).rejects.toMatchObject({code: 'ENOENT'})
  })

  it.each([
    ['saved id', 'contributor-agent'],
    ['explicit none', null],
  ] as const)('attributes the agent\'s reply to the %s, and its bookkeeping to no one', async (_label, selected) => {
    vi.stubEnv('AGENT_RUNTIME_CONTRIBUTOR_DIR', selectionDir)
    await saveContributorSelection('dispatch-test', 'workspace-test', selected)
    const statePath = path.join(tempDir, 'state.json')
    await fs.writeFile(configPath, JSON.stringify({
      profile: 'dispatch-test',
      workspaceId: 'workspace-test',
      statePath,
      push: false,
      // Fails at once, so the run ends in the daemon's reply note.
      claudeBin: '/usr/bin/false',
      watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude'}],
    }))
    await fs.writeFile(statePath, JSON.stringify({backlinkBaselines: {mentions: 0}}))
    pendingMention = {}

    await runDaemon()

    const replies = commands.filter(command => command.type === 'reconcile-markdown-subtree')
    expect(replies.length).toBeGreaterThan(0)
    for (const reply of replies) expect(reply).toMatchObject({parentId: 'source-1', contributorId: selected})
    const bookkeeping = commands.filter(command => command.type === 'update-block')
    expect(bookkeeping.map(command => (command.properties as Record<string, unknown>)['agent:status']))
      .toEqual(['running', 'error'])
    for (const write of bookkeeping) expect(write).toMatchObject({id: 'source-1', contributorId: null})
  })

  it.each([
    ['saved id', 'contributor-agent', 'contributor-agent'],
    ['explicit none', null, 'none'],
  ] as const)('passes the %s choice to the spawned MCP server', async (_label, selected, expected) => {
    vi.stubEnv('AGENT_RUNTIME_CONTRIBUTOR_DIR', selectionDir)
    await saveContributorSelection('dispatch-test', 'workspace-test', selected)
    const statePath = path.join(tempDir, 'state.json')
    await fs.writeFile(configPath, JSON.stringify({
      profile: 'dispatch-test',
      workspaceId: 'workspace-test',
      statePath,
      push: false,
      watchers: [{kind: 'backlinks', name: 'mentions', target: 'claude'}],
    }))
    await fs.writeFile(statePath, JSON.stringify({backlinkBaselines: {mentions: 0}}))

    await runDaemon()

    const mcpConfig = JSON.parse(await fs.readFile(path.join(tempDir, 'agent-dispatch-mcp.json'), 'utf8'))
    expect(mcpConfig.mcpServers.km.env).toMatchObject({
      AGENT_RUNTIME_PROFILE: 'dispatch-test',
      AGENT_RUNTIME_WORKSPACE: 'workspace-test',
      AGENT_RUNTIME_CONTRIBUTOR_ID: expected,
    })
    // Bookkeeping on the source block is unattributed whatever the choice; the
    // choice attributes the agent's own writes (dispatchAttribution.test.ts).
    const update = commands.find(command => command.type === 'update-block')
    expect(update).toMatchObject({
      type: 'update-block',
      id: 'source-1',
      properties: {'agent:cancel': ''},
      contributorId: null,
    })
    expect(commands.map(command => command.type)).not.toContain('create-block')
  })
})
