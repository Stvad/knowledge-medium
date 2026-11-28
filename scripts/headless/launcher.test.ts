import {execFile} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams} from '@/data/blockSchema'
import {typesProp} from '@/data/properties'
import {makeBlockData} from '@/data/test/factories'
import {fixtureModule, fixtureSource, fixtureUrl} from './test/extensionFixture'
import {chmod, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {promisify} from 'node:util'
import {createBridgeClient} from '@knowledge-medium/agent-cli/client'
import {expect, it, vi} from 'vitest'
import {startBridge} from '../agent-eval/hosting'
import {PID_FILENAME} from './config'

const run = promisify(execFile)

// The isolated bridge, Vite graph and database boot took 20 s in a loaded run.
it('serves health and reads over the bridge from a production vite-node host without a document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'headless-launcher-'))
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined
  let host: ReturnType<typeof run> | undefined
  try {
    const config = join(dir, 'config.json')
    const stateDir = join(dir, 'device')
    await writeFile(config, JSON.stringify({workspaceId: 'fixture', profile: 'test', mode: 'plaintext', stateDir: 'device'}))
    bridge = await startBridge(dir)
    const token = 'fixture-bridge-token'
    const tokenFile = join(dir, 'agent-token.json')
    await writeFile(tokenFile, JSON.stringify({profiles: {test: {token}}}))
    host = run(process.execPath, [join(import.meta.dirname, 'launch.ts'), 'run', config], {
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'development',
        TZ: 'Pacific/Honolulu',
        NODE_OPTIONS: `--import=${new URL('./test/hostPreload.ts', import.meta.url).href}`,
        AGENT_RUNTIME_URL: bridge.url,
        AGENT_RUNTIME_BRIDGE_SECRET: bridge.secret,
        AGENT_RUNTIME_TOKEN_FILE: tokenFile,
        VITE_SUPABASE_URL: 'https://auth.invalid',
        VITE_SUPABASE_ANON_KEY: 'fixture-public-key',
        VITE_POWERSYNC_URL: 'https://sync.invalid',
      },
      timeout: 45_000,
      killSignal: 'SIGKILL',
    })
    const client = createBridgeClient({bridgeUrl: bridge.url, token, workspaceId: 'fixture', timeoutMs: 5_000})
    await Promise.race([
      vi.waitFor(async () => expect(await client.runCommand({type: 'health'})).toMatchObject({
        host: {closedReason: null, timeZone: 'Pacific/Honolulu'},
      }), {timeout: 25_000}),
      host.then(() => { throw new Error('Host exited before serving health') }),
    ])
    expect(await client.runCommand({type: 'sql', sql: 'SELECT 1 AS n'})).toEqual([{n: 1}])
    expect(await client.runCommand({type: 'describe-runtime', brief: true})).toMatchObject({activeWorkspaceId: 'fixture'})
    expect(await client.runCommand({type: 'runtime-summary'})).toMatchObject({activeWorkspaceId: 'fixture'})
    expect(await readdir(stateDir)).toContain(PID_FILENAME)
    host.child.kill('SIGTERM')
    await host
    expect(await readdir(stateDir)).not.toContain(PID_FILENAME)
  } finally {
    host?.child.kill('SIGKILL')
    await host?.catch(() => {})
    bridge?.stop()
    await rm(dir, {recursive: true, force: true})
  }
}, 65_000)

it('runs only reviewed bytes, reports normalized synced drift and refuses invalid grants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'headless-extension-launcher-'))
  let bridge: Awaited<ReturnType<typeof startBridge>> | undefined
  let host: ReturnType<typeof run> | undefined
  const cdnRequests: string[] = []
  const cdn = createServer((request, response) => {
    cdnRequests.push(request.url ?? '')
    response.end(fixtureModule)
  })
  try {
    await once(cdn.listen(0, '127.0.0.1'), 'listening')
    const origin = `http://127.0.0.1:${(cdn.address() as AddressInfo).port}`
    const config = join(dir, 'config.json')
    const token = 'fixture-bridge-token'
    const tokenFile = join(dir, 'agent-token.json')
    const initial = join(dir, 'initial.json')
    const changes = join(dir, 'changes.json')
    const unsafeSource = `console.info('fixture synced module evaluated'); export default null`
    const grants = new Map([
      ['fixture-non-error', `throw Object.create(null); export default null`],
      ['fixture-reviewed', fixtureSource + '\n'],
      ['fixture-unpinned', `import '${fixtureUrl}'; export default null`],
      ['fixture-forbidden', `import 'node:fs'; export default null`],
      ['fixture-host-forbidden', `import '@/plugins/agent-runtime/commands.js'; export default null`],
      ['fixture-missing-export', `import {notAnExport} from '@/extensions/core.js'; console.info(notAnExport)`],
      ['fixture-throws', `throw new Error('private evaluation error'); export default null`],
      ['fixture-absent', unsafeSource],
      ['fixture-permissions', unsafeSource],
    ])
    await Promise.all([
      ...[...grants].map(([block, source]) => writeFile(join(dir, `${block}.tsx`), source)),
      writeFile(config, JSON.stringify({
        workspaceId: 'fixture', profile: 'test', mode: 'plaintext', stateDir: 'device', writable: true,
        extensions: [...grants.keys(), 'fixture-unreadable'].map(block => ({block, file: `${block}.tsx`})),
      })),
      writeFile(tokenFile, JSON.stringify({profiles: {test: {token}}})),
      writeFile(initial, JSON.stringify([
        ...[...grants].filter(([block]) => block !== 'fixture-absent').map(([block, source]) =>
          stageExtension(block, block === 'fixture-reviewed' ? unsafeSource + '\n// first revision' : source, 1)),
        stageExtension('fixture-unlisted', unsafeSource, 1),
      ])),
    ])
    await chmod(join(dir, 'fixture-permissions.tsx'), 0o620)
    bridge = await startBridge(dir)
    host = run(process.execPath, [join(import.meta.dirname, 'launch.ts'), 'run', config], {
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: `--import=${new URL('./test/hostPreload.ts', import.meta.url).href}`,
        HEADLESS_TEST_INITIAL: initial,
        HEADLESS_TEST_CHANGES: changes,
        HEADLESS_TEST_ROLE: 'editor',
        HEADLESS_TEST_CDN: origin + '/fixture.mjs',
        AGENT_RUNTIME_URL: bridge.url,
        AGENT_RUNTIME_BRIDGE_SECRET: bridge.secret,
        AGENT_RUNTIME_TOKEN_FILE: tokenFile,
        VITE_SUPABASE_URL: 'https://auth.invalid',
        VITE_SUPABASE_ANON_KEY: 'fixture-public-key',
        VITE_POWERSYNC_URL: 'https://sync.invalid',
      },
      encoding: 'utf8',
      timeout: 55_000,
      killSignal: 'SIGKILL',
    })
    const client = createBridgeClient({bridgeUrl: bridge.url, token, workspaceId: 'fixture', timeoutMs: 5_000})
    let hostOutput = ''
    host.child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { hostOutput += chunk })
    const health = () => client.runCommand({type: 'health'})
    const effectWrites = () => client.runCommand({type: 'sql',
      sql: `SELECT content, created_by, updated_by,
        json_extract(properties_json, '$."attribution:creators"') AS creators
        FROM blocks WHERE content = 'reviewed-effect'`})
    const refused = (block: string, reason: string) => ({block, state: 'refused', reason, effectIds: []})
    const running = {block: 'fixture-reviewed', state: 'running', effectIds: ['reviewed-effect']}
    await Promise.race([
      vi.waitFor(async () => {
        expect(hostOutput).toContain('fixture reviewed effect committed')
        expect(await health()).toMatchObject({host: {closedReason: null, extensions: [
          refused('fixture-non-error', 'load-error'), {...running, state: 'update-available'}, refused('fixture-unpinned', 'unpinned-import'), refused('fixture-forbidden', 'forbidden-import'),
          refused('fixture-host-forbidden', 'forbidden-import'), refused('fixture-missing-export', 'load-error'),
          refused('fixture-throws', 'load-error'), refused('fixture-absent', 'missing-block'),
          refused('fixture-permissions', 'reviewed-file-permissions'), refused('fixture-unreadable', 'reviewed-file-unreadable'),
        ]}})
      }, {timeout: 32_000}),
      host.then(() => { throw new Error('Host exited before running the fixture') }),
    ])
    expect(await effectWrites()).toEqual([{content: 'reviewed-effect', created_by: 'member', updated_by: 'member', creators: null}])
    expect(cdnRequests).toEqual(['/fixture.mjs'])
    const {stdout: rss} = await run('ps', ['-o', 'rss=', '-p', String(host.child.pid)])
    console.info(`Headless host RSS with fixture: ${Number(rss.trim())} KiB`)
    await writeFile(changes, JSON.stringify([stageExtension('fixture-reviewed', fixtureSource + '\n  ', 2)]))
    host.child.kill('SIGUSR2')
    await vi.waitFor(async () => {
      expect(await health()).toMatchObject({host: {extensions: expect.arrayContaining([running])}})
    }, {timeout: 5_000})
    // A later server edit changes the status without restarting the effect.
    await writeFile(changes, JSON.stringify([stageExtension('fixture-reviewed', unsafeSource, 3)]))
    host.child.kill('SIGUSR2')
    await vi.waitFor(async () => {
      const result = await health()
      expect(result).toMatchObject({host: {extensions: expect.arrayContaining([{...running, state: 'update-available'}])}})
      expect(JSON.stringify(result)).not.toContain(unsafeSource)
    }, {timeout: 5_000})
    expect(await effectWrites()).toHaveLength(1)
    for (const command of [{type: 'enable-extension'}, {type: 'install-extension', source: unsafeSource}, {type: 'run-action', id: 'x'}] as const) {
      await expect(client.runCommand(command)).rejects.toThrow(/(?:extension grants|actions are unavailable)/)
    }
    await writeFile(changes, JSON.stringify([["UPDATE workspace_members SET role = 'viewer' WHERE id = 'membership'", []]]))
    host.child.kill('SIGUSR2')
    await vi.waitFor(async () => {
      expect(await health()).toMatchObject({host: {closedReason: null, readOnly: true, extensions: expect.arrayContaining([
        refused('fixture-reviewed', 'not-writable'),
      ])}})
    }, {timeout: 5_000})
    host.child.kill('SIGTERM')
    const result = await host
    expect(await readdir(join(dir, 'device'))).not.toContain(PID_FILENAME)
    const stdout = result.stdout.toString()
    const stderr = result.stderr.toString()
    expect(stdout.match(/fixture reviewed module evaluated/g)).toHaveLength(1)
    expect(stdout.match(/fixture reviewed effect stopped/g)).toHaveLength(1)
    expect(stdout).not.toContain('fixture synced module evaluated')
    expect(stderr).toContain('Headless extension update-available fixture-reviewed')
    expect(stderr).toContain('Headless extension refused fixture-throws load-error')
    expect(stderr).not.toContain('private evaluation error')
  } finally {
    host?.child.kill('SIGKILL')
    await host?.catch(() => {})
    bridge?.stop()
    cdn.closeAllConnections()
    await new Promise<void>(resolve => cdn.close(() => resolve()))
    await rm(dir, {recursive: true, force: true})
  }
}, 70_000)

function stageExtension(id: string, content: string, stamp: number) {
  return [BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams(makeBlockData({
    id, workspaceId: 'fixture', content, createdAt: 1, updatedAt: stamp, userUpdatedAt: stamp,
    properties: {[typesProp.name]: ['extension']},
  }))]
}
