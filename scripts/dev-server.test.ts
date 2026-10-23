import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bridgeBuildNote,
  canBind,
  formatServer,
  listListeners,
  loopbackFree,
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
// 0.3–2.3s on a quiet machine, up to 4s at a load average of 700.
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
  it('sees an IPv6-only holder, which is how vite binds localhost', { timeout: SPAWNING_TEST_TIMEOUT }, async () => {
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

describe.skipIf(!hasLsof)('whoHolds', { timeout: SPAWNING_TEST_TIMEOUT }, () => {
  it('names the holder and the checkout it runs in', async () => {
    const { pid, port } = await holdPort('::1')
    const [line] = whoHolds([port])
    expect(line).toContain(`port ${port}: node (pid ${pid}, up `)
    expect(line).toContain(`in ${ROOT} on `)
    expect(line).toMatch(/\(this worktree\)$/)
  })

  it('says when the holder runs outside any checkout', async () => {
    const dir = tempDir()
    const { port } = await holdPort('::1', dir)
    expect(whoHolds([port])).toEqual([expect.stringContaining(`in ${dir} (not a checkout)`)])
  })

  it('reports a port with no listener as free', () => {
    expect(whoHolds([1])).toEqual(['port 1: free'])
  })
})

// Canned output: the real listing inspects every listener on the machine.
it('lists only servers in a checkout of this repository when given no port', () => {
  const git = (dir: string) => ({
    [ROOT]: `${ROOT}\n/repo/.git\nclaude/here\n`,
    '/repo/wt-b': '/repo/wt-b\n/repo/.git\nclaude/b\n',
    '/elsewhere': '/elsewhere\n/elsewhere/.git\nmain\n',
  })[dir] ?? null
  const exec = (command: string, args: string[]) => {
    if (command === 'git') return git(args[1])
    if (command === 'ps') return '1 Thu Oct 22 16:58:29 2026 node vite.js\n2 Thu Oct 22 16:58:29 2026 node vite.js\n'
    return args.includes('cwd')
      ? 'p1\nfcwd\nn/repo/wt-b\np2\nfcwd\nn/elsewhere\n'
      : 'p1\nf3\nn[::1]:5173\np2\nf3\nn[::1]:5174\n'
  }
  expect(whoHolds([], { exec })).toEqual([
    expect.stringMatching(/^port 5173: vite dev server \(pid 1, up .*\) in \/repo\/wt-b on claude\/b \(NOT this worktree\)$/),
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
})

describe('bridgeBuildNote', () => {
  const startedAt = new Date(2_000_000_000_000)
  const files = () => {
    const dir = tempDir()
    const script = join(dir, 'server.js')
    const own = join(dir, 'own-server.js')
    writeFileSync(script, 'bridge v1')
    utimesSync(script, startedAt.getTime() / 1000 - 60, startedAt.getTime() / 1000 - 60)
    return { script, own }
  }

  it('compares an untouched script with this checkout\'s build', () => {
    const { script, own } = files()
    writeFileSync(own, 'bridge v1')
    expect(bridgeBuildNote({ script, startedAt }, own)).toBe('same build as this checkout')
    writeFileSync(own, 'bridge v2')
    expect(bridgeBuildNote({ script, startedAt }, own)).toBe('a different build from this checkout')
    rmSync(own)
    expect(bridgeBuildNote({ script, startedAt }, own)).toBeNull()
  })

  it('says the running code is no longer on disk', () => {
    const { script, own } = files()
    utimesSync(script, startedAt.getTime() / 1000 + 60, startedAt.getTime() / 1000 + 60)
    expect(bridgeBuildNote({ script, startedAt }, own)).toBe('its server.js was rebuilt after it started')
    rmSync(script)
    expect(bridgeBuildNote({ script, startedAt }, own)).toBe('its server.js no longer exists')
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
      '[dev-server] port 5174: held by a process lsof cannot name (another user\'s, or lsof is missing)',
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
      isBusy: async () => false,
      log: line => log.push(line),
      spawnVite: async () => {
        viteRan = true
        return 1
      },
    })
    expect(code).toBe(1)
    expect(log.at(-1)).toMatch(/^\[dev-server\] port 5174: vite dev server \(pid 9, up .*\) in \/ \(not a checkout\)$/)
  })

  it('runs vite preview from its own default port', async () => {
    const { spawnVite } = await launch({ mode: 'preview' })
    expect(spawnVite).toHaveBeenCalledWith(['preview', '--port', '4173', '--strictPort'])
  })
})
