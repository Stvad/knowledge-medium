import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { pushInvocations } from './push-scope.mjs'

describe('pushInvocations', () => {
  it('finds git push in verb position only', () => {
    expect(pushInvocations('git push')).toHaveLength(1)
    expect(pushInvocations('git push -u origin HEAD && gh pr view')).toHaveLength(1)
    expect(pushInvocations('echo "git push later"')).toEqual([])
    expect(pushInvocations('git commit -m "then git push"')).toEqual([])
    expect(pushInvocations('git stash push -m wip')).toEqual([])
  })

  it('carries the in-command cd and -C for the repo lookup', () => {
    expect(pushInvocations('cd /wt && git push')[0].cdPath).toBe('/wt')
    expect(pushInvocations('git -C /wt push')[0].cArgs).toEqual(['-C', '/wt'])
  })
})

describe('hook end-to-end', { timeout: 30_000 }, () => {
  const script = fileURLToPath(new URL('./push-scope.mjs', import.meta.url))
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0)
    return r.stdout.trim()
  }
  const hook = (command: string, cwd: string, input?: string) => {
    const payload = input ?? JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } })
    const r = spawnSync('node', [script], { cwd, input: payload, encoding: 'utf8' })
    expect(r.status).toBe(0)
    return r.stdout
  }
  const context = (stdout: string): string => {
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision')
    return out.hookSpecificOutput.additionalContext
  }
  const commitFiles = (cwd: string, files: Record<string, string>, msg: string) => {
    for (const [f, body] of Object.entries(files)) writeFileSync(join(cwd, f), body)
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-qm', msg])
  }
  const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), name)))

  // origin (bare) ← seed; `work` is the clone a session pushes from.
  const origin = tmp('push-scope-origin-')
  git(origin, ['init', '-q', '--bare', '-b', 'master'])
  const seed = tmp('push-scope-seed-')
  git(seed, ['init', '-q', '-b', 'master'])
  git(seed, ['config', 'user.email', 't@example.com'])
  git(seed, ['config', 'user.name', 't'])
  commitFiles(seed, { 'a.ts': 'a\n', 'a.test.ts': 'test a\n', 'b.ts': 'b\n' }, 'base')
  git(seed, ['remote', 'add', 'origin', origin])
  git(seed, ['push', '-q', 'origin', 'master'])

  const work = tmp('push-scope-work-')
  git(work, ['clone', '-q', origin, '.'])
  git(work, ['config', 'user.email', 't@example.com'])
  git(work, ['config', 'user.name', 't'])
  git(work, ['checkout', '-qb', 'feat'])
  git(work, ['rm', '-q', 'a.test.ts'])
  commitFiles(work, { 'b.ts': 'b changed\n', 'c.ts': 'c\n' }, 'feat work')

  it('prints the branch scope against origin/master, deletions first', () => {
    const ctx = context(hook('git push -u origin HEAD', work))
    expect(ctx).toContain('3 files changed')
    const lines = ctx.split('\n')
    const at = (l: string) => lines.indexOf(l)
    expect(at('D\ta.test.ts')).toBeGreaterThan(-1)
    expect(at('M\tb.ts')).toBeGreaterThan(at('D\ta.test.ts'))
    expect(at('A\tc.ts')).toBeGreaterThan(at('D\ta.test.ts'))
    expect(ctx).toContain('1 ahead, 0 behind')
  })

  it('shows a stale-base squash as deletions of what master merged meanwhile', () => {
    // The squash-onto-moved-master shape: master gains a merged PR's files, the
    // branch fetches, then `reset --soft origin/master` keeps the OLD tree.
    const other = tmp('push-scope-other-')
    git(other, ['clone', '-q', origin, '.'])
    git(other, ['config', 'user.email', 't@example.com'])
    git(other, ['config', 'user.name', 't'])
    commitFiles(other, { 'merged.ts': 'm\n', 'merged.test.ts': 'test m\n' }, 'merged PR')
    git(other, ['push', '-q', 'origin', 'master'])

    const squash = tmp('push-scope-squash-')
    git(squash, ['clone', '-q', origin, '.'])
    git(squash, ['config', 'user.email', 't@example.com'])
    git(squash, ['config', 'user.name', 't'])
    git(squash, ['checkout', '-qb', 'feat', 'HEAD~1']) // branch cut before the merged PR
    commitFiles(squash, { 'mine.ts': 'x\n' }, 'my work')
    git(squash, ['fetch', '-q'])
    git(squash, ['reset', '-q', '--soft', 'origin/master'])
    git(squash, ['commit', '-qm', 'squashed'])

    const ctx = context(hook('git push --force-with-lease', squash))
    expect(ctx).toContain('D\tmerged.test.ts')
    expect(ctx).toContain('D\tmerged.ts')
    expect(ctx).toContain('A\tmine.ts')
  })

  it('evaluates the repository an in-command cd moves to', () => {
    const elsewhere = tmp('push-scope-elsewhere-')
    expect(context(hook(`cd ${work} && git push`, elsewhere))).toContain('D\ta.test.ts')
  })

  it('reports a missing origin/master instead of a scope', () => {
    const lone = tmp('push-scope-lone-')
    git(lone, ['init', '-q', '-b', 'main'])
    git(lone, ['config', 'user.email', 't@example.com'])
    git(lone, ['config', 'user.name', 't'])
    commitFiles(lone, { 'x.ts': 'x\n' }, 'x')
    const ctx = context(hook('git push', lone))
    expect(ctx).toContain('origin/master')
    expect(ctx).not.toContain('files changed')
  })

  it('reports an unresolvable cd target instead of guessing a repository', () => {
    const ctx = context(hook('cd "$WT" && git push', work))
    expect(ctx).toContain('$WT')
    expect(ctx).not.toContain('files changed')
  })

  it('prints nothing for other commands, prose, a garbled payload, or outside a repo', () => {
    expect(hook('git status', work)).toBe('')
    expect(hook('echo "git push"', work)).toBe('')
    expect(hook('', work, 'not json')).toBe('')
    const outside = tmp('push-scope-norepo-')
    expect(hook('git push', outside)).toBe('')
    rmSync(outside, { recursive: true })
  })
})
