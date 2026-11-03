import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {spawn} from 'node:child_process'
import http from 'node:http'
import {AddressInfo} from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {saveContributorSelection} from '@knowledge-medium/agent-cli/config'

const here = path.dirname(fileURLToPath(import.meta.url))
const mcpScript = path.resolve(here, '../dist/mcp.js')
const CANONICAL_PROFILE = 'dispatch-test'
const CANONICAL_WORKSPACE = 'workspace-test'

let tempDir: string
let tokenFile: string
let selectionDir: string
let bridge: http.Server
let bridgeUrl: string
let transport: StdioClientTransport | undefined
let client: Client | undefined
let postedCommands: Array<{body: Record<string, unknown>, authorization: string | undefined}> = []
let serverStderr = ''

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const listen = (server: http.Server): Promise<void> => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject)
    resolve()
  })
})

const closeServer = (server: http.Server): Promise<void> => new Promise((resolve, reject) => {
  server.close(error => error ? reject(error) : resolve())
})

const processEnv = (profile: string, workspace: string, contributorId?: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  AGENT_RUNTIME_CONFIG_DIR: tempDir,
  AGENT_RUNTIME_PROFILE: profile,
  AGENT_RUNTIME_WORKSPACE: workspace,
  AGENT_RUNTIME_URL: bridgeUrl,
  AGENT_RUNTIME_TOKEN_FILE: tokenFile,
  AGENT_RUNTIME_CONTRIBUTOR_DIR: selectionDir,
  ...(contributorId !== undefined ? {AGENT_RUNTIME_CONTRIBUTOR_ID: contributorId} : {}),
})

const connectAndCreatePage = async (env: NodeJS.ProcessEnv): Promise<void> => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpScript],
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    stderr: 'pipe',
  })
  serverStderr = ''
  transport.stderr?.setEncoding('utf8').on('data', chunk => { serverStderr += chunk })
  client = new Client({name: 'dispatch-mcp-test', version: '1.0.0'})
  try {
    await withTimeout(client.connect(transport), 5_000, 'MCP server did not initialize in time')
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${serverStderr}`, {cause: error})
  }
  await client.callTool(
    {name: 'create_page', arguments: {name: 'Dispatch MCP integration'}},
    undefined,
    {timeout: 5_000},
  )
}

afterEach(async () => {
  await client?.close().catch(() => {})
  client = undefined
  await transport?.close().catch(() => {})
  transport = undefined
  if (bridge) await closeServer(bridge)
  if (tempDir) await fs.rm(tempDir, {recursive: true, force: true})
  vi.unstubAllEnvs()
})

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dispatch-mcp-'))
  tokenFile = path.join(tempDir, 'tokens.json')
  selectionDir = path.join(tempDir, 'contributors')
  vi.stubEnv('AGENT_RUNTIME_CONTRIBUTOR_DIR', selectionDir)
  postedCommands = []
  bridge = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const send = (status: number, value: unknown) => {
        res.writeHead(status, {'content-type': 'application/json'})
        res.end(JSON.stringify(value))
      }
      if (req.method === 'POST' && req.url === '/runtime/commands') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        postedCommands.push({body, authorization: req.headers.authorization})
        return send(202, {id: 'command-1'})
      }
      if (req.method === 'GET' && req.url === '/runtime/commands/command-1') {
        return send(200, {
          id: 'command-1',
          status: 'completed',
          result: {ok: true, value: {id: 'page-1'}},
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
  await listen(bridge)
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`
  await fs.writeFile(tokenFile, JSON.stringify({profiles: {
    [CANONICAL_PROFILE]: {token: 'DISPATCH-TEST-TOKEN'},
    default: {token: 'DEFAULT-TEST-TOKEN'},
  }}))
})

describe('compiled dispatch MCP contributor/workspace selection', {timeout: 20_000}, () => {
  it.each([
    {
      label: 'padded profile and workspace use the saved contributor',
      profile: '  dispatch-test  ',
      savedProfile: CANONICAL_PROFILE,
      contributorId: 'contributor-agent',
      expectedToken: 'Bearer DISPATCH-TEST-TOKEN',
      expectedContributor: 'contributor-agent',
    },
    {
      label: 'blank profile resolves to default and restores saved explicit none',
      profile: '   ',
      savedProfile: 'default',
      contributorId: null,
      expectedToken: 'Bearer DEFAULT-TEST-TOKEN',
      expectedContributor: null,
    },
  ])('pins $label', async ({profile, savedProfile, contributorId, expectedToken, expectedContributor}) => {
    await saveContributorSelection(savedProfile, CANONICAL_WORKSPACE, contributorId)
    await connectAndCreatePage(processEnv(profile, ` ${CANONICAL_WORKSPACE} `))

    expect(postedCommands).toHaveLength(1)
    expect(postedCommands[0]).toMatchObject({
      authorization: expectedToken,
      body: {
        type: 'create-page',
        name: 'Dispatch MCP integration',
        workspaceId: CANONICAL_WORKSPACE,
        contributorId: expectedContributor,
      },
    })
  })

  it('refuses a whitespace-only workspace at startup even with explicit none', async () => {
    const child = spawn(process.execPath, [mcpScript], {
      env: processEnv(CANONICAL_PROFILE, '   ', 'none'),
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    const exit = await withTimeout(new Promise<{code: number | null, signal: NodeJS.Signals | null}>(resolve => {
      child.once('close', (code, signal) => resolve({code, signal}))
    }), 5_000, 'server remained running').catch(() => null)
    if (exit === null) {
      child.kill('SIGTERM')
      await new Promise<void>(resolve => child.once('close', () => resolve()))
    }

    expect(exit).not.toBeNull()
    expect(exit?.code).not.toBe(0)
    expect(stderr).toMatch(/AGENT_RUNTIME_WORKSPACE.*required|workspace.*required/i)
  })
})
