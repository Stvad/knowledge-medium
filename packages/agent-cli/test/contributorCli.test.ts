import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {execFile} from 'node:child_process'
import http from 'node:http'
import {AddressInfo} from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cliScript = path.resolve(here, '../dist/cli.js')

interface StubBridge {
  baseUrl: string
  commands: Array<Record<string, unknown>>
  close: () => Promise<void>
}

const startStubBridge = async (): Promise<StubBridge> => {
  const commands: Array<Record<string, unknown>> = []
  let nextCommandId = 1
  const results = new Map<string, unknown>()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, {'content-type': 'application/json'})
        res.end(JSON.stringify(value))
      }
      if (req.method === 'GET' && req.url === '/health') return send(200, {ok: true})
      if (req.method === 'GET' && req.url === '/runtime/whoami') {
        return send(200, {
          clientId: 'client-1',
          audience: {userId: 'user-1', workspaceId: 'workspace-1', label: 'stub'},
          scope: 'read-write',
          connected: true,
          clientLastSeen: Date.now(),
        })
      }
      if (req.method === 'POST' && req.url === '/runtime/commands') {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        commands.push(command)
        const id = `command-${nextCommandId++}`
        results.set(id, command.type === 'create-contributor'
          ? {id: 'contributor-1', name: command.name, kind: command.kind ?? 'agent', workspaceId: command.workspaceId}
          : command.type === 'list-contributors'
            ? {contributors: [{id: 'contributor-1', name: 'Researcher', kind: 'agent', workspaceId: command.workspaceId}]}
            : {id: 'page-1', created: true})
        return send(202, {id})
      }
      const commandMatch = req.method === 'GET' && req.url?.match(/^\/runtime\/commands\/([^/]+)$/)
      if (commandMatch) {
        const id = decodeURIComponent(commandMatch[1]!)
        return send(200, {
          id,
          status: 'completed',
          result: {ok: true, value: results.get(id)},
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
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    commands,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

let tempDir: string
let tokenFile: string
let selectionDir: string
let bridge: StubBridge

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-runtime-contributor-cli-'))
  tokenFile = path.join(tempDir, 'agent-token.json')
  selectionDir = path.join(tempDir, 'selections')
  await fs.writeFile(tokenFile, JSON.stringify({profiles: {default: {token: 'STUB-TOKEN'}}}))
  bridge = await startStubBridge()
})

afterEach(async () => {
  await bridge.close()
  await fs.rm(tempDir, {recursive: true, force: true})
})

const runCli = (args: string[]) => execFileAsync(process.execPath, [cliScript, ...args], {
  env: {
    ...process.env,
    AGENT_RUNTIME_PROFILE: '',
    AGENT_RUNTIME_TOKEN: '',
    AGENT_RUNTIME_TOKEN_FILE: tokenFile,
    AGENT_RUNTIME_CONTRIBUTOR_DIR: selectionDir,
    AGENT_RUNTIME_URL: bridge.baseUrl,
  },
})

describe('compiled CLI contributor commands', {timeout: 30_000}, () => {
  it('dispatches list/create/use and applies the saved choice to a later write', async () => {
    const listResult = await runCli(['contributor', 'list'])
    expect(JSON.parse(listResult.stdout)).toMatchObject({contributors: [{id: 'contributor-1'}]})

    const createResult = await runCli(['contributor', 'create', 'Researcher', '--kind', 'agent', '--role', 'Research'])
    expect(JSON.parse(createResult.stdout)).toMatchObject({id: 'contributor-1', selected: true})

    const useResult = await runCli(['contributor', 'use', 'contributor-1'])
    expect(JSON.parse(useResult.stdout)).toMatchObject({
      profile: 'default', workspaceId: 'workspace-1', contributorId: 'contributor-1',
    })

    await runCli(['create-page', 'Inbox'])

    expect(bridge.commands.map(command => command.type)).toEqual([
      'list-contributors', 'create-contributor', 'list-contributors', 'create-page',
    ])
    expect(bridge.commands.slice(0, 3).map(command => command.workspaceId)).toEqual([
      'workspace-1', 'workspace-1', 'workspace-1',
    ])
    expect(bridge.commands[1]).toMatchObject({name: 'Researcher', kind: 'agent', role: 'Research'})
    expect(bridge.commands[3]).toMatchObject({
      workspaceId: 'workspace-1', contributorId: 'contributor-1', name: 'Inbox',
    })
  })

  it('prints contributor-specific help for the supported single command', async () => {
    const {stdout} = await runCli(['contributor', 'create', '--help'])
    expect(stdout).toContain('contributor <action> [value]')
    expect(stdout).toContain('--kind <kind>')
  })
})
