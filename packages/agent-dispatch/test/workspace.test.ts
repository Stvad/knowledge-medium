import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {BILLING_ENV_DENYLIST} from '../src/runner'
import {
  ensurePrivateDir,
  resolveWorkspaceCwd,
  WORKSPACE_APPROVED_TOOLS,
  workspaceEnv,
  workspaceSettings,
  workspaceThreadDir,
  workspaceTmpDir,
} from '../src/workspace'

const root = '/Users/someone/Library/Application Support/km-agent-dispatch/workspaces/notes-agent'
const realTmp = fs.realpathSync('/tmp')

describe('workspaceTmpDir', () => {
  it('is short and stable per root, so sandboxed commands keep it as their temp dir', () => {
    // Claude Code gives sandboxed commands a shared fallback under /tmp when this path is long.
    const dir = workspaceTmpDir(root)
    expect(dir).toBe(workspaceTmpDir(root))
    expect(dir).not.toBe(workspaceTmpDir(`${root}-other`))
    expect(dir.length).toBeLessThanOrEqual(24)
  })
})

describe('ensurePrivateDir', () => {
  let parent: string
  beforeEach(async () => { parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'km-ws-tmp-')) })
  afterEach(async () => { await fsp.rm(parent, {recursive: true, force: true}) })

  it('creates it readable by this user alone, and accepts it again', async () => {
    const dir = path.join(parent, 'kmd')
    await ensurePrivateDir(dir)
    await ensurePrivateDir(dir)
    expect((await fsp.stat(dir)).mode & 0o777).toBe(0o700)
  })

  it('refuses one that others can enter', async () => {
    await fsp.mkdir(path.join(parent, 'open'))
    await fsp.chmod(path.join(parent, 'open'), 0o755)
    await expect(ensurePrivateDir(path.join(parent, 'open'))).rejects.toThrow(/not a private directory/)
  })

  it('refuses something else put in its place', async () => {
    await fsp.writeFile(path.join(parent, 'file'), '', {mode: 0o600})
    await fsp.symlink(parent, path.join(parent, 'link'))
    await expect(ensurePrivateDir(path.join(parent, 'file'))).rejects.toThrow(/not a private directory/)
    await expect(ensurePrivateDir(path.join(parent, 'link'))).rejects.toThrow(/not a private directory/)
  })
})

describe('resolveWorkspaceCwd', () => {
  let parent: string
  beforeEach(async () => { parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'km-ws-cwd-')) })
  afterEach(async () => { await fsp.rm(parent, {recursive: true, force: true}) })

  it('creates the folder, and the root on a watcher\'s first run, and names it by its real path', async () => {
    const root = path.join(parent, 'root')
    const cwd = await resolveWorkspaceCwd(root, workspaceThreadDir(root, 'b1'))
    expect(cwd).toBe(path.join(await fsp.realpath(root), 'threads', 'b1'))
    expect((await fsp.stat(cwd)).isDirectory()).toBe(true)
  })

  it.each([
    ['its thread folder', (root: string) => path.join(root, 'threads', 'b1')],
    ['the threads folder', (root: string) => path.join(root, 'threads')],
  ])('refuses a run whose folder an earlier run swapped for a link out of the root: %s', async (_label, swapped) => {
    const root = path.join(parent, 'root')
    const outside = path.join(parent, 'outside')
    await fsp.mkdir(path.join(outside, 'b1'), {recursive: true})
    await fsp.mkdir(path.join(root, 'threads'), {recursive: true})
    await fsp.rm(swapped(root), {recursive: true, force: true})
    await fsp.symlink(swapped(root).endsWith('b1') ? path.join(outside, 'b1') : outside, swapped(root))
    await expect(resolveWorkspaceCwd(root, workspaceThreadDir(root, 'b1'))).rejects.toThrow(/outside/)
  })
})

describe('workspaceThreadDir', () => {
  it('is a folder per thread under the root', () => {
    expect(workspaceThreadDir(root, 'b1-x_Y')).toBe(path.join(root, 'threads', 'b1-x_Y'))
  })

  it.each(['..', 'a/b', '', '.hidden'])('refuses an id that is not a plain folder name: %j', id => {
    expect(() => workspaceThreadDir(root, id)).toThrow(/thread id/)
  })
})

describe('workspaceSettings', () => {
  const settings = workspaceSettings({root, allowedDomains: ['pypi.org']}, BILLING_ENV_DENYLIST)

  it('fails closed: the sandbox must start, and nothing retries outside it', () => {
    expect(settings.sandbox).toMatchObject({enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false})
  })

  it('grants the tools that need approval in the same document as the sandbox', () => {
    // Claude Code drops a settings document that fails validation whole: these grants go with it.
    expect(settings.permissions.allow).toEqual(WORKSPACE_APPROVED_TOOLS)
  })

  it('opens only the root and its temp dir, inside the user-data and temp areas it denies', () => {
    expect(settings.sandbox.filesystem.allowRead).toEqual([root, path.join(realTmp, path.basename(workspaceTmpDir(root)))])
    expect(settings.sandbox.filesystem.allowWrite).toEqual([root])
    expect(settings.sandbox.filesystem.denyRead).toEqual(expect.arrayContaining(['/Users', '/Volumes', realTmp]))
  })

  it('reaches only the listed hosts, refusing the rest instead of waiting on a prompt', () => {
    expect(settings.sandbox.network).toEqual({allowedDomains: ['pypi.org'], strictAllowlist: true})
  })

  it('keeps the credentials Claude Code holds out of sandboxed commands', () => {
    expect(settings.sandbox.credentials.envVars.map(entry => entry.name)).toEqual([...BILLING_ENV_DENYLIST])
    expect(new Set(settings.sandbox.credentials.envVars.map(entry => entry.mode))).toEqual(new Set(['deny']))
  })
})

describe('workspaceEnv', () => {
  const daemonEnv = {
    HOME: '/Users/someone', PATH: '/usr/bin:/bin', USER: 'someone', LANG: 'en_US.UTF-8',
    GITHUB_TOKEN: 'ghp_secret', AWS_SECRET_ACCESS_KEY: 'secret', ANTHROPIC_API_KEY: 'sk-ant',
  }

  it('passes only what Claude Code needs to run, never the rest of the daemon environment', () => {
    expect(workspaceEnv(daemonEnv, root, [])).toEqual({
      HOME: '/Users/someone', PATH: '/usr/bin:/bin', USER: 'someone', LANG: 'en_US.UTF-8',
      CLAUDE_CODE_TMPDIR: workspaceTmpDir(root),
      GIT_CONFIG_GLOBAL: '/dev/null',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
    })
  })

  it('passes the named credentials as well, and only those', () => {
    expect(workspaceEnv(daemonEnv, root, BILLING_ENV_DENYLIST)).toMatchObject({ANTHROPIC_API_KEY: 'sk-ant'})
    expect(workspaceEnv(daemonEnv, root, BILLING_ENV_DENYLIST)).not.toHaveProperty('GITHUB_TOKEN')
  })
})
