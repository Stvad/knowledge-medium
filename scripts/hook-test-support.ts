// Shared fixtures for the PreToolUse hook tests (backup-before-restore,
// push-scope). Not a test file itself: vitest collects only *.test.ts.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
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

/** A PreToolUse hook's additionalContext; it must never decide permission. */
export const contextOf = (stdout: string): string => {
  const out = JSON.parse(stdout)
  expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
  expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision')
  return out.hookSpecificOutput.additionalContext
}
