/**
 * The runner's side of hosting graphs: a private bridge server for the run,
 * on a port of its own with a secret of its own, so nothing reaches the
 * user's bridge or tabs, and a host process per graph (host.ts), each
 * registered under a token minted for it. Every child of a run starts from
 * `childEnv`, never from the runner's environment.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, createWriteStream, mkdirSync, openSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const AGENT_CLI_DIST = path.join(REPO_ROOT, 'packages/agent-cli/dist')

/** host.ts's protocol: one line once it is registered, one per `counts`
 *  request on its stdin; it shuts down when its stdin closes. */
export const READY_PREFIX = 'agent-eval-host ready'
export const COUNTS_PREFIX = 'agent-eval-host counts'

/** All a child of the run inherits from the runner. The agent's Claude Code
 *  takes behaviour from its environment (effort, thinking budget, the
 *  launching session's messaging socket), and a host runs whatever `eval`
 *  code the agent sends, so neither gets the shell's variables or secrets. */
export const CHILD_ENV: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR']

export const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(CHILD_ENV.flatMap(key => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))),
  ...extra,
})

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address() as {port: number}
    server.close(() => resolve(port))
  })
})

const live = new Set<ChildProcess>()
// A run that fails exits at once; its children must not outlive it.
process.on('exit', () => { for (const child of live) child.kill('SIGKILL') })

const track = (child: ChildProcess) => {
  live.add(child)
  return new Promise<void>(resolve => child.once('exit', () => {
    live.delete(child)
    resolve()
  }))
}

export interface Bridge {
  url: string
  secret: string
  stop: () => void
}

/** `stateDir` holds the server's log and config, away from the user's. */
export const startBridge = async (stateDir: string): Promise<Bridge> => {
  mkdirSync(stateDir, {recursive: true})
  const port = await freePort()
  const secret = randomBytes(32).toString('hex')
  const log = openSync(path.join(stateDir, 'bridge.log'), 'a')
  const child = spawn(process.execPath, [path.join(AGENT_CLI_DIST, 'server.js'), '--exit-on-stdin-close'], {
    env: childEnv({
      AGENT_RUNTIME_HOST: '127.0.0.1',
      AGENT_RUNTIME_PORT: String(port),
      AGENT_RUNTIME_BRIDGE_SECRET: secret,
      AGENT_RUNTIME_CONFIG_DIR: stateDir,
    }),
    // The bridge exits when its stdin closes, which also happens when the
    // runner dies.
    stdio: ['pipe', log, log],
  })
  closeSync(log)
  void track(child)
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
  /** False once the host has exited, for whatever reason. */
  running: () => boolean
  /** How many wire commands of each type the host has run so far. */
  commandCounts: () => Promise<Record<string, number>>
  /** Closes the database and waits for the host to exit. */
  stop: () => Promise<void>
}

export interface HostOptions {
  bridge: Bridge
  /** The template to copy; omitted, the host seeds one. */
  from?: string
  /** Where the host's database lives, so a host that is killed leaves it
   *  inside the run's scratch directory. */
  tmpDir: string
  log: string
}

/** vite-node with the test config, which resolves `@/` the way the fixture
 *  test does. */
const HOST_COMMAND = {
  bin: path.join(REPO_ROOT, 'node_modules/.bin/vite-node'),
  args: ['--config', path.join(REPO_ROOT, 'vitest.config.ts'), path.join(REPO_ROOT, 'scripts/agent-eval/host.ts'), '--'],
}
/** Generous: a copy is ready in about 3 s and a seed in about 10 s. */
const READY_TIMEOUT_MS = 120_000
/** A host answers counts at once unless agent `eval` code has blocked it. */
const COUNTS_TIMEOUT_MS = 30_000

export const startHost = async (options: HostOptions): Promise<HostedGraph> => {
  const token = `agent-eval-${randomBytes(24).toString('hex')}`
  const logFd = openSync(options.log, 'a')
  const child = spawn(HOST_COMMAND.bin, [...HOST_COMMAND.args, ...(options.from ? ['--from', options.from] : ['--seed'])], {
    env: childEnv({
      TMPDIR: options.tmpDir,
      // Node 25+ ships a `localStorage` global that the host's shim must replace.
      NODE_OPTIONS: '--no-experimental-webstorage',
      AGENT_EVAL_BRIDGE_URL: options.bridge.url,
      AGENT_EVAL_BRIDGE_SECRET: options.bridge.secret,
      AGENT_EVAL_TOKEN: token,
    }),
    // The host shuts down when its stdin closes, which also happens when
    // the runner dies.
    stdio: ['pipe', 'pipe', logFd],
  })
  closeSync(logFd)
  // A write to a host that died is reported by `running` and `exited`.
  child.stdin!.on('error', () => {})
  const exited = track(child)
  const log = createWriteStream(options.log, {flags: 'a'})
  const pendingCounts: Array<(counts: Record<string, number>) => void> = []
  let onReady: (dir: string) => void = () => {}
  createInterface({input: child.stdout!}).on('line', line => {
    if (line.startsWith(READY_PREFIX)) onReady((JSON.parse(line.slice(READY_PREFIX.length)) as {dir: string}).dir)
    else if (line.startsWith(COUNTS_PREFIX)) pendingCounts.shift()?.(JSON.parse(line.slice(COUNTS_PREFIX.length)) as Record<string, number>)
    else log.write(`${line}\n`)
  })
  const dir = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`the graph host was not ready after ${READY_TIMEOUT_MS / 1000}s; see ${options.log}`))
    }, READY_TIMEOUT_MS)
    onReady = ready => {
      clearTimeout(timeout)
      resolve(ready)
    }
    void exited.then(() => {
      clearTimeout(timeout)
      reject(new Error(`the graph host exited before it was ready; see ${options.log}`))
    })
  })
  const running = () => child.exitCode === null && child.signalCode === null
  return {
    token,
    dir,
    running,
    commandCounts: () => {
      if (!running()) return Promise.reject(new Error(`the graph host exited; see ${options.log}`))
      let timeout: ReturnType<typeof setTimeout> | undefined
      const counts = new Promise<Record<string, number>>(resolve => pendingCounts.push(resolve))
      const stalled = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          child.kill('SIGKILL')
          reject(new Error(`the graph host did not answer for ${COUNTS_TIMEOUT_MS / 1000}s, its event loop blocked; see ${options.log}`))
        }, COUNTS_TIMEOUT_MS)
      })
      child.stdin!.write('counts\n')
      return Promise.race([counts, stalled, exited.then(() => { throw new Error(`the graph host exited; see ${options.log}`) })])
        .finally(() => clearTimeout(timeout))
    },
    stop: async () => {
      child.stdin!.end()
      const killer = setTimeout(() => child.kill('SIGKILL'), 15_000)
      await exited
      clearTimeout(killer)
      log.end()
    },
  }
}
