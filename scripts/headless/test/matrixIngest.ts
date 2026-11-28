import {execFile} from 'node:child_process'
import {once} from 'node:events'
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import type {AddressInfo, Socket} from 'node:net'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {createBridgeClient} from '@knowledge-medium/agent-cli/client'
import {expect, vi} from 'vitest'
import {BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams} from '@/data/blockSchema'
import {typesProp, userIdProp} from '@/data/properties'
import {pluginPrefsBlockId, stateChildBlockId, userPageBlockId} from '@/data/stateBlocks'
import {makeBlockData} from '@/data/test/factories'
import {USER_PREFS_PATH_PART} from '@/data/userPrefs'
import {checkpointId, tokenKey} from '../../../agent-extensions/matrix-chat-client'
import {startBridge} from '../../agent-eval/hosting'
import {PID_FILENAME} from '../config'

const run = promisify(execFile)
const launch = join(import.meta.dirname, '../launch.ts')
const workspaceId = 'fixture'
const owner = 'owner'
const member = 'member'
const ownerPage = userPageBlockId(workspaceId, owner)
const prefsRoot = stateChildBlockId(ownerPage, USER_PREFS_PATH_PART)
const prefsType = 'matrix-chat-prefs'
const ownerPrefs = pluginPrefsBlockId(workspaceId, owner, prefsType)
const memberPage = userPageBlockId(workspaceId, member)
const memberPrefs = pluginPrefsBlockId(workspaceId, member, prefsType)
const baseUrl = 'https://matrix.invalid'
const roomId = '!fixture:matrix.invalid'
const eventId = '$fixture-event'
const matrixToken = 'fixture-matrix-token'
const destination = {workspaceId, baseUrl, roomId}
const checkpoint = checkpointId(destination)
const grant = 'fixture-matrix-extension'

const stage = (block: Omit<Parameters<typeof makeBlockData>[0], 'workspaceId'>) =>
  [BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(makeBlockData({
    workspaceId, createdAt: 1, updatedAt: 1, userUpdatedAt: 1, ...block,
  }))]

interface Poll {
  path: string
  method: string | undefined
  authorization: string | undefined
  since: string | null
  timeout: string | null
  roomFilter: unknown
  socket: Socket
}

export async function verifyMatrixIngest() {
  const dir = await mkdtemp(join(tmpdir(), 'headless-matrix-launcher-'))
  const polls: Poll[] = []
  const sockets = new Set<Socket>()
  let remainingReply: string | undefined
  const server = createServer((request, response) => {
    const url = new URL(request.url!, baseUrl)
    polls.push({
      path: url.pathname,
      method: request.method,
      authorization: request.headers.authorization,
      since: url.searchParams.get('since'),
      timeout: url.searchParams.get('timeout'),
      roomFilter: JSON.parse(url.searchParams.get('filter') ?? 'null')?.room?.rooms,
      socket: request.socket,
    })
    if (remainingReply === undefined) return
    const next = remainingReply
    remainingReply = undefined
    response.setHeader('content-type', 'application/json')
    const event = {
      type: 'm.room.message', event_id: eventId, sender: '@fixture:matrix.invalid',
      origin_server_ts: 1_700_000_000_000, content: {msgtype: 'm.text', body: 'fixture matrix message'},
    }
    response.end(JSON.stringify({
      next_batch: next,
      rooms: {join: {[roomId]: {timeline: {events: [event, event]}}}},
    }))
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined
  let host: ReturnType<typeof run> | undefined
  try {
    await once(server.listen(0, '127.0.0.1'), 'listening')
    const matrixOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const config = join(dir, 'config.json')
    const stateDir = join(dir, 'device')
    const sourcePath = join(dir, 'matrix.tsx')
    const source = await readFile(new URL('../../../agent-extensions/matrix-chat-client.tsx', import.meta.url), 'utf8')
    const token = 'fixture-bridge-token'
    const tokenFile = join(dir, 'token.json')
    const initial = join(dir, 'initial.json')
    const changes = join(dir, 'changes.json')
    const stageOwnerPrefs = (autoStart: boolean, updatedAt: number) =>
      stage({id: ownerPrefs, parentId: prefsRoot, content: 'Matrix', updatedAt, userUpdatedAt: updatedAt, properties: {
        [typesProp.name]: [prefsType], 'matrix:homeserver': baseUrl, 'matrix:roomId': roomId, 'matrix:autoStart': autoStart,
      }})
    const ownerBlocks = [
      stage({id: ownerPage, content: 'Fixture Owner', properties: {[userIdProp.name]: owner, [typesProp.name]: ['user', 'page']}}),
      stage({id: prefsRoot, parentId: ownerPage, content: 'Preferences'}),
      stageOwnerPrefs(true, 1),
    ]
    await Promise.all([
      writeFile(sourcePath, source),
      writeFile(config, JSON.stringify({
        workspaceId, profile: 'test', mode: 'plaintext', stateDir: 'device', writable: true,
        preferencesPage: ownerPage, extensions: [{block: grant, file: 'matrix.tsx'}],
      })),
      writeFile(tokenFile, JSON.stringify({profiles: {test: {token}}})),
      writeFile(initial, JSON.stringify([
        ...ownerBlocks,
        stage({id: grant, content: source, properties: {[typesProp.name]: ['extension']}}),
        stage({id: checkpoint, content: 'Matrix room checkpoint', properties: {
          [typesProp.name]: ['matrix-checkpoint'], 'matrix:homeserver': baseUrl,
          'matrix:roomId': roomId, 'matrix-checkpoint:nextBatch': 'shared-position',
        }}),
      ])),
    ])
    const storage = run(process.execPath, [launch, 'storage', 'set', config, tokenKey(destination)], {
      env: {PATH: process.env.PATH}, timeout: 20_000,
    })
    storage.child.stdin!.end(matrixToken + '\n')
    const storageOutput = await storage
    expect(storageOutput.stdout + storageOutput.stderr).not.toContain(matrixToken)

    bridge = await startBridge(dir)
    const client = createBridgeClient({bridgeUrl: bridge.url, token, workspaceId, timeoutMs: 5_000})
    const runningHealth = {host: {
      closedReason: null, readOnly: false,
      extensions: [{block: grant, state: 'running', effectIds: ['matrix-chat-client.ingest']}],
    }}
    const env = {
      PATH: process.env.PATH,
      NODE_OPTIONS: `--import=${new URL('./hostPreload.ts', import.meta.url).href}`,
      HEADLESS_TEST_OWNER: owner,
      HEADLESS_TEST_ROLE: 'editor',
      HEADLESS_TEST_MATRIX: matrixOrigin,
      HEADLESS_TEST_CHANGES: changes,
      AGENT_RUNTIME_URL: bridge.url,
      AGENT_RUNTIME_BRIDGE_SECRET: bridge.secret,
      AGENT_RUNTIME_TOKEN_FILE: tokenFile,
      VITE_SUPABASE_URL: 'https://auth.invalid',
      VITE_SUPABASE_ANON_KEY: 'fixture-public-key',
      VITE_POWERSYNC_URL: 'https://sync.invalid',
    }
    const sql = (sql: string) => client.runCommand({type: 'sql', sql})
    const prefRows = () => sql(`SELECT id, parent_id, content, properties_json, updated_at FROM blocks
      WHERE id IN ('${ownerPage}', '${memberPage}') OR parent_id IN ('${ownerPage}', '${memberPage}', '${prefsRoot}')
        OR id = '${memberPrefs}' ORDER BY id`)
    const checkIngest = async () => {
      expect(await sql(`SELECT content, created_by, json_extract(properties_json, '$."matrix-event:id"') AS event
        FROM blocks WHERE deleted = 0 AND json_extract(properties_json, '$."matrix-event:id"') IS NOT NULL`))
        .toEqual([{content: 'fixture matrix message', created_by: member, event: eventId}])
      // No uploader runs in the fixture, so the downloaded checkpoint stays behind the device cursor.
      expect(await sql(`SELECT json_extract(properties_json, '$."matrix-checkpoint:nextBatch"') AS position
        FROM blocks WHERE id = '${checkpoint}' AND deleted = 0`)).toEqual([{position: 'shared-position'}])
    }

    const boot = async (since: string, next: string, initialFile?: string) => {
      const offset = polls.length
      remainingReply = next
      const running = run(process.execPath, [launch, 'run', config], {
        env: {...env, HEADLESS_TEST_INITIAL: initialFile}, timeout: 55_000, killSignal: 'SIGKILL',
      })
      host = running
      let hostErrors = ''
      running.child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { hostErrors += chunk })
      try {
        await Promise.race([
          vi.waitFor(async () => {
            expect(await client.runCommand({type: 'health'})).toMatchObject(runningHealth)
            expect(polls.length).toBeGreaterThanOrEqual(offset + 2)
            await checkIngest()
          }, {timeout: 32_000}),
          running.then(() => { throw new Error('Host exited before starting Matrix polling') }),
        ])
      } catch (error) {
        throw new Error(`Matrix host failed to ingest: ${hostErrors.replaceAll(matrixToken, '[redacted]')}`, {cause: error})
      }
      const {socket: pollSocket} = polls[offset + 1]!
      expect(polls.slice(offset)).toMatchObject(
        [since, next].map(position => ({
          path: '/_matrix/client/v3/sync', method: 'GET', authorization: `Bearer ${matrixToken}`,
          since: position, timeout: '30000', roomFilter: [roomId],
        })),
      )
      expect(sockets.has(pollSocket)).toBe(true)
      const stop = async () => {
        expect(await readdir(stateDir)).toContain(PID_FILENAME)
        running.child.kill('SIGTERM')
        const output = await running
        expect(output.stdout + output.stderr).not.toContain(matrixToken)
        await vi.waitFor(() => expect(sockets.size).toBe(0), {timeout: 3_000})
        expect(await readdir(stateDir)).not.toContain(PID_FILENAME)
      }
      return {stop, running, pollSocket}
    }

    const first = await boot('shared-position', 'device-position', initial)
    const originalPrefs = await prefRows()
    expect(originalPrefs).toEqual([ownerPage, prefsRoot, ownerPrefs].sort().map(id => expect.objectContaining({id, updated_at: 1})))
    await first.stop()
    const second = await boot('device-position', 'resumed-position')
    expect(await prefRows()).toEqual(originalPrefs)
    await writeFile(changes, JSON.stringify([stageOwnerPrefs(false, 2)]))
    second.running.child.kill('SIGUSR2')
    await vi.waitFor(() => expect(sockets.has(second.pollSocket)).toBe(false), {timeout: 5_000})
    expect(await client.runCommand({type: 'health'})).toMatchObject(runningHealth)
    await checkIngest()
    expect(polls).toHaveLength(4)
    await second.stop()
  } finally {
    if (host?.child.exitCode === null) host.child.kill('SIGKILL')
    await host?.catch(() => {})
    bridge?.stop()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(dir, {recursive: true, force: true})
  }
}
