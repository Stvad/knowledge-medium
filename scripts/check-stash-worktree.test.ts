import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  amendInvocations,
  baseBranch,
  decide,
  explicitEntry,
  hasMessage,
  renumbersStack,
  stashInvocations,
  type RepoStashState,
} from './check-stash-worktree.mjs'
import { shellSegments, shellSegmentsWithDepth } from './shell-segments.mjs'

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

  it('drops a backslash-newline as a line continuation', () => {
    expect(shellSegments('git \\\nstash pop')).toEqual([['git', 'stash', 'pop']])
  })

  it('returns heredoc bodies as data segments, not command positions', () => {
    expect(shellSegmentsWithDepth('cat <<EOF > f\ngit stash pop\nEOF\necho done')).toEqual([
      { tokens: ['cat', '>', 'f'], depth: 0 },
      { tokens: ['git', 'stash', 'pop'], depth: 0, heredoc: true },
      { tokens: ['echo', 'done'], depth: 0 },
    ])
    // quoted and <<- dash forms; a tab-indented delimiter closes <<-
    expect(shellSegmentsWithDepth("cat <<'END'\nbody\nEND\nls")).toEqual([
      { tokens: ['cat'], depth: 0 },
      { tokens: ['body'], depth: 0, heredoc: true },
      { tokens: ['ls'], depth: 0 },
    ])
    expect(shellSegmentsWithDepth('cat <<-END\nbody\n\tEND\nls').at(-1)).toEqual({
      tokens: ['ls'],
      depth: 0,
    })
  })

  it('annotates each segment with its subshell depth', () => {
    expect(shellSegmentsWithDepth('(cd /x && true); ls')).toEqual([
      { tokens: ['cd', '/x'], depth: 1 },
      { tokens: ['true'], depth: 1 },
      { tokens: ['ls'], depth: 0 },
    ])
    expect(shellSegmentsWithDepth('echo "$(cd /y && true)" && ls')).toEqual([
      { tokens: ['echo', ''], depth: 0 },
      { tokens: ['cd', '/y'], depth: 1 },
      { tokens: ['true'], depth: 1 },
      { tokens: ['ls'], depth: 0 },
    ])
  })
})

describe('stashInvocations', () => {
  it('finds bare, subcommand, and wrapped invocations', () => {
    expect(stashInvocations('git stash')).toEqual([
      { sub: null, args: [], cArgs: [], cdPath: null, optOut: false },
    ])
    expect(stashInvocations('cd /wt && env git stash pop stash@{2}')).toEqual([
      { sub: 'pop', args: ['stash@{2}'], cArgs: [], cdPath: '/wt', optOut: false },
    ])
    expect(stashInvocations('git -C /repo stash drop 1')).toEqual([
      { sub: 'drop', args: ['1'], cArgs: ['-C', '/repo'], cdPath: null, optOut: false },
    ])
  })

  it('treats a flags-only tail as an implicit push', () => {
    expect(stashInvocations('git stash -u')).toEqual([
      { sub: null, args: ['-u'], cArgs: [], cdPath: null, optOut: false },
    ])
  })

  it('sees through wrapper flags (env -i)', () => {
    expect(stashInvocations('env -i git stash pop')).toHaveLength(1)
  })

  it('recognizes cd behind a reserved-word prefix', () => {
    expect(stashInvocations('{ cd /wt && git stash pop stash@{0}; }')[0].cdPath).toBe('/wt')
  })

  it('scopes a subshell cd to its subshell', () => {
    expect(stashInvocations('(cd /wt && true); git stash pop stash@{0}')).toEqual([
      { sub: 'pop', args: ['stash@{0}'], cArgs: [], cdPath: null, optOut: false },
    ])
    expect(stashInvocations('(cd /wt && git stash pop stash@{0})')[0].cdPath).toBe('/wt')
    expect(stashInvocations('echo "$(cd /wt && true)"; git stash drop 0')[0].cdPath).toBeNull()
  })

  it('records the opt-out only as the invocation own prefix, not quoted prose', () => {
    expect(stashInvocations('STASH_OK=1 git stash pop')[0].optOut).toBe(true)
    expect(stashInvocations('echo "STASH_OK=1 skips" ; git stash pop')[0].optOut).toBe(false)
  })

  it('sees through shell reserved-word prefixes', () => {
    expect(stashInvocations('if git stash pop; then echo popped; fi')).toHaveLength(1)
    expect(stashInvocations('{ git stash pop; }')).toHaveLength(1)
    expect(stashInvocations('! git stash pop')).toHaveLength(1)
  })

  it('ignores commands that merely mention stash', () => {
    expect(stashInvocations('echo git stash pop')).toEqual([])
    expect(stashInvocations('ls my-stash-dir | grep stash')).toEqual([])
    expect(stashInvocations('git commit -m "later: git stash pop; cleanup"')).toEqual([])
    expect(stashInvocations('git stashx pop')).toEqual([])
    expect(stashInvocations('git stash bogus-subcommand')).toEqual([]) // git rejects it itself
  })
})

describe('amendInvocations', () => {
  it('finds only commit invocations carrying --amend', () => {
    expect(amendInvocations('git commit --amend -m x')).toHaveLength(1)
    expect(amendInvocations('git commit -m x')).toEqual([])
    expect(amendInvocations('git stash pop stash@{0}')).toEqual([])
    expect(amendInvocations('echo "git commit --amend"')).toEqual([])
  })

  it('does not read a -m message value as a pathspec', () => {
    expect(amendInvocations('git commit --amend -m "fix things"')[0].paths).toEqual([])
    expect(amendInvocations('git commit --amend --message "fix things"')[0].paths).toEqual([])
    expect(amendInvocations('git commit --amend -am "fix things"')[0]).toMatchObject({
      all: true,
      paths: [],
    })
  })

  it('collects explicit pathspecs, before and after --', () => {
    expect(amendInvocations('git commit --amend -m x f.txt')[0].paths).toEqual(['f.txt'])
    expect(amendInvocations('git commit --amend -m x -- a.txt b.txt')[0].paths).toEqual([
      'a.txt',
      'b.txt',
    ])
  })

  it('records the AMEND_OK=1 opt-out only as the invocation prefix', () => {
    expect(amendInvocations('AMEND_OK=1 git commit --amend -m x')[0].optOut).toBe(true)
    expect(amendInvocations('echo "AMEND_OK=1"; git commit --amend -m x')[0].optOut).toBe(false)
  })
})

describe('explicitEntry / hasMessage / mutatesStack / baseBranch', () => {
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

  it('stops option scanning at the pathspec delimiter', () => {
    expect(hasMessage('push', ['--', '-m'])).toBe(false) // -m here is a pathspec
    expect(hasMessage('push', ['-m', 'x', '--', 'f.txt'])).toBe(true)
  })

  it('classifies renumbering by subcommand — apply reads without renumbering', () => {
    expect(renumbersStack({ sub: null })).toBe(true)
    expect(renumbersStack({ sub: 'pop' })).toBe(true)
    expect(renumbersStack({ sub: 'push' })).toBe(true)
    expect(renumbersStack({ sub: 'apply' })).toBe(false)
    expect(renumbersStack({ sub: 'list' })).toBe(false)
    expect(renumbersStack({ sub: 'show' })).toBe(false)
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

  it('does not read a numeric branch name as a stash selector', () => {
    // `git stash branch 1` names branch "1"; git itself would use stash@{0}.
    expect(decide(inv('branch', ['1']), state())).toMatch(/names no entry/)
    expect(decide(inv('branch', ['newb', '1']), state())).toBeNull()
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

  it('fails closed when the stash list cannot be read', () => {
    expect(decide(inv('pop', ['stash@{0}']), state({ stashes: null }))).toMatch(/could not read/)
    expect(decide(inv('clear'), state({ stashes: null }))).toMatch(/could not read/)
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

  it('judges a brace-grouped cd-chained pop from the target worktree', () => {
    // Pre-fix, the '{' prefix hid the cd: the pop was judged from wt2, where
    // stash@{0}'s base branch matches, and wrongly allowed.
    const r = hook(`{ cd ${multi} && git stash pop stash@{0}; }`, wt2)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'wt2branch'")
  })

  it('does not block heredoc bodies that mention stash, but still guards after them', () => {
    // the body line must put git in verb position — that is the shape that
    // would parse as a real invocation if bodies were not skipped
    expect(hook(`cat > /dev/null <<'DOC'\ngit stash pop\nDOC\necho ok`, multi).status).toBe(0)
    expect(hook(`cat > /dev/null <<'DOC'\nprose\nDOC\ngit stash pop`, multi).status).toBe(2)
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

  it('does not let a subshell cd relocate a later pop', () => {
    // The subshell's cd does not survive its close-paren: the pop runs in wt2
    // (on wt2branch), so popping main's stash@{1} must still be blocked.
    const r = hook(`(cd ${multi} && true); git stash pop stash@{1}`, wt2)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("'main'")
    // …and the mirror direction stays allowed.
    expect(hook(`(cd ${wt2} && true); git stash pop stash@{1}`, multi).status).toBe(0)
  })

  it('blocks an unlabeled push but allows -m / save with message', () => {
    expect(hook('git stash', multi).status).toBe(2)
    expect(hook('git stash', multi).stderr).toContain('unlabeled')
    expect(hook('git stash push -m "wip: thing"', multi).status).toBe(0)
    expect(hook('git stash save "wip thing"', multi).status).toBe(0)
    expect(hook('git stash save', multi).status).toBe(2)
  })

  it('blocks a selector that follows a renumbering stash operation', () => {
    const r = hook('git stash push -m mine && git stash pop stash@{1}', multi)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('separate commands')
    expect(hook('git stash push -m mine && git stash pop stash@{1}', single).status).toBe(0)
    expect(hook('git stash list && git stash pop stash@{1}', multi).status).toBe(0)
  })

  it('allows apply-then-drop of the same explicit entry (apply does not renumber)', () => {
    expect(hook('git stash apply stash@{1} && git stash drop stash@{1}', multi).status).toBe(0)
  })

  it('sees through a backslash-newline line continuation', () => {
    expect(hook('git \\\nstash pop', multi).status).toBe(2)
  })

  it('counts an opted-out mutation in the compound rule', () => {
    // The blessed push still renumbers what the unblessed pop names.
    const r = hook('true && STASH_OK=1 git stash push -m mine && git stash pop stash@{1}', multi)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('separate commands')
    // …but a compound where every mutation is blessed passes.
    expect(
      hook('true && STASH_OK=1 git stash push -m a && STASH_OK=1 git stash pop stash@{1}', multi)
        .status,
    ).toBe(0)
  })

  it('blocks clear while the shared stack has entries', () => {
    expect(hook('git stash clear', multi).status).toBe(2)
    expect(hook('git stash clear', emptyStack).status).toBe(0)
  })

  it('allows pop/apply/drop against an empty stack, still blocks unlabeled push', () => {
    expect(hook('git stash pop', emptyStack).status).toBe(0)
    expect(hook('git stash', emptyStack).status).toBe(2)
  })

  it('honors the STASH_OK=1 opt-out as a command or invocation prefix', () => {
    expect(hook('STASH_OK=1 git stash pop', multi).status).toBe(0)
    expect(hook('git fetch && STASH_OK=1 git stash pop', multi).status).toBe(0)
  })

  it('ignores STASH_OK=1 inside quoted prose', () => {
    expect(hook('echo "re-run with STASH_OK=1 prefixed" && git stash pop', multi).status).toBe(2)
  })

  it('guards an invocation behind a reserved-word prefix', () => {
    expect(hook('if git stash pop; then true; fi', multi).status).toBe(2)
  })

  it('guards an invocation behind wrapper flags', () => {
    expect(hook('env -i git stash pop', multi).status).toBe(2)
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

  // Amend-rule fixtures. The hazard is same-DIRECTORY concurrency (one index,
  // many agents), so unlike the stash rules these repos are single-worktree on
  // purpose: the rule must apply there too.
  const amendGrow = makeRepo('amend-guard-grow-') // HEAD: base commit (f.txt)
  writeFileSync(join(amendGrow, 'f2.txt'), 'x\n')
  git(amendGrow, ['add', 'f2.txt'])
  git(amendGrow, ['commit', '-qm', 'second']) // commit being amended touches only f2.txt
  writeFileSync(join(amendGrow, 'foreign.txt'), 'y\n')
  git(amendGrow, ['add', 'foreign.txt']) // another session's staged work

  const amendSame = makeRepo('amend-guard-same-')
  writeFileSync(join(amendSame, 'f2.txt'), 'x\n')
  git(amendSame, ['add', 'f2.txt'])
  git(amendSame, ['commit', '-qm', 'second'])
  writeFileSync(join(amendSame, 'f2.txt'), 'x2\n')
  git(amendSame, ['add', 'f2.txt']) // re-staged file already in the commit

  const amendAll = makeRepo('amend-guard-all-')
  writeFileSync(join(amendAll, 'f2.txt'), 'x\n')
  git(amendAll, ['add', 'f2.txt'])
  git(amendAll, ['commit', '-qm', 'second'])
  writeFileSync(join(amendAll, 'f.txt'), 'drift\n') // tracked, modified, UNSTAGED

  it('blocks an amend that grows the file set beyond the amended commit', () => {
    const r = hook('git commit --amend -m reworded', amendGrow)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('foreign.txt')
  })

  it('allows an amend whose staged files are all in the amended commit', () => {
    expect(hook('git commit --amend -m reworded', amendSame).status).toBe(0)
    expect(hook('git commit --amend --no-edit', single).status).toBe(0) // nothing staged
  })

  it('includes unstaged tracked changes when the amend uses -a', () => {
    expect(hook('git commit --amend -m reworded', amendAll).status).toBe(0)
    const r = hook('git commit --amend -am reworded', amendAll)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('f.txt')
  })

  it('lets an explicit pathspec or AMEND_OK=1 through, and plain commits alone', () => {
    expect(hook('git commit --amend -m x -- f2.txt', amendGrow).status).toBe(0)
    expect(hook('AMEND_OK=1 git commit --amend -m x', amendGrow).status).toBe(0)
    // …in both spellings: whole-command prefix and invocation-local prefix.
    expect(hook('AMEND_OK=1 true; git commit --amend -m x', amendGrow).status).toBe(0)
    expect(hook('true && AMEND_OK=1 git commit --amend -m x', amendGrow).status).toBe(0)
    expect(hook('git commit -m "new commit"', amendGrow).status).toBe(0)
  })

  it('stays out of the way outside a repo or on a garbled payload', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stash-guard-norepo-')))
    expect(hook('git stash pop', outside).status).toBe(0)
    expect(hook('', multi, 'not json').status).toBe(0)
  })
})
