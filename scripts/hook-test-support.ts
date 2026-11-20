// Shared fixtures for the scripts/ tests (the hooks, mutate, dev-server, bd-github-sync).
// Not a test file itself: vitest collects only *.test.ts.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect } from 'vitest'

// A fixed identity in the environment replaces per-repo `git config` calls.
const IDENTITY = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}

// The thread-resolve mutation the bd-github-sync graphql cases share: its one variable is an ID.
export const RESOLVE = 'mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id}}}'

let permissionProbe: boolean | undefined
/**
 * Whether this process reads through a mode-000 file, as root and some
 * sandboxes do. Probed, not inferred from the uid; a test that needs a mode
 * bit to refuse it (a read or a write) skips when this is true: a process
 * that ignores the read bit is assumed to ignore the write bit too.
 */
export const permissionBitsIgnored = (): boolean => {
  if (permissionProbe !== undefined) return permissionProbe
  const dir = mkdtempSync(join(tmpdir(), 'perm-probe-'))
  const probe = join(dir, 'f')
  try {
    writeFileSync(probe, '')
    chmodSync(probe, 0o000)
    readFileSync(probe)
    permissionProbe = true
  } catch {
    permissionProbe = false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  return permissionProbe
}

/** git in cwd; a non-zero exit fails the test with git's stderr. */
export const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } })
  expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0)
  return r.stdout.trim()
}

/**
 * A maker of temp dirs removed after the enclosing suite. Paths are realpath'd:
 * macOS tmpdir is a /var → /private/var symlink, and git reports resolved paths.
 */
export const tempDirs = () => {
  const made: string[] = []
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true })
  })
  return (prefix: string) => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
    made.push(d)
    return d
  }
}

/** A hook's additionalContext for `event`; it must never decide permission. */
export const contextOf = (stdout: string, event = 'PreToolUse'): string => {
  const out = JSON.parse(stdout)
  expect(out.hookSpecificOutput.hookEventName).toBe(event)
  expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision')
  return out.hookSpecificOutput.additionalContext
}
