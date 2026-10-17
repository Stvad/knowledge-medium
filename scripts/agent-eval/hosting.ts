/**
 * The runner's side of hosting graphs: a private bridge server for the run,
 * on a port of its own with a secret of its own, so nothing reaches the
 * user's bridge or tabs, and a host process per graph (host.ts), each
 * registered under a token minted for it.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'

export const READY_PREFIX = 'agent-eval-host ready'

/** The environment without the agent runtime's own variables, which a shell
 *  that uses the CLI exports and which would point a child at the user's
 *  bridge, profile or token store. */
export const envWithoutAgentRuntime = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('AGENT_RUNTIME_')))

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address() as {port: number}
    server.close(() => resolve(port))
  })
})

export interface Bridge {
  url: string
  secret: string
  stop: () => void
}

/** `stateDir` holds the server's log and config, away from the user's. */
export const startBridge = async (serverScript: string, stateDir: string): Promise<Bridge> => {
  mkdirSync(stateDir, {recursive: true})
  const port = await freePort()
  const secret = randomBytes(32).toString('hex')
  const log = openSync(path.join(stateDir, 'bridge.log'), 'a')
  const child = spawn(process.execPath, [serverScript], {
    env: {
      ...envWithoutAgentRuntime(process.env),
      AGENT_RUNTIME_HOST: '127.0.0.1',
      AGENT_RUNTIME_PORT: String(port),
      AGENT_RUNTIME_BRIDGE_SECRET: secret,
      AGENT_RUNTIME_CONFIG_DIR: stateDir,
    },
    stdio: ['ignore', log, log],
  })
  closeSync(log)
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the bridge server exited (${child.exitCode}); see ${path.join(stateDir, 'bridge.log')}`)
    const up = await fetch(`${url}/health`).then(response => response.ok, () => false)
    if (up) break
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`the bridge server did not come up at ${url}; see ${path.join(stateDir, 'bridge.log')}`)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return {url, secret, stop: () => { child.kill() }}
}

export interface HostedGraph {
  /** Reaches this graph, and only it, through the bridge. */
  token: string
  /** Where the graph's database files live. */
  dir: string
  /** Closes the database and waits for the host to exit. */
  stop: () => Promise<void>
}

export interface HostOptions {
  /** vite-node, the host script and the config that resolves `@/`. */
  command: {bin: string, args: string[]}
  bridge: Bridge
  /** The template to copy; omitted, the host seeds one. */
  from?: string
  log: string
}

const live = new Set<ChildProcess>()
// A run that fails exits at once; its hosts must not outlive it.
process.on('exit', () => { for (const child of live) child.kill('SIGKILL') })

export const startHost = async (options: HostOptions): Promise<HostedGraph> => {
  const token = `agent-eval-${randomBytes(24).toString('hex')}`
  const log = openSync(options.log, 'a')
  const child = spawn(options.command.bin, [...options.command.args, ...(options.from ? ['--from', options.from] : ['--seed'])], {
    env: {
      ...envWithoutAgentRuntime(process.env),
      // Node 25+ ships a `localStorage` global that the host's shim must replace.
      NODE_OPTIONS: '--no-experimental-webstorage',
      AGENT_EVAL_BRIDGE_URL: options.bridge.url,
      AGENT_EVAL_BRIDGE_SECRET: options.bridge.secret,
      AGENT_EVAL_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', log],
  })
  closeSync(log)
  live.add(child)
  const exited = new Promise<void>(resolve => child.once('exit', () => {
    live.delete(child)
    resolve()
  }))
  const dir = await new Promise<string>((resolve, reject) => {
    let stdout = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      const line = stdout.split('\n').find(text => text.startsWith(READY_PREFIX))
      if (line) resolve((JSON.parse(line.slice(READY_PREFIX.length)) as {dir: string}).dir)
    })
    void exited.then(() => reject(new Error(`the graph host exited before it was ready; see ${options.log}`)))
  })
  return {
    token,
    dir,
    stop: async () => {
      child.kill('SIGTERM')
      const killer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      await exited
      clearTimeout(killer)
    },
  }
}
