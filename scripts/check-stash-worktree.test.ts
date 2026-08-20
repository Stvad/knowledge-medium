import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  baseBranch,
  decide,
  explicitEntry,
  hasMessage,
  stashInvocations,
  type RepoStashState,
} from './check-stash-worktree.mjs'
import { shellSegments } from './shell-segments.mjs'

describe('shellSegments', () => {
  it('splits on unquoted separators and strips quotes', () => {
    expect(shellSegments('git add x && git commit -m "two words"')).toEqual([
      ['git', 'add', 'x'],
      ['git', 'commit', '-m', 'two words'],
    ])
  })

  it('keeps separators inside quoted spans in their token', () => {
    expect(shellSegments(`git commit -m "fix a; git stash pop | done"`)).toEqual([
      ['git', 'commit', '-m', 'fix a; git stash pop | done'],
    ])
  })

  it('does not let an apostrophe inside double quotes bridge spans', () => {
    expect(shellSegments(`git commit -m "don't stash; it's fine" && ls`)).toEqual([
      ['git', 'commit', '-m', "don't stash; it's fine"],
      ['ls'],
    ])
  })

  it('opens a segment for $(…) even inside double quotes (it executes there)', () => {
    expect(shellSegments('echo "$(git stash pop)"')).toContainEqual(['git', 'stash', 'pop'])
    expect(shellSegments('x=`git stash pop`')).toContainEqual(['git', 'stash', 'pop'])
  })

  it('honors backslash escapes outside single quotes', () => {
    expect(shellSegments('echo a\\;b')).toEqual([['echo', 'a;b']])
  })
})

describe('stashInvocations', () => {
  it('finds bare, subcommand, and wrapped invocations', () => {
    expect(stashInvocations('git stash')).toEqual([
      { sub: null, args: [], cArgs: [], cdPath: null },
    ])
    expect(stashInvocations('cd /wt && env git stash pop stash@{2}')).toEqual([
      { sub: 'pop', args: ['stash@{2}'], cArgs: [], cdPath: '/wt' },
    ])
    expect(stashInvocations('git -C /repo stash drop 1')).toEqual([
      { sub: 'drop', args: ['1'], cArgs: ['-C', '/repo'], cdPath: null },
    ])
  })

  it('treats a flags-only tail as an implicit push', () => {
    expect(stashInvocations('git stash -u')).toEqual([
      { sub: null, args: ['-u'], cArgs: [], cdPath: null },
    ])
  })

  it('ignores commands that merely mention stash', () => {
    expect(stashInvocations('echo git stash pop')).toEqual([])
    expect(stashInvocations('ls my-stash-dir | grep stash')).toEqual([])
    expect(stashInvocations('git commit -m "later: git stash pop; cleanup"')).toEqual([])
    expect(stashInvocations('git stashx pop')).toEqual([])
    expect(stashInvocations('git stash bogus-subcommand')).toEqual([]) // git rejects it itself
  })
})

describe('explicitEntry / hasMessage / baseBranch', () => {
  it('recognizes stash@{N} and bare-index entries, skipping flags', () => {
    expect(explicitEntry(['--index', 'stash@{3}'])).toBe('stash@{3}')
    expect(explicitEntry(['2'])).toBe('2')
    expect(explicitEntry(['--quiet'])).toBeNull()
    expect(explicitEntry([])).toBeNull()
  })

  it('detects push/save messages in their forms', () => {
    expect(hasMessage('push', ['-m', 'wip'])).toBe(true)
    expect(hasMessage('push', ['--message=wip'])).toBe(true)
    expect(hasMessage(null, ['-um', 'wip'])).toBe(true)
    expect(hasMessage(null, ['-mWIP'])).toBe(true)
    expect(hasMessage('push', ['-u'])).toBe(false)
    expect(hasMessage('save', ['my', 'message'])).toBe(true)
    expect(hasMessage('save', ['-u'])).toBe(false)
  })

  it('parses the base branch from both stash subject shapes', () => {
    expect(baseBranch('WIP on master: 9fe9b70c Hide search headers')).toBe('master')
    expect(baseBranch('On feat/x: restored: propertyRegistrationAudit WIP')).toBe('feat/x')
    expect(baseBranch('custom label with no branch')).toBeNull()
  })
})

describe('decide', () => {
  const state = (over: Partial<RepoStashState> = {}): RepoStashState => ({
    worktrees: 3,
    branch: 'mine',
    stashes: [
      { ref: 'stash@{0}', subject: 'WIP on other: 123 x' },
      { ref: 'stash@{1}', subject: 'On mine: labelled' },
    ],
    ...over,
  })
  const inv = (sub: string | null, args: string[] = []) => ({ sub, args })

  it('allows everything in a single-worktree repo or without repo state', () => {
    expect(decide(inv('pop'), state({ worktrees: 1 }))).toBeNull()
    expect(decide(inv('pop'), null)).toBeNull()
  })

  it('allows pop/apply/drop against an empty stack (git errors on its own)', () => {
    expect(decide(inv('pop'), state({ stashes: [] }))).toBeNull()
  })

  it('blocks pop/apply/drop/branch naming no explicit entry', () => {
    for (const sub of ['pop', 'apply', 'drop', 'branch']) {
      expect(decide(inv(sub, sub === 'branch' ? ['newb'] : []), state())).toMatch(/names no entry/)
    }
  })

  it('allows an explicit entry based on the current branch, either spelling', () => {
    expect(decide(inv('pop', ['stash@{1}']), state())).toBeNull()
    expect(decide(inv('apply', ['1']), state())).toBeNull()
  })

  it('blocks an explicit entry stashed on a different branch, naming both', () => {
    const msg = decide(inv('pop', ['stash@{0}']), state())
    expect(msg).toMatch(/'other'/)
    expect(msg).toMatch(/'mine'/)
    expect(decide(inv('drop', ['0']), state())).toMatch(/another session's work/)
  })

  it('allows an out-of-range index but blocks unverifiable selectors', () => {
    expect(decide(inv('pop', ['stash@{9}']), state())).toBeNull()
    expect(decide(inv('pop', ['stash@{2.hours.ago}']), state())).toMatch(/cannot resolve/)
  })

  it('blocks when the entry subject records no branch or the worktree branch is unknown', () => {
    expect(
      decide(inv('pop', ['stash@{0}']), state({ stashes: [{ ref: 'stash@{0}', subject: 'custom' }] })),
    ).toMatch(/does not record its base branch/)
    expect(decide(inv('pop', ['stash@{0}']), state({ branch: null }))).toMatch(/not a literal path/)
  })

  it('skips the branch match for `stash branch` (it checks out the entry base)', () => {
    expect(decide(inv('branch', ['newb', 'stash@{0}']), state())).toBeNull()
  })

  it('blocks an unlabeled push in every spelling, allows labelled ones', () => {
    expect(decide(inv(null), state())).toMatch(/unlabeled/)
    expect(decide(inv('push', ['-u']), state())).toMatch(/unlabeled/)
    expect(decide(inv('save'), state())).toMatch(/unlabeled/)
    expect(decide(inv('push', ['-m', 'wip']), state())).toBeNull()
    expect(decide(inv('save', ['msg']), state())).toBeNull()
  })

  it('blocks an unlabeled push even when the stack is empty — the entry outlives that', () => {
    expect(decide(inv(null), state({ stashes: [] }))).toMatch(/unlabeled/)
  })

  it('blocks clear on a non-empty shared stack only', () => {
    expect(decide(inv('clear'), state())).toMatch(/deletes all 2 entries/)
    expect(decide(inv('clear'), state({ stashes: [] }))).toBeNull()
  })

  it('leaves read-only subcommands alone', () => {
    expect(decide(inv('list'), state())).toBeNull()
    expect(decide(inv('show', []), state())).toBeNull()
  })
})

// Fixture repos are built once and never mutated: the hook only DECIDES (exit
// code + stderr), it never runs the stash command itself.
describe('hook end-to-end', { timeout: 30_000 }, () => {
  const script = fileURLToPath(new URL('./check-stash-worktree.mjs', import.meta.url))
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0)
    return r.stdout.trim()
  }
  const hook = (command: string, cwd: string, input?: string) => {
    const payload = input ?? JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } })
    return spawnSync('node', [script], { cwd, input: payload, encoding: 'utf8' })
  }
  const makeRepo = (name: string) => {
    // realpath: on macOS tmpdir is a /var → /private/var symlink, and git
    // worktree paths come back resolved.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), name)))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@example.com'])
    git(repo, ['config', 'user.name', 't'])
    writeFileSync(join(repo, 'f.txt'), 'base\n')
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    return repo
  }

  const single = makeRepo('stash-guard-single-')

  // Multi-worktree repo: one stash from each side, wt2's stashed last (stash@{0}).
  const multi = makeRepo('stash-guard-multi-')
  const wt2 = join(multi, 'wt2')
  git(multi, ['worktree', 'add', '-q', wt2, '-b', 'wt2branch'])
  writeFileSync(join(multi, 'f.txt'), 'main change\n')
  git(multi, ['stash', 'push', '-qm', 'main work'])
  writeFileSync(join(wt2, 'f.txt'), 'wt2 change\n')
  git(wt2, ['stash', 'push', '-qm', 'wt2 work'])
  // ⇒ stash@{0} on wt2branch, stash@{1} on main

  const emptyStack = makeRepo('stash-guard-empty-')
  git(emptyStack, ['worktree', 'add', '-q', join(emptyStack, 'wt2'), '-b', 'other'])

  // The real incident shape: an entry re-stashed via `git stash store -m
  // "restored: …"` carries a custom REFLOG message, but the stash commit's own
  // subject still records the base branch.
  const restored = makeRepo('stash-guard-restored-')
  const rwt = join(restored, 'wt2')
  git(restored, ['worktree', 'add', '-q', rwt, '-b', 'other'])
  writeFileSync(join(rwt, 'f.txt'), 'change\n')
  git(rwt, ['stash', 'push', '-qm', 'orig'])
  const restoredSha = git(rwt, ['rev-parse', 'stash@{0}'])
  git(rwt, ['stash', 'drop', '-q', 'stash@{0}'])
  git(rwt, ['stash', 'store', '-m', 'restored: orig — accidentally popped elsewhere', restoredSha])

  it('is a no-op in a single-worktree repo', () => {
    expect(hook('git stash pop', single).status).toBe(0)
    expect(hook('git stash', single).status).toBe(0)
  })

  it('blocks a bare pop in a multi-worktree repo', () => {
    const r = hook('git stash pop', multi)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('names no entry')
    expect(r.stderr).toContain('2 worktrees')
  })

  it('allows an explicit entry stashed on the current branch', () => {
    expect(hook('git stash pop stash@{1}', multi).status).toBe(0)
    expect(hook('git stash apply 0', wt2).status).toBe(0)
  })

  it('blocks an explicit entry stashed on a different branch, naming both branches', () => {
    const r = hook('git stash pop stash@{0}', multi)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'wt2branch'")
    expect(r.stderr).toContain("'main'")
  })

  it('judges a cd-chained pop from the target worktree', () => {
    const r = hook(`cd ${multi} && git stash pop stash@{0}`, wt2)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'wt2branch'")
    const ok = hook(`cd ${multi} && git stash pop stash@{1}`, wt2)
    expect(ok.status).toBe(0)
  })

  it('judges a -C pop from the target worktree', () => {
    expect(hook(`git -C ${multi} stash pop stash@{0}`, wt2).status).toBe(2)
    expect(hook(`git -C ${multi} stash pop stash@{1}`, wt2).status).toBe(0)
  })

  it('blocks an unlabeled push but allows -m / save with message', () => {
    expect(hook('git stash', multi).status).toBe(2)
    expect(hook('git stash', multi).stderr).toContain('unlabeled')
    expect(hook('git stash push -m "wip: thing"', multi).status).toBe(0)
    expect(hook('git stash save "wip thing"', multi).status).toBe(0)
    expect(hook('git stash save', multi).status).toBe(2)
  })

  it('blocks clear while the shared stack has entries', () => {
    expect(hook('git stash clear', multi).status).toBe(2)
    expect(hook('git stash clear', emptyStack).status).toBe(0)
  })

  it('allows pop/apply/drop against an empty stack, still blocks unlabeled push', () => {
    expect(hook('git stash pop', emptyStack).status).toBe(0)
    expect(hook('git stash', emptyStack).status).toBe(2)
  })

  it('honors the STASH_OK=1 opt-out', () => {
    expect(hook('STASH_OK=1 git stash pop', multi).status).toBe(0)
  })

  it('lets non-stash commands mentioning stash through', () => {
    expect(hook('echo "git stash pop"', multi).status).toBe(0)
    expect(hook('ls my-stash-dir | grep stash', multi).status).toBe(0)
    expect(hook('git commit -m "note: run git stash pop later; then clean"', multi).status).toBe(0)
  })

  it('still catches a stash inside a command substitution', () => {
    expect(hook('echo "$(git stash pop)"', multi).status).toBe(2)
  })

  it('allows read-only stash subcommands', () => {
    expect(hook('git stash list', multi).status).toBe(0)
    expect(hook('git stash show stash@{0}', multi).status).toBe(0)
  })

  it('reads the base branch from the commit subject when the reflog message was overridden', () => {
    const r = hook('git stash pop stash@{0}', restored) // main worktree is on 'main'
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'other'")
    expect(hook('git stash pop stash@{0}', rwt).status).toBe(0)
  })

  it('stays out of the way outside a repo or on a garbled payload', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stash-guard-norepo-')))
    expect(hook('git stash pop', outside).status).toBe(0)
    expect(hook('', multi, 'not json').status).toBe(0)
  })
})
