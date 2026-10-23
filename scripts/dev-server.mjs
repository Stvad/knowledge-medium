#!/usr/bin/env node
// `pnpm dev` / `pnpm preview`: run vite for this checkout on a port no other
// server holds. `pnpm dev:who [port…]`: name the worktree and branch behind
// each server.
//
// Many worktrees run servers on one machine. vite on its own moves to the next
// free port, so a session can end up reading another branch's app at the port
// it assumed. Here the port is exact (`--strictPort`) and comes from, in order:
// an explicit `--port`; `PORT`, which the Claude desktop app sets to the port
// it assigned (`autoPort` in .claude/launch.json); the first free port from the
// mode's default. A busy port is reported with its holder and never used.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMainModule } from './is-main-module.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BRIDGE_SCRIPT = join('packages', 'agent-cli', 'dist', 'server.js')

export const MODES = {
  dev: { viteArgs: [], defaultPort: 5173 },
  preview: { viteArgs: ['preview'], defaultPort: 4173 },
}
// The desktop app's autoPort scans the same span above a configured port.
export const SCAN_SPAN = 20

export const parsePort = (value, source) => {
  const port = Number(value)
  if (!/^\d+$/.test(String(value ?? '')) || port < 1 || port > 65535) {
    throw new Error(`${source} must be a port number from 1 to 65535, not ${JSON.stringify(value ?? null)}`)
  }
  return port
}

/** The port this launch must use, or null to scan from the mode's default. */
export const requestedPort = (args, env) => {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') return { port: parsePort(args[i + 1], '--port'), source: '--port' }
    if (args[i].startsWith('--port=')) return { port: parsePort(args[i].slice('--port='.length), '--port'), source: '--port' }
  }
  return env.PORT ? { port: parsePort(env.PORT, 'PORT'), source: 'PORT' } : null
}

// Every spelling vite reads as this flag, negations included: a later false
// one would override the `--strictPort` added after the chosen port.
const STRICT_PORT_FLAG = /^--(no-)?strictPort(=.*)?$/

/** The args forwarded to vite: the port flags are re-added from the chosen port. */
export const viteArgsWithout = args => {
  const rest = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') i++
    else if (args[i] !== '--' && !STRICT_PORT_FLAG.test(args[i]) && !args[i].startsWith('--port=')) rest.push(args[i])
  }
  return rest
}

/** stdout of a command, or null when it is missing or fails (lsof also exits 1 on no match).
 *  The C locale keeps output parseable: `ps -o lstart` follows the locale's date format. */
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
  return result.status === 0 ? result.stdout : null
}

// Skip the kernel calls that can block (stat of every mount) and their
// warnings: without them a call took 2–3.5s on an idle Mac, with them ~0.4s.
const LSOF_QUIET = ['-b', '-w']

/** `lsof -F` output as one entry per process: its pid and its `n` (name) fields. */
export const parseLsofFields = output => {
  const processes = []
  for (const line of (output ?? '').split('\n')) {
    if (line.startsWith('p')) processes.push({ pid: Number(line.slice(1)), names: [] })
    else if (line.startsWith('n')) processes.at(-1)?.names.push(line.slice(1))
  }
  return processes
}

/** Port → pids with a TCP listener on it, on any address. */
export const listListeners = (exec = run) => {
  const byPort = new Map()
  for (const { pid, names } of parseLsofFields(exec('lsof', [...LSOF_QUIET, '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn']))) {
    for (const name of names) {
      const port = Number(name.match(/:(\d+)$/)?.[1])
      if (!port) continue
      if (!byPort.has(port)) byPort.set(port, new Set())
      byPort.get(port).add(pid)
    }
  }
  return byPort
}

export const canBind = (port, host) => new Promise(resolve => {
  const server = createServer()
  // EADDRNOTAVAIL: this machine has no such address, so nothing holds the port on it.
  server.once('error', error => resolve(error.code === 'EADDRNOTAVAIL'))
  server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
})

/** Both loopback families: vite binds `localhost` (`::1` on macOS), and a browser tries either. */
export const loopbackFree = async port =>
  (await Promise.all(['127.0.0.1', '::1'].map(host => canBind(port, host)))).every(Boolean)

/** Busy when lsof sees a listener, which covers a wildcard (`0.0.0.0`, `::`) that does not block a
 *  loopback bind on macOS, or when a loopback bind fails, which covers a missing lsof. */
export const portIsBusy = async (port, listeners) => listeners.has(port) || !(await loopbackFree(port))

/** The first usable port, and the busy ports it found on the way. `port` is null when none is usable. */
export const pickPort = async ({ requested, defaultPort, isBusy }) => {
  const candidates = requested
    ? [requested.port]
    : Array.from({ length: Math.min(SCAN_SPAN, 65535 - defaultPort) + 1 }, (_, i) => defaultPort + i)
  const busy = []
  for (const port of candidates) {
    if (!(await isBusy(port))) return { port, busy }
    busy.push(port)
  }
  return { port: null, busy }
}

const real = path => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** The checkout a directory is in, or null when it is in none or no longer exists. */
export const checkoutOf = (dir, exec = run) => {
  const output = exec('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'])
  if (!output) return null
  const [toplevel, commonDir, ref] = output.trim().split('\n')
  const branch = ref === 'HEAD'
    ? `detached at ${exec('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'])?.trim() ?? '?'}`
    : ref
  return { toplevel: real(toplevel), commonDir: real(commonDir), branch }
}

/** pid → when it started and its command line, from `ps -o pid=,lstart=,command=`. */
export const parseProcesses = output => {
  const byPid = new Map()
  for (const line of (output ?? '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/)
    if (match) byPid.set(Number(match[1]), { startedAt: new Date(match[2]), command: match[3] })
  }
  return byPid
}

export const serverKind = command => {
  if (/\bvite(\.js)?\s.*\bpreview\b/.test(command)) return 'vite preview'
  if (/\bvite(\.js)?\b/.test(command)) return 'vite dev server'
  if (/agent-cli\/dist\/server\.js\b/.test(command)) return 'agent bridge'
  return basename(command.split(' ')[0] ?? '?')
}

const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g

/** An entry file and every file it reaches through relative imports, as paths
 *  relative to the entry's directory: the bridge's code is server.js plus the
 *  config.js and protocol.js it imports, and any of them can be what differs. */
export const moduleClosure = entry => {
  const seen = new Set()
  const visit = file => {
    if (seen.has(file)) return
    seen.add(file)
    if (!existsSync(file)) return
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) visit(resolve(dirname(file), spec))
  }
  visit(entry)
  return [...seen].map(file => relative(dirname(entry), file)).sort()
}

const sameFiles = (dirA, dirB, files) =>
  files.every(file => existsSync(join(dirB, file)) && readFileSync(join(dirA, file)).equals(readFileSync(join(dirB, file))))

/** Written after a process started at `startedAt`, which ps gives to the whole second: a file
 *  from within that second may predate the start, so only a later second counts. */
const writtenAfterStart = (file, startedAt) => statSync(file).mtimeMs >= startedAt.getTime() + 1000

/** A bridge keeps running the code it loaded, whatever later happens to its files. */
export const bridgeBuildNote = ({ script, startedAt }, ownScript) => {
  if (!existsSync(script)) return 'its server.js no longer exists'
  const dir = dirname(script)
  const files = moduleClosure(script)
  if (files.some(file => !existsSync(join(dir, file)) || writtenAfterStart(join(dir, file), startedAt))) {
    return 'its build was rebuilt after it started'
  }
  if (!existsSync(ownScript)) return null
  // Equal files mean equal imports, so this checkout's closure is the same set.
  return sameFiles(dir, dirname(ownScript), files)
    ? 'same build as this checkout'
    : 'a different build from this checkout'
}

/** The bridge script a command line runs, absolute: `pnpm agent:server` passes it relative to the bridge's cwd. */
export const bridgeScript = (command, cwd) => {
  const script = command.match(/(\S*agent-cli\/dist\/server\.js)\b/)?.[1]
  if (!script) return undefined
  return isAbsolute(script) ? script : cwd ? resolve(cwd, script) : undefined
}

/** What is known about each listening process: its ports, age, command and checkout. */
export const inspectServers = (pidsByPort, { exec = run, root = ROOT } = {}) => {
  const portsByPid = new Map()
  for (const [port, pids] of pidsByPort) {
    for (const pid of pids) portsByPid.set(pid, [...(portsByPid.get(pid) ?? []), port])
  }
  if (portsByPid.size === 0) return []
  const pidList = [...portsByPid.keys()].join(',')
  const processes = parseProcesses(exec('ps', ['-o', 'pid=,lstart=,command=', '-p', pidList]))
  const cwds = new Map(parseLsofFields(exec('lsof', [...LSOF_QUIET, '-a', '-d', 'cwd', '-p', pidList, '-Fn']))
    .map(({ pid, names }) => [pid, names[0]]))
  const checkouts = new Map()
  const checkoutCached = cwd => {
    if (!checkouts.has(cwd)) checkouts.set(cwd, checkoutOf(cwd, exec))
    return checkouts.get(cwd)
  }
  return [...portsByPid].map(([pid, ports]) => {
    const { startedAt = null, command = '' } = processes.get(pid) ?? {}
    const cwd = cwds.get(pid) ?? null
    const kind = serverKind(command)
    const script = kind === 'agent bridge' ? bridgeScript(command, cwd) : undefined
    return {
      pid,
      ports: ports.sort((a, b) => a - b),
      startedAt,
      command,
      kind,
      cwd,
      checkout: cwd ? checkoutCached(cwd) : null,
      note: script && startedAt ? bridgeBuildNote({ script, startedAt }, join(root, BRIDGE_SCRIPT)) : null,
    }
  })
}

export const formatAge = ms => {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export const formatServer = (server, here, now = Date.now()) => {
  const where = server.checkout
    ? `${server.checkout.toplevel} on ${server.checkout.branch}`
      + (server.checkout.toplevel === here?.toplevel ? ' (this worktree)' : ' (NOT this worktree)')
    : server.cwd === null ? 'a directory lsof could not read'
    : existsSync(server.cwd) ? `${server.cwd} (not a checkout)` : 'a directory that no longer exists'
  const age = server.startedAt ? `, up ${formatAge(now - server.startedAt.getTime())}` : ''
  return `port ${server.ports.join(',')}: ${server.kind} (pid ${server.pid}${age}) in ${where}`
    + (server.note ? `; ${server.note}` : '')
}

/** One line per holder of `port`, or a line saying lsof could not name one. */
const describePort = (port, listeners, here, exec) => {
  const holders = inspectServers(new Map([[port, listeners.get(port) ?? new Set()]]), { exec })
  return holders.length
    ? holders.map(server => formatServer(server, here))
    : [`port ${port}: held by a process lsof cannot name (another user's, or lsof is missing)`]
}

/** Choose the port, report every busy one with its holder, and start vite on the chosen one. */
export const startDevServer = async ({
  mode,
  args,
  env = process.env,
  exec = run,
  isBusy,
  log = line => console.error(line),
  spawnVite,
}) => {
  const { viteArgs, defaultPort } = MODES[mode]
  const here = checkoutOf(ROOT, exec)
  const listeners = listListeners(exec)
  const requested = requestedPort(args, env)
  const { port, busy } = await pickPort({
    requested,
    defaultPort,
    isBusy: isBusy ?? (candidate => portIsBusy(candidate, listeners)),
  })
  for (const busyPort of busy) {
    for (const line of describePort(busyPort, listeners, here, exec)) log(`[dev-server] ${line}`)
  }
  if (port === null) {
    log(requested
      ? `[dev-server] port ${requested.port} (from ${requested.source}) is taken; not starting. `
        + 'Use the server above only if it is this worktree\'s own.'
      : `[dev-server] no free port in ${defaultPort}-${defaultPort + SCAN_SPAN}; not starting.`)
    return 1
  }
  log(`[dev-server] ${mode} for ${here?.toplevel ?? ROOT} on ${here?.branch ?? '?'}: http://localhost:${port}/`)
  const code = await spawnVite([...viteArgs, '--port', String(port), '--strictPort', ...viteArgsWithout(args)])
  // Lost a race for the port between the check and vite's own bind: name who won it.
  const after = code === 0 ? null : listListeners(exec)
  if (after && await (isBusy ?? (candidate => portIsBusy(candidate, after)))(port)) {
    for (const line of describePort(port, after, here, exec)) log(`[dev-server] ${line}`)
  }
  return code
}

const viteBin = () =>
  join(dirname(createRequire(join(ROOT, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js')

const spawnViteProcess = viteArgs => new Promise(resolve => {
  const child = spawn(process.execPath, [viteBin(), ...viteArgs], { cwd: ROOT, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
  child.on('exit', code => resolve(code ?? 1))
})

/** Every listening server whose directory is a checkout of this repository, or the holders of `ports`.
 *  A port is busy by the same test the launcher uses, so `free` here means the launcher could bind it. */
export const whoHolds = async (ports, { exec = run } = {}) => {
  const here = checkoutOf(ROOT, exec)
  const listeners = listListeners(exec)
  if (ports.length > 0) {
    const lines = []
    for (const port of ports) {
      lines.push(...(await portIsBusy(port, listeners) ? describePort(port, listeners, here, exec) : [`port ${port}: free`]))
    }
    return lines
  }
  if (listeners.size === 0 && exec('lsof', ['-v']) === null) {
    return ['lsof is not available, so servers cannot be listed; `pnpm dev:who <port>` still says whether a port is taken']
  }
  const servers = inspectServers(listeners, { exec })
    .filter(server => server.checkout && server.checkout.commonDir === here?.commonDir)
    .sort((a, b) => a.ports[0] - b.ports[0])
  return servers.length
    ? servers.map(server => formatServer(server, here))
    : ['no server from a checkout of this repository is listening']
}

if (isMainModule(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2)
  try {
    if (mode === 'who') {
      for (const line of await whoHolds(args.map(arg => parsePort(arg, 'port')))) console.log(line)
    } else if (mode in MODES) {
      process.exitCode = await startDevServer({ mode, args, spawnVite: spawnViteProcess })
    } else {
      throw new Error('usage: dev-server.mjs dev|preview [vite args…] | who [port…]')
    }
  } catch (error) {
    console.error(`[dev-server] ${error.message}`)
    process.exitCode = 2
  }
}
