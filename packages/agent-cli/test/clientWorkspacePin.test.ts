import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridgeClient, type BridgeClient, withContributorId } from '../src/client.js'
import { attributeCommandToWorkspace } from '../src/cliOptions.js'
import type {KnownCommand, WhoamiInfo} from '../src/protocol.js'

class PrototypeBridgeClient implements BridgeClient {
  readonly bridgeUrl = 'http://prototype.test'
  readonly commands: KnownCommand[] = []
  methodCalls: string[] = []

  private called(name: string) {
    this.methodCalls.push(name)
  }

  async runCommand(command: KnownCommand): Promise<unknown> {
    this.called('runCommand')
    this.commands.push(command)
    return null
  }

  async nextEvents() {
    this.called('nextEvents')
    return {events: [], nextSeq: 0}
  }

  async whoami(): Promise<WhoamiInfo> {
    this.called('whoami')
    return {
      clientId: 'client-1', audience: {userId: null, workspaceId: null, label: null},
      scope: 'read-write', connected: true, clientLastSeen: 1,
    }
  }

  async health() {
    this.called('health')
  }

  async resolveToken() {
    this.called('resolveToken')
    return 'token'
  }
}

// A call that names no workspace goes to whichever app tab the user focused
// last; a pinned client names one on every call, so an unattended consumer
// stays on its workspace while the user moves around.
describe('bridge client workspace pin', () => {
  let submitted: Array<Record<string, unknown>>

  beforeEach(() => {
    submitted = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        submitted.push(JSON.parse(String(init.body)) as Record<string, unknown>)
        return new Response(JSON.stringify({id: 'c1'}), {status: 202})
      }
      return new Response(JSON.stringify({status: 'completed', result: {ok: true, value: null}}), {status: 200})
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const client = (options: {workspaceId?: string} = {}) =>
    createBridgeClient({bridgeUrl: 'http://127.0.0.1:1', token: 'TOKEN', pollIntervalMs: 1, ...options})

  it('names the pinned workspace on a call that names none', async () => {
    await client({workspaceId: 'ws-pinned'}).runCommand({type: 'update-block', id: 'b1', content: 'x'})

    expect(submitted[0]!.workspaceId).toBe('ws-pinned')
  })

  it('leaves a call that names its own workspace alone', async () => {
    await client({workspaceId: 'ws-pinned'}).runCommand({type: 'search', query: 'x', workspaceId: 'ws-other'})

    expect(submitted[0]!.workspaceId).toBe('ws-other')
  })

  // A root block names its workspace in `data`, where the bridge routes by it.
  it('leaves a root create-block that names its workspace in data alone', async () => {
    await client({workspaceId: 'ws-pinned'}).runCommand({type: 'create-block', data: {workspaceId: 'ws-other'}})

    expect(submitted[0]).not.toHaveProperty('workspaceId')
  })

  // The MCP tools pass `workspaceId: undefined` when the caller gave none.
  it('pins a call whose workspaceId is present but undefined', async () => {
    await client({workspaceId: 'ws-pinned'}).runCommand({type: 'search', query: 'x', workspaceId: undefined})

    expect(submitted[0]!.workspaceId).toBe('ws-pinned')
  })

  it('takes the pin from AGENT_RUNTIME_WORKSPACE', async () => {
    vi.stubEnv('AGENT_RUNTIME_WORKSPACE', 'ws-from-env')

    await client().runCommand({type: 'ping'})

    expect(submitted[0]!.workspaceId).toBe('ws-from-env')
  })

  it('names no workspace when unpinned', async () => {
    vi.stubEnv('AGENT_RUNTIME_WORKSPACE', '')

    await client().runCommand({type: 'ping'})

    expect(submitted[0]).not.toHaveProperty('workspaceId')
  })

  it('injects configured contributor attribution into writes, preserving explicit null', async () => {
    const configured = createBridgeClient({bridgeUrl: 'http://127.0.0.1:1', token: 'TOKEN', contributorId: 'contrib-1', pollIntervalMs: 1})
    await configured.runCommand({type: 'update-block', id: 'b1', content: 'x'})
    await configured.runCommand({type: 'update-block', id: 'b1', content: 'x', contributorId: null})
    expect(submitted.map(command => command.contributorId)).toEqual(['contrib-1', null])
  })

  it('does not inject attribution into reads or when it is unconfigured', async () => {
    await client().runCommand({type: 'search', query: 'x'})
    await client({contributorId: 'contrib-1'}).runCommand({type: 'search', query: 'x'})
    await client().runCommand({type: 'update-block', id: 'b1', content: 'x'})
    expect(submitted[0]).not.toHaveProperty('contributorId')
    expect(submitted[1]).not.toHaveProperty('contributorId')
    expect(submitted[2]).not.toHaveProperty('contributorId')
  })

  it('sends the workspace resolved for the saved selection with an explicit none choice', async () => {
    const command = attributeCommandToWorkspace(
      {type: 'update-block', id: 'b1', content: 'x'},
      'workspace-from-whoami',
      null,
    )
    await client().runCommand(command)
    expect(submitted[0]).toMatchObject({
      type: 'update-block', workspaceId: 'workspace-from-whoami', contributorId: null,
    })
  })

  it('preserves prototype-backed client methods and their receivers while binding attribution', async () => {
    const original = new PrototypeBridgeClient()
    const bound = withContributorId(original, 'configured')

    await bound.runCommand({type: 'search', query: 'x'})
    await bound.runCommand({type: 'update-block', id: 'b1', content: 'x'})
    await bound.runCommand({type: 'update-block', id: 'b1', content: 'x', contributorId: null})
    await bound.nextEvents()
    await bound.whoami()
    await bound.health()
    await bound.resolveToken()

    expect(original.commands.map(command => command.contributorId)).toEqual([undefined, 'configured', null])
    expect(original.methodCalls).toEqual([
      'runCommand', 'runCommand', 'runCommand', 'nextEvents', 'whoami', 'health', 'resolveToken',
    ])
  })
})
