import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NOTE_BUDGET } from './hook-context.mjs'
import { contextOf as context, git, tempDirs } from './hook-test-support'
import { pushInvocations, pushSources } from './push-scope.mjs'

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

describe('pushSources', () => {
  const src = (cmd: string) => pushSources(pushInvocations(cmd)[0].rest)

  it('uses HEAD when the push names no refspec', () => {
    for (const cmd of ['git push', 'git push origin', 'git push -u origin', 'git push --repo=origin -f']) {
      expect(src(cmd)).toEqual({ sources: ['HEAD'], declined: null })
    }
  })

  it('takes each refspec source, past value-taking options', () => {
    expect(src('git push -u origin HEAD').sources).toEqual(['HEAD'])
    expect(src('git push origin side').sources).toEqual(['side'])
    expect(src('git push origin +HEAD~1:release other').sources).toEqual(['HEAD~1', 'other'])
    expect(src('git push -o ci.skip origin side').sources).toEqual(['side'])
  })

  it('declines when the push names no single source', () => {
    expect(src('git push --all').declined).toContain('--all')
    expect(src('git push --mirror origin').declined).toContain('--mirror')
    expect(src('git push --tags').declined).toContain('tags only')
    expect(src('git push origin --delete side').declined).toContain('--delete')
    expect(src('git push origin :side').declined).toContain('deletes')
    expect(src('git push --tags origin side').sources).toEqual(['side'])
    expect(src('git push -u origin "$(git branch --show-current)"').declined).toContain('not literal')
    expect(src('git push origin "$BRANCH"').declined).toContain('not literal')
  })
})

describe('hook end-to-end', { timeout: 30_000 }, () => {
  const script = fileURLToPath(new URL('./push-scope.mjs', import.meta.url))
  const hook = (command: string, cwd: string, input?: string) => {
    const payload = input ?? JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } })
    const r = spawnSync('node', [script], { cwd, input: payload, encoding: 'utf8' })
    expect(r.status).toBe(0)
    return r.stdout
  }
  const commitFiles = (cwd: string, files: Record<string, string>, msg: string) => {
    for (const [f, body] of Object.entries(files)) writeFileSync(join(cwd, f), body)
    git(cwd, ['add', '.'])
    git(cwd, ['commit', '-qm', msg])
  }
  const tmp = tempDirs()
  const clone = (name: string) => {
    const dir = tmp(name)
    git(dir, ['clone', '-q', origin, '.'])
    return dir
  }

  // origin (bare) ← seed; `work` is the clone a session pushes from.
  const origin = tmp('push-scope-origin-')
  git(origin, ['init', '-q', '--bare', '-b', 'master'])
  const seed = tmp('push-scope-seed-')
  git(seed, ['init', '-q', '-b', 'master'])
  commitFiles(seed, { 'a.ts': 'a\n', 'z.test.ts': 'test a\n', 'b.ts': 'b\n' }, 'base')
  git(seed, ['remote', 'add', 'origin', origin])
  git(seed, ['push', '-q', 'origin', 'master'])

  const work = clone('push-scope-work-')
  git(work, ['checkout', '-qb', 'feat'])
  git(work, ['rm', '-q', 'z.test.ts'])
  commitFiles(work, { 'b.ts': 'b changed\n', 'c.ts': 'c\n' }, 'feat work')

  it('prints the branch scope against origin/master, deletions first', () => {
    const ctx = context(hook('git push -u origin HEAD', work))
    expect(ctx).toContain('3 files changed')
    const lines = ctx.split('\n')
    const at = (l: string) => lines.indexOf(l)
    expect(at('D\tz.test.ts')).toBeGreaterThan(-1)
    // z.test.ts sorts after b.ts and c.ts, so only the reorder puts it first
    expect(at('M\tb.ts')).toBeGreaterThan(at('D\tz.test.ts'))
    expect(at('A\tc.ts')).toBeGreaterThan(at('D\tz.test.ts'))
    expect(ctx).toContain('push-scope: feat against origin/master')
    expect(ctx).toContain('HEAD is 1 ahead, 0 behind')
  })

  it('shows a stale-base squash as deletions of what master merged meanwhile', () => {
    // The squash-onto-moved-master shape: master gains a merged PR's files, the
    // branch fetches, then `reset --soft origin/master` keeps the OLD tree.
    const other = clone('push-scope-other-')
    commitFiles(other, { 'merged.ts': 'm\n', 'merged.test.ts': 'test m\n' }, 'merged PR')
    git(other, ['push', '-q', 'origin', 'master'])

    const squash = clone('push-scope-squash-')
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

  it('scopes the source a refspec names, not the checked-out branch', () => {
    git(work, ['branch', 'side', 'origin/master'])
    git(work, ['checkout', '-q', 'side'])
    commitFiles(work, { 'side.ts': 's\n' }, 'side work')
    git(work, ['checkout', '-q', 'feat'])
    const ctx = context(hook('git push origin side', work))
    expect(ctx).toContain('push-scope: side against origin/master')
    expect(ctx).toContain('A\tside.ts')
    expect(ctx).not.toContain('z.test.ts')
    const both = context(hook('git push origin feat side', work))
    expect(both).toContain('push-scope: feat against origin/master')
    expect(both).toContain('push-scope: side against origin/master')
  })

  it('declines, as a fact, a push that names no single source', () => {
    const ctx = context(hook('git push --all origin', work))
    expect(ctx).toContain('no scope for this push: it pushes every branch (--all)')
    expect(ctx).not.toContain('files changed')
  })

  it('scopes a push whose output is redirected', () => {
    const ctx = context(hook('git push --force-with-lease origin 2>&1 | tail -5', work))
    expect(ctx).toContain('push-scope: feat against origin/master')
    expect(ctx).not.toContain('failed')
  })

  it('evaluates the repository an in-command cd moves to', () => {
    const elsewhere = tmp('push-scope-elsewhere-')
    expect(context(hook(`cd ${work} && git push`, elsewhere))).toContain('D\tz.test.ts')
  })

  it('reports a missing origin/master instead of a scope', () => {
    const lone = tmp('push-scope-lone-')
    git(lone, ['init', '-q', '-b', 'main'])
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

  it('says so when the branch has no file differences', () => {
    const same = clone('push-scope-same-')
    expect(context(hook('git push', same))).toContain('no file differences')
  })

  it('prints one scope for repeated pushes from the same repository', () => {
    const ctx = context(hook('git push && git push -u origin HEAD', work))
    expect(ctx.match(/push-scope:/g)).toHaveLength(1)
  })

  it('lists files within the context budget and counts the rest', () => {
    const wide = clone('push-scope-wide-')
    git(wide, ['checkout', '-qb', 'wide'])
    const dir = 'deeply-nested-directory-name/'.repeat(3)
    mkdirSync(join(wide, dir), { recursive: true })
    commitFiles(wide, Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`${dir}file-${i}.ts`, 'x\n'])), 'wide')
    const ctx = context(hook('git push', wide))
    expect(ctx).toContain('150 files changed')
    expect(ctx.split('\n').at(-1)).toMatch(/^…and \d+ more$/)
    expect(ctx.length).toBeLessThanOrEqual(NOTE_BUDGET + 100)
  })

  it('prints nothing for other commands, prose, a garbled payload, or outside a repo', () => {
    expect(hook('git status', work)).toBe('')
    expect(hook('echo "git push"', work)).toBe('')
    expect(hook('', work, 'not json')).toBe('')
    expect(hook('git push', tmp('push-scope-norepo-'))).toBe('')
  })
})
