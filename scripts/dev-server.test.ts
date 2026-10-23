import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeBuildNote,
  bridgeScript,
  canBind,
  formatServer,
  forwardStopSignals,
  inspectServers,
  listListeners,
  loopbackFree,
  moduleClosure,
  parseLsofFields,
  parseProcesses,
  pickPort,
  portIsBusy,
  requestedPort,
  serverKind,
  startDevServer,
  viteArgsWithout,
  whoHolds,
} from './dev-server.mjs'

const ROOT = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const hasLsof = spawnSync('lsof', ['-v']).error === undefined

// Each case below spawns a listener process and runs lsof/ps/git against it:
// ~40–150ms on a quiet machine, up to 4s at a load average of 700.
const SPAWNING_TEST_TIMEOUT = 30_000

const children = new Set<ChildProcess>()
const dirs = new Set<string>()

afterEach(() => {
  for (const child of children) child.kill()
  children.clear()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.clear()
})

const tempDir = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dev-server-test-')))
  dirs.add(dir)
  return dir
}

/** A separate process listening on `host`: a same-process listener can bind differently. */
const holdPort = (host: string, cwd = ROOT) => new Promise<{ pid: number, port: number }>((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', `
    const server = require('node:net').createServer()
    server.listen({port: 0, host: ${JSON.stringify(host)}}, () => console.log(server.address().port))
  `], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
  children.add(child)
  child.once('error', reject)
  child.once('exit', code => reject(new Error(`listener on ${host} exited (${code}) before listening`)))
  child.stdout!.once('data', data => resolve({ pid: child.pid!, port: Number(String(data).trim()) }))
})

describe('requestedPort / viteArgsWithout', () => {
  it('takes an explicit --port in either form over PORT', () => {
    expect(requestedPort(['--port', '5188'], { PORT: '5174' })).toEqual({ port: 5188, source: '--port' })
    expect(requestedPort(['--host', '--port=5188'], {})).toEqual({ port: 5188, source: '--port' })
  })

  it('falls back to PORT, then to scanning', () => {
    expect(requestedPort([], { PORT: '5174' })).toEqual({ port: 5174, source: 'PORT' })
    expect(requestedPort(['--host'], {})).toBeNull()
  })

  it('refuses a value that is not a port', () => {
    expect(() => requestedPort(['--port'], {})).toThrow(/--port must be a port number/)
    expect(() => requestedPort([], { PORT: '51x' })).toThrow(/PORT must be a port number/)
    expect(() => requestedPort(['--port=70000'], {})).toThrow(/--port/)
  })

  it('forwards everything but the port flags, which the launcher re-adds', () => {
    expect(viteArgsWithout(['--', '--host', '--port', '5188', '--strictPort', '--port=1', '--open']))
      .toEqual(['--host', '--open'])
  })

  it('drops every negation of --strictPort, which would override the one the launcher adds', () => {
    expect(viteArgsWithout(['--no-strictPort', '--strictPort=false', '--strictPort=true', '--host'])).toEqual(['--host'])
    expect(viteArgsWithout(['--no-strict-port', '--strict-port=false', '--strict-port'])).toEqual([])
  })
})

describe('pickPort', () => {
  const busyAmong = (...ports: number[]) => async (port: number) => ports.includes(port)

  it('uses a requested port exactly, never moving off it', async () => {
    expect(await pickPort({ requested: { port: 5174 }, defaultPort: 5173, isBusy: busyAmong() }))
      .toEqual({ port: 5174, busy: [] })
    expect(await pickPort({ requested: { port: 5174 }, defaultPort: 5173, isBusy: busyAmong(5174) }))
      .toEqual({ port: null, busy: [5174] })
  })

  it('otherwise scans up from the default, collecting the busy ports it passed', async () => {
    expect(await pickPort({ requested: null, defaultPort: 5173, isBusy: busyAmong(5173, 5174) }))
      .toEqual({ port: 5175, busy: [5173, 5174] })
  })

  it('gives up after the scan span', async () => {
    const result = await pickPort({ requested: null, defaultPort: 5173, isBusy: async () => true })
    expect(result.port).toBeNull()
    expect(result.busy).toEqual(Array.from({ length: 21 }, (_, i) => 5173 + i))
  })
})

describe('output parsers', () => {
  it('reads every listener address lsof reports, wildcard and IPv6 included', () => {
    const output = 'p10\nf12\nn[::1]:5173\np11\nf3\nn*:5174\nf4\nn*:5174\np12\nf9\nn127.0.0.1:8787\n'
    expect(parseLsofFields(output)).toEqual([
      { pid: 10, names: ['[::1]:5173'] },
      { pid: 11, names: ['*:5174', '*:5174'] },
      { pid: 12, names: ['127.0.0.1:8787'] },
    ])
    expect(listListeners(() => output)).toEqual(new Map([
      [5173, new Set([10])],
      [5174, new Set([11])],
      [8787, new Set([12])],
    ]))
    expect(listListeners(() => null)).toEqual(new Map())
  })

  it('reads ps start times, including a space-padded day', () => {
    const processes = parseProcesses([
      '13994 Sun Oct 18 23:48:31 2026     /usr/bin/node /wt/packages/agent-cli/dist/server.js',
      '  512 Fri Oct  2 06:08:29 2026 node vite.js --port 5173',
    ].join('\n'))
    expect(processes.get(13994)).toEqual({
      startedAt: new Date(2026, 9, 18, 23, 48, 31),
      command: '/usr/bin/node /wt/packages/agent-cli/dist/server.js',
    })
    expect(processes.get(512)?.startedAt).toEqual(new Date(2026, 9, 2, 6, 8, 29))
  })

  it('names the servers it knows', () => {
    expect(serverKind('node /wt/node_modules/.bin/../vite/bin/vite.js --port 5173 --strictPort')).toBe('vite dev server')
    expect(serverKind('node /wt/node_modules/vite/bin/vite.js preview --port 4173')).toBe('vite preview')
    expect(serverKind('/usr/bin/node /wt/packages/agent-cli/dist/server.js')).toBe('agent bridge')
    expect(serverKind('/usr/local/bin/python3 -m http.server')).toBe('python3')
  })
})

describe('port probes', () => {
  it('sees an IPv6-only holder, as vite binds localhost when it resolves to ::1', { timeout: SPAWNING_TEST_TIMEOUT }, async () => {
    const { port } = await holdPort('::1')
    expect(await loopbackFree(port)).toBe(false)
  })

  it('sees an IPv4-only holder', { timeout: SPAWNING_TEST_TIMEOUT }, async () => {
    const { port } = await holdPort('127.0.0.1')
    expect(await loopbackFree(port)).toBe(false)
  })

  it.skipIf(!hasLsof)('counts a wildcard holder as busy although a loopback bind still succeeds', { timeout: SPAWNING_TEST_TIMEOUT }, async () => {
    const { port } = await holdPort('0.0.0.0')
    // The premise: on macOS a loopback bind succeeds under a wildcard listener.
    // Linux refuses it, which lets the bind probe alone catch the holder there.
    if (process.platform === 'darwin') expect(await loopbackFree(port)).toBe(true)
    expect(await portIsBusy(port, listListeners())).toBe(true)
  })

  it('treats an address this machine lacks as holding nothing', async () => {
    // 192.0.2.1 is TEST-NET-1: never a local address, so the bind fails EADDRNOTAVAIL,
    // as a `::1` bind does on a machine without IPv6 loopback.
    expect(await canBind(5173, '192.0.2.1')).toBe(true)
  })

  it('reports a port nothing holds as free', { timeout: SPAWNING_TEST_TIMEOUT }, async () => {
    const { port } = await holdPort('::1')
    children.forEach(child => child.kill())
    await vi.waitFor(async () => expect(await loopbackFree(port)).toBe(true), { timeout: 10_000 })
    expect(await portIsBusy(port, new Map())).toBe(false)
  })
})

/** A port nothing listens on: the OS hands one out, and it is closed again at once. */
const freePort = () => new Promise<number>(resolve => {
  const server = createServer().listen({ port: 0, host: '::1' }, () => {
    const { port } = server.address() as AddressInfo
    server.close(() => resolve(port))
  })
})

describe.skipIf(!hasLsof)('whoHolds', { timeout: SPAWNING_TEST_TIMEOUT }, () => {
  it('names the holder and the checkout it runs in', async () => {
    const { pid, port } = await holdPort('::1')
    const [line] = await whoHolds([port])
    expect(line).toContain(`port ${port}: node (pid ${pid}, up `)
    expect(line).toContain(`in ${ROOT} on `)
    expect(line).toMatch(/\(this worktree\)$/)
  })

  it('reads ps under the C locale, which is the date format it parses', async () => {
    // ps formats its start time with the locale's date names: `Do. 22 Okt.` under German.
    vi.stubEnv('LC_ALL', 'de_DE.UTF-8')
    try {
      const { pid, port } = await holdPort('::1')
      expect(await whoHolds([port])).toEqual([expect.stringContaining(`port ${port}: node (pid ${pid}, up `)])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('says when the holder runs outside any checkout', async () => {
    const dir = tempDir()
    const { port } = await holdPort('::1', dir)
    expect(await whoHolds([port])).toEqual([expect.stringContaining(`in ${dir} (not a checkout)`)])
  })

  it('keeps the live holders when another pid it asked about has exited', async () => {
    // lsof exits 1 when any pid in its list is gone, and still lists the live ones.
    const done = spawn(process.execPath, ['-e', ''])
    const deadPid = done.pid!
    await new Promise(resolve => done.once('exit', resolve))
    const { pid, port } = await holdPort('::1')
    const servers = inspectServers(new Map([[port, new Set([pid, deadPid])]]))
    expect(servers.find(server => server.pid === pid)?.checkout?.toplevel).toBe(ROOT)
  })

  it('reports a port with no listener as free', async () => {
    const port = await freePort()
    expect(await whoHolds([port])).toEqual([`port ${port}: free`])
  })
})

describe('whoHolds without lsof', { timeout: SPAWNING_TEST_TIMEOUT }, () => {
  it('still calls a held port taken, by the launcher\'s own bind probe', async () => {
    const { port } = await holdPort('::1')
    expect(await whoHolds([port], { exec: () => null })).toEqual([
      `port ${port}: held by a process lsof cannot name (another user's, one starting or stopping right now, or lsof is missing)`,
    ])
  })

  it('says it cannot list servers rather than that none run', async () => {
    expect(await whoHolds([], { exec: () => null })).toEqual([
      expect.stringMatching(/^lsof is not available, so servers cannot be listed/),
    ])
  })
})

// Canned output: the real listing inspects every listener on the machine.
it('lists only servers in a checkout of this repository when given no port', async () => {
  const git = (dir: string) => ({
    [ROOT]: `${ROOT}\n/repo/.git\nclaude/here\n`,
    '/repo/wt-b': '/repo/wt-b\n/repo/.git\nclaude/b\n',
    '/elsewhere': '/elsewhere\n/elsewhere/.git\nmain\n',
  })[dir] ?? null
  const ps = (pid: number, command: string) => `${pid} Thu Oct 22 16:58:29 2026 ${command}\n`
  const exec = (command: string, args: string[]) => {
    if (command === 'git') return git(args[1])
    if (command === 'ps') return ps(1, 'node vite.js') + ps(2, 'node vite.js') + ps(3, 'node vite.js') + ps(4, 'python3 -m http.server') + ps(5, 'node vite.js')
    return args.includes('cwd')
      ? 'p1\nfcwd\nn/repo/wt-b\np2\nfcwd\nn/elsewhere\np3\nfcwd\nn/gone/wt-c\np4\nfcwd\nn/gone/other\np5\nfcwd\nn/\n'
      : 'p1\nf3\nn[::1]:5173\np2\nf3\nn[::1]:5174\np3\nf3\nn[::1]:5175\np4\nf3\nn[::1]:5176\np5\nf3\nn[::1]:5177\n'
  }
  expect(await whoHolds([], { exec })).toEqual([
    expect.stringMatching(/^port 5173: vite dev server \(pid 1, up .*\) in \/repo\/wt-b on claude\/b \(NOT this worktree\)$/),
    // A deleted worktree's server: the stale case this listing exists to show.
    expect.stringMatching(/^port 5175: vite dev server \(pid 3, up .*\) in a directory that no longer exists$/),
  ])
})

describe('formatServer', () => {
  const here = { toplevel: '/repo/wt-a', commonDir: '/repo/.git', branch: 'claude/a' }
  const server = {
    pid: 7,
    ports: [5173],
    startedAt: new Date(0),
    command: 'node vite.js',
    kind: 'vite dev server',
    cwd: '/repo/wt-b',
    checkout: { toplevel: '/repo/wt-b', commonDir: '/repo/.git', branch: 'claude/b' },
    note: null,
  }

  it('flags another worktree\'s server', () => {
    expect(formatServer(server, here, 90 * 60_000))
      .toBe('port 5173: vite dev server (pid 7, up 1h 30m) in /repo/wt-b on claude/b (NOT this worktree)')
  })

  it('says when the holder\'s directory is gone', () => {
    expect(formatServer({ ...server, cwd: '/no/such/dir', checkout: null, note: 'its server.js no longer exists' }, here, 3 * 86_400_000))
      .toBe('port 5173: vite dev server (pid 7, up 3d 0h) in a directory that no longer exists; its server.js no longer exists')
  })

  it('does not call a directory lsof could not read gone', () => {
    expect(formatServer({ ...server, cwd: null, checkout: null }, here, 0))
      .toBe('port 5173: vite dev server (pid 7, up 0s) in a directory lsof could not read')
  })
})

describe('bridge build', () => {
  const startedAt = new Date(2_000_000_000_000)
  const beforeStart = startedAt.getTime() / 1000 - 60
  /** A dist directory shaped like agent-cli's: server.js importing config.js and protocol.js. */
  const dist = (protocol = 'schemas v1', root = tempDir()) => {
    const dir = join(root, 'packages', 'agent-cli', 'dist')
    mkdirSync(dir, { recursive: true })
    const files = {
      'server.js': "import { a } from './config.js';\nimport { b } from './protocol.js';\n",
      'config.js': "import fs from 'node:fs/promises';\n",
      'protocol.js': protocol,
    }
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content)
      utimesSync(join(dir, name), beforeStart, beforeStart)
    }
    return { root, script: join(dir, 'server.js') }
  }

  it('walks the relative imports, not the packages', () => {
    expect(moduleClosure(dist().script)).toEqual(['config.js', 'protocol.js', 'server.js'])
  })

  it('compares every module the bridge runs, not only server.js', () => {
    const { script } = dist('schemas v1')
    expect(bridgeBuildNote({ script, startedAt }, dist('schemas v1').script)).toBe('same build as this checkout')
    expect(bridgeBuildNote({ script, startedAt }, dist('schemas v2').script)).toBe('a different build from this checkout')
    expect(bridgeBuildNote({ script, startedAt }, join(tempDir(), 'server.js'))).toBeNull()
  })

  it('does not call a file from the second the bridge started a rebuild', () => {
    // ps gives the start time to the whole second; the file may have been written before the start within it.
    const { script } = dist()
    const protocol = join(dirname(script), 'protocol.js')
    utimesSync(protocol, startedAt.getTime() / 1000 + 0.4, startedAt.getTime() / 1000 + 0.4)
    expect(bridgeBuildNote({ script, startedAt }, script)).toBe('same build as this checkout')
    utimesSync(protocol, startedAt.getTime() / 1000 + 1, startedAt.getTime() / 1000 + 1)
    expect(bridgeBuildNote({ script, startedAt }, script)).toBe('its build was rebuilt after it started')
  })

  it('says when the code it runs is no longer what is on disk', () => {
    const { script } = dist()
    const protocol = join(dirname(script), 'protocol.js')
    utimesSync(protocol, beforeStart + 120, beforeStart + 120)
    expect(bridgeBuildNote({ script, startedAt }, script)).toBe('its build was rebuilt after it started')
    rmSync(protocol)
    expect(bridgeBuildNote({ script, startedAt }, script)).toBe('its build was rebuilt after it started')
    rmSync(script)
    expect(bridgeBuildNote({ script, startedAt }, script)).toBe('its server.js no longer exists')
  })

  it('resolves the relative path `pnpm agent:server` passes against the bridge\'s own cwd', () => {
    expect(bridgeScript('node packages/agent-cli/dist/server.js', '/wt')).toBe('/wt/packages/agent-cli/dist/server.js')
    expect(bridgeScript('/usr/bin/node /wt/packages/agent-cli/dist/server.js', '/elsewhere')).toBe('/wt/packages/agent-cli/dist/server.js')
    expect(bridgeScript('/usr/bin/node /wt/packages/agent-cli/dist/server.js', null)).toBe('/wt/packages/agent-cli/dist/server.js')
    expect(bridgeScript('node packages/agent-cli/dist/server.js', null)).toBeUndefined()
    expect(bridgeScript('node vite.js', '/wt')).toBeUndefined()
  })

  it('judges another worktree\'s bridge by that worktree\'s files', () => {
    const holder = dist('schemas v1')
    const own = dist('schemas v1')
    const exec = (command: string, args: string[]) => {
      if (command === 'ps') return '9 Mon Jan  1 00:00:00 2035 node packages/agent-cli/dist/server.js\n'
      if (command === 'lsof') return args.includes('cwd') ? `p9\nfcwd\nn${holder.root}\n` : null
      return null
    }
    const [server] = inspectServers(new Map([[8787, new Set([9])]]), { exec, root: own.root })
    expect(server.note).toBe('same build as this checkout')
  })
})

describe('forwardStopSignals', () => {
  it('passes a stop signal to vite, then stops listening once vite exits', { timeout: SPAWNING_TEST_TIMEOUT }, async () => {
    // A stand-in for `process`, so the test never signals the vitest worker itself.
    const source = new EventEmitter()
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    children.add(child)
    await new Promise(resolve => child.once('spawn', resolve))
    forwardStopSignals(child, source)
    const exited = new Promise(resolve => child.once('exit', (_code, signal) => resolve(signal)))
    source.emit('SIGTERM', 'SIGTERM')
    expect(await exited).toBe('SIGTERM')
    expect(source.listenerCount('SIGTERM')).toBe(0)
  })
})

describe('startDevServer', () => {
  const launch = async (options: { mode?: 'dev' | 'preview', args?: string[], env?: Record<string, string>, busy?: number[] }) => {
    const log: string[] = []
    const spawnVite = vi.fn(async () => 0)
    const code = await startDevServer({
      mode: options.mode ?? 'dev',
      args: options.args ?? [],
      env: options.env ?? {},
      exec: () => null,
      isBusy: async port => (options.busy ?? []).includes(port),
      log: line => log.push(line),
      spawnVite,
    })
    return { code, log, spawnVite }
  }

  it('binds exactly the port the desktop app assigned', async () => {
    const { code, log, spawnVite } = await launch({ env: { PORT: '5174' }, args: ['--host'] })
    expect(code).toBe(0)
    expect(spawnVite).toHaveBeenCalledWith(['--port', '5174', '--strictPort', '--host'])
    expect(log.at(-1)).toMatch(/: http:\/\/localhost:5174\/$/)
  })

  it('refuses a taken assigned port, naming it, without starting vite', async () => {
    const { code, log, spawnVite } = await launch({ env: { PORT: '5174' }, busy: [5174] })
    expect(code).toBe(1)
    expect(spawnVite).not.toHaveBeenCalled()
    expect(log).toEqual([
      '[dev-server] port 5174: held by a process lsof cannot name (another user\'s, one starting or stopping right now, or lsof is missing)',
      expect.stringContaining('port 5174 (from PORT) is taken; not starting.'),
    ])
  })

  it('reports each busy port it skips on the way to a free one', async () => {
    const { log, spawnVite } = await launch({ busy: [5173] })
    expect(spawnVite).toHaveBeenCalledWith(['--port', '5174', '--strictPort'])
    expect(log[0]).toMatch(/^\[dev-server\] port 5173: /)
  })

  it('names whoever won the port when vite then fails to bind it', async () => {
    const log: string[] = []
    let viteRan = false
    const code = await startDevServer({
      mode: 'dev',
      args: [],
      env: { PORT: '5174' },
      // The listener appears only once vite has run: it took the port between the check and the bind.
      exec: (command: string, args: string[]) => {
        if (!viteRan || command === 'git') return null
        if (command === 'ps') return '9 Thu Oct 22 16:58:29 2026 node /other/node_modules/vite/bin/vite.js\n'
        return args.includes('cwd') ? 'p9\nfcwd\nn/\n' : 'p9\nf3\nn[::1]:5174\n'
      },
      isBusy: async () => viteRan,
      log: line => log.push(line),
      spawnVite: async () => {
        viteRan = true
        return 1
      },
    })
    expect(code).toBe(1)
    expect(log.at(-1)).toMatch(/^\[dev-server\] port 5174: vite dev server \(pid 9, up .*\) in \/ \(not a checkout\)$/)
  })

  it('still reports a lost race when lsof cannot name the winner', async () => {
    const log: string[] = []
    let viteRan = false
    await startDevServer({
      mode: 'dev',
      args: [],
      env: { PORT: '5174' },
      exec: () => null,
      isBusy: async () => viteRan,
      log: line => log.push(line),
      spawnVite: async () => {
        viteRan = true
        return 1
      },
    })
    expect(log.at(-1)).toBe('[dev-server] port 5174: held by a process lsof cannot name (another user\'s, one starting or stopping right now, or lsof is missing)')
  })

  it('runs vite preview from its own default port', async () => {
    const { spawnVite } = await launch({ mode: 'preview' })
    expect(spawnVite).toHaveBeenCalledWith(['preview', '--port', '4173', '--strictPort'])
  })
})
