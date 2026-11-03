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
  requests: string[]
  close: () => Promise<void>
}

const startStubBridge = async (): Promise<StubBridge> => {
  const commands: Array<Record<string, unknown>> = []
  const requests: string[] = []
  let nextCommandId = 1
  let nextContributorId = 1
  const results = new Map<string, unknown>()
  const contributors: Array<{id: string; name: string; kind: string; workspaceId: string}> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      requests.push(`${req.method} ${req.url}`)
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
        if (command.type === 'create-contributor') {
          const contributor = {
            id: `contributor-${nextContributorId++}`,
            name: String(command.name),
            kind: String(command.kind ?? 'agent'),
            workspaceId: String(command.workspaceId),
          }
          contributors.push(contributor)
          results.set(id, contributor)
        } else if (command.type === 'list-contributors') {
          results.set(id, {contributors: contributors.filter(item => item.workspaceId === command.workspaceId)})
        } else {
          results.set(id, {id: 'page-1', created: true})
        }
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
    requests,
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

const runCli = (args: string[], contributorEnv = '') => execFileAsync(process.execPath, [cliScript, ...args], {
  env: {
    ...process.env,
    AGENT_RUNTIME_PROFILE: '',
    AGENT_RUNTIME_TOKEN: '',
    AGENT_RUNTIME_TOKEN_FILE: tokenFile,
    AGENT_RUNTIME_CONTRIBUTOR_DIR: selectionDir,
    AGENT_RUNTIME_URL: bridge.baseUrl,
    AGENT_RUNTIME_CONTRIBUTOR_ID: contributorEnv,
  },
})

// A test runs up to seven compiled-CLI processes in sequence, each a cold node
// start plus a few HTTP round trips to the stub bridge: up to ~800ms a test
// alone, but up to ~38s with three gates on the machine, far past the usual
// 3-6x. Sized at ~3x that.
describe('compiled CLI contributor commands', {timeout: 120_000}, () => {
  it.each(['', '   '])('rejects contributor flag value %j before command dispatch', async value => {
    await expect(runCli(['--contributor', value, '--help']))
      .rejects.toMatchObject({stderr: expect.stringContaining('Usage: kmagent')})
    expect(bridge.commands).toEqual([])
  })

  it('dispatches list/create/use and applies the saved choice to a later write', async () => {
    const listResult = await runCli(['contributor', 'list'])
    expect(JSON.parse(listResult.stdout)).toEqual({contributors: []})

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
    const healthIndexes = bridge.requests.flatMap((request, index) => request === 'GET /health' ? [index] : [])
    const whoamiIndexes = bridge.requests.flatMap((request, index) => request === 'GET /runtime/whoami' ? [index] : [])
    expect(healthIndexes).toHaveLength(4)
    expect(whoamiIndexes).toHaveLength(4)
    expect(whoamiIndexes.every((index, i) => healthIndexes[i]! < index)).toBe(true)
  })

  it('creates human profiles without selecting them and refuses selecting them', async () => {
    const agentCreate = await runCli(['contributor', 'create', 'Researcher', '--kind', 'agent'])
    const agentId = JSON.parse(agentCreate.stdout).id as string
    expect(JSON.parse(agentCreate.stdout)).toMatchObject({id: agentId, selected: true})

    const humanCreate = await runCli(['contributor', 'create', 'Vlad', '--kind', 'human'])
    const humanId = JSON.parse(humanCreate.stdout).id as string
    expect(humanId).not.toBe(agentId)
    expect(JSON.parse(humanCreate.stdout)).toMatchObject({id: humanId, kind: 'human', selected: false})

    await expect(runCli(['contributor', 'use', humanId])).rejects.toMatchObject({
      stderr: expect.stringContaining('Human contributors cannot be selected'),
    })

    await runCli(['create-page', 'Inbox'])
    expect(bridge.commands.at(-1)).toMatchObject({type: 'create-page', contributorId: agentId})

    const automationCreate = await runCli(['contributor', 'create', 'Assistant', '--kind', 'automation'])
    const automationId = JSON.parse(automationCreate.stdout).id as string
    expect(JSON.parse(automationCreate.stdout)).toMatchObject({id: automationId, kind: 'automation', selected: true})
    await runCli(['contributor', 'use', 'none'])
    await runCli(['create-page', 'Unattributed'])
    expect(bridge.commands.at(-1)).toMatchObject({type: 'create-page', contributorId: null})
  })

  it('uses the CLI flag before the environment and the environment before the saved selection', async () => {
    const created = await runCli(['contributor', 'create', 'Saved profile'])
    const savedId = JSON.parse(created.stdout).id as string
    await runCli(['contributor', 'use', savedId])

    await runCli(['create-page', 'Unattributed'], ' none ')
    expect(bridge.commands.at(-1)).toMatchObject({type: 'create-page', contributorId: null})

    await runCli(['create-page', 'Environment'], ' contributor-env ')
    expect(bridge.commands.at(-1)).toMatchObject({type: 'create-page', contributorId: 'contributor-env'})

    await runCli(['--contributor', 'contributor-flag', 'create-page', 'Flag'], 'contributor-env')
    expect(bridge.commands.at(-1)).toMatchObject({type: 'create-page', contributorId: 'contributor-flag'})

    await runCli(['create-page', 'Saved'], '   ')
    expect(bridge.commands.at(-1)).toMatchObject({type: 'create-page', contributorId: savedId})
  })

  it('prints contributor-specific help for the supported single command', async () => {
    const {stdout} = await runCli(['contributor', 'create', '--help'])
    expect(stdout).toContain('contributor <action> [value]')
    expect(stdout).toContain('--kind <kind>')
  })
})
