import {execFile} from 'node:child_process'
import {mkdtemp, readdir, rm, writeFile} from 'node:fs/promises'
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
