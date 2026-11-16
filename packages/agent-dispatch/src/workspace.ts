/**
 * A watcher's workspace: one persistent folder (`runner.workspace`) that a claude
 * run's Bash, file tools and `add_media` paths reach, and nothing else of the
 * user's. Each thread works in `threads/<id>/` and can read the folders of
 * earlier threads.
 *
 * Three layers, and why each is there (verified on macOS only; the daemon refuses
 * a workspace elsewhere):
 * - Bash runs in Claude Code's sandbox (`workspaceSettings`): it reads and writes
 *   the root, and is denied the home directories, temp areas and other user data.
 * - `--restricted` confines Read/Write/Edit/Glob/Grep to the working directories
 *   and ignores the user's, the project's and the folder's own settings files, so a
 *   file the run writes into its folder cannot widen a later run.
 * - Claude Code drops a `--settings` document that fails validation, whole and
 *   silently. The grants that need approval (Bash, Write, Edit) are in that same
 *   document, so a dropped one leaves them refused rather than unsandboxed.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { RunWorkspace } from './config.js'

/** The built-in tools a workspace run is offered. */
export const WORKSPACE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'] as const

/** Those of them that need approval; granted only inside `workspaceSettings`, never by `--allowedTools`. */
export const WORKSPACE_APPROVED_TOOLS = ['Bash', 'Write', 'Edit']

const THREAD_ID = /^[A-Za-z0-9_-]{1,200}$/

/** The folder a thread's runs work in. A block id is one path component, never `..`. */
export const workspaceThreadDir = (root: string, threadId: string): string => {
  if (!THREAD_ID.test(threadId)) throw new Error(`workspace: thread id ${JSON.stringify(threadId)} is not a folder name`)
  return path.join(root, 'threads', threadId)
}

/** Creates the run's folder one level at a time from the root down, refusing any level
 *  that is not a real folder: a run can swap the root, `threads/` or a thread's folder
 *  for a link before a later run starts there, and the working directory is what the
 *  file tools and the sandbox trust. Returns the real path, for the spawn and for the
 *  check that the run started there (runner.ts). The refusal names no local path: it
 *  becomes a synced reply. */
export const resolveWorkspaceCwd = async (root: string, cwd: string): Promise<string> => {
  await fsp.mkdir(path.dirname(root), {recursive: true})
  const levels = path.relative(root, cwd).split(path.sep).filter(Boolean)
  for (let depth = 0; depth <= levels.length; depth += 1) {
    const dir = path.join(root, ...levels.slice(0, depth))
    await fsp.mkdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    if (!(await fsp.lstat(dir)).isDirectory()) {
      throw new Error(`workspace: ${path.relative(path.dirname(root), dir)} is not a real folder; a run may have replaced it with a link`)
    }
  }
  return fsp.realpath(cwd)
}

/** Claude Code's temp dir for a workspace run (`CLAUDE_CODE_TMPDIR`). It must stay
 *  short: past roughly 30 characters, sandboxed commands get a temp dir under the
 *  shared `/tmp/claude-<uid>` instead, which every Claude session on the machine uses. */
export const workspaceTmpDir = (root: string): string =>
  `/tmp/kmd-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`

/** Creates the temp dir, or accepts it only as this user's own and private: it sits
 *  in the shared /tmp under a predictable name, and holds every command's output. */
export const ensurePrivateDir = async (dir: string): Promise<void> => {
  await fsp.mkdir(dir, {mode: 0o700}).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const stat = await fsp.lstat(dir)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`workspace: ${dir} is not a private directory of this user; remove it and retry`)
  }
}

/** Where macOS keeps user data and other programs' files, all of which the sandbox
 *  would otherwise let Bash read. `allowRead` reopens the root inside `/Users`.
 *  Not `permissions.blockReadsOutsideWorkingDirectories`: it denies much the same, but
 *  also refuses commands whose paths it cannot trace (`mkdir d && cd d`). */
const deniedReads = (realTmp: string) => [
  '/Users',
  '/Volumes',
  realTmp,
  '/private/var/folders',
  '/opt/homebrew/var',
  '/usr/local/var',
]

/** `credentialEnv`: variables Claude Code may hold that sandboxed commands must not see. */
export const workspaceSettings = ({root, allowedDomains}: RunWorkspace, credentialEnv: readonly string[]) => {
  const realTmp = fs.realpathSync('/tmp')
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: deniedReads(realTmp),
        allowRead: [root, path.join(realTmp, path.basename(workspaceTmpDir(root)))],
        allowWrite: [root],
        // Defence in depth: the shared temp dir sandboxed commands fall back to when ours is too long.
        denyWrite: [path.join(realTmp, `claude-${process.getuid?.() ?? 0}`)],
      },
      network: {allowedDomains, strictAllowlist: true},
      credentials: {envVars: credentialEnv.map(name => ({name, mode: 'deny' as const}))},
    },
    permissions: {allow: WORKSPACE_APPROVED_TOOLS},
  }
}

/** Daemon environment variables a workspace run keeps: what Claude Code needs to
 *  start and sign in. Bash inherits Claude Code's environment, so the daemon's must
 *  not reach it. */
const PASSED_ENV = [
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', '__CF_USER_TEXT_ENCODING',
  'CLAUDE_CONFIG_DIR', 'NODE_EXTRA_CA_CERTS',
]

/** `credentialEnv`: variables to pass as well, such as an API key the run bills to. */
export const workspaceEnv = (env: NodeJS.ProcessEnv, root: string, credentialEnv: readonly string[]): NodeJS.ProcessEnv => {
  const passed = [...PASSED_ENV, ...credentialEnv]
  return {
    ...Object.fromEntries(passed.filter(name => env[name] !== undefined).map(name => [name, env[name]])),
    CLAUDE_CODE_TMPDIR: workspaceTmpDir(root),
    // The user's global git config is unreadable in the sandbox, and git refuses to run when it cannot read it.
    GIT_CONFIG_GLOBAL: '/dev/null',
    // A CLAUDE.md a run writes into the workspace must not become a later run's instructions.
    // Defence in depth: `--restricted` already skips the folder's.
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  }
}

/** Appended to the system prompt, so a custom watcher prompt gets it too. */
export const workspaceSystemPrompt = ({root, allowedDomains}: RunWorkspace, cwd: string): string => [
  `You have a persistent workspace folder: ${cwd} is your working directory, and its files stay for later runs in this conversation.`,
  `Earlier conversations' folders are under ${path.join(root, 'threads')}; read them when the request refers to earlier work.`,
  `Bash runs sandboxed: it can read and write ${root} and nothing else of the user's, and can reach `
  + (allowedDomains.length > 0 ? `only these hosts: ${allowedDomains.join(', ')}.` : 'no network hosts.'),
  'To put a file from the workspace into the notes, pass its absolute path to add_media.',
].join('\n')
