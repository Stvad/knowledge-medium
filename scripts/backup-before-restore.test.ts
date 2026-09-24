import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { restoreInvocations } from './backup-before-restore.mjs'
import { NOTE_BUDGET } from './hook-context.mjs'

const specs = (cmd: string) => restoreInvocations(cmd).map(r => r.pathspecs)

describe('restoreInvocations', () => {
  it('reads checkout pathspecs after --, with or without a source rev', () => {
    expect(specs('git checkout -- f.ts')).toEqual([['f.ts']])
    expect(specs('git checkout HEAD -- a.ts b.ts')).toEqual([['a.ts', 'b.ts']])
    expect(specs('git checkout origin/master -- .')).toEqual([['.']])
  })

  it('tries every checkout operand as a pathspec when there is no --', () => {
    // a rev or branch name matches no file, so only real paths get copied
    expect(specs('git checkout .')).toEqual([['.']])
    expect(specs('git checkout HEAD f.ts')).toEqual([['HEAD', 'f.ts']])
  })

  it('does not read a checkout option value as an operand', () => {
    expect(specs('git checkout --conflict merge f.ts')).toEqual([['f.ts']])
  })

  it('skips branch-creating and detaching checkouts', () => {
    expect(specs('git checkout -b feat')).toEqual([])
    expect(specs('git checkout -qb feat origin/master')).toEqual([])
    expect(specs('git checkout -B feat')).toEqual([])
    expect(specs('git checkout --orphan x')).toEqual([])
    expect(specs('git checkout --detach')).toEqual([])
    expect(specs('git checkout -t origin/feat')).toEqual([])
  })

  it('takes the whole tree for a forced checkout with no --', () => {
    expect(specs('git checkout -f')).toEqual([[':/']])
    expect(specs('git checkout --force some-branch')).toEqual([[':/']])
    expect(specs('git checkout -fq some-branch')).toEqual([[':/']])
    expect(specs('git checkout -f -- f.ts')).toEqual([['f.ts']])
  })

  it('reads restore pathspecs past its value-taking options', () => {
    expect(specs('git restore f.ts')).toEqual([['f.ts']])
    expect(specs('git restore -s HEAD~1 f.ts')).toEqual([['f.ts']])
    expect(specs('git restore -sHEAD f.ts')).toEqual([['f.ts']])
    expect(specs('git restore --source HEAD f.ts')).toEqual([['f.ts']])
    expect(specs('git restore --source=HEAD -- f.ts')).toEqual([['f.ts']])
  })

  it('reads a dash-leading restore path after --', () => {
    expect(specs('git restore -- -odd.ts')).toEqual([['-odd.ts']])
  })

  it('skips a restore that touches only the index', () => {
    expect(specs('git restore --staged f.ts')).toEqual([])
    expect(specs('git restore -S f.ts')).toEqual([])
    expect(specs('git restore --staged --worktree f.ts')).toEqual([['f.ts']])
    expect(specs('git restore -SW f.ts')).toEqual([['f.ts']])
    expect(specs('git restore -W f.ts')).toEqual([['f.ts']])
    // the W inside an attached -s value is part of the rev, not --worktree
    expect(specs('git restore --staged -sWORK f.ts')).toEqual([])
  })

  it('widens to the whole tree when the pathspec is not literal, and says why', () => {
    const loop = restoreInvocations('for f in a.ts b.ts; do git checkout -- "$f"; done')
    expect(loop.map(r => r.pathspecs)).toEqual([[':/']])
    expect(loop[0].widened).toContain('$f')
    const subst = restoreInvocations('git checkout -- $(git diff --name-only)')
    expect(subst.map(r => r.pathspecs)).toEqual([[':/']])
    expect(subst[0].widened).toContain('command substitution')
    const piped = restoreInvocations('git diff --name-only | xargs git checkout --')
    expect(piped.map(r => r.pathspecs)).toEqual([[':/']])
    expect(piped[0].widened).toContain('xargs')
    const fromFile = restoreInvocations('git restore --pathspec-from-file=list.txt')
    expect(fromFile.map(r => r.pathspecs)).toEqual([[':/']])
    expect(fromFile[0].widened).toContain('--pathspec-from-file')
    const checkoutFromFile = restoreInvocations('git checkout --pathspec-from-file list.txt')
    expect(checkoutFromFile.map(r => r.pathspecs)).toEqual([[':/']])
    expect(checkoutFromFile[0].widened).toContain('--pathspec-from-file')
  })

  it('ignores a command that only mentions checkout or restore', () => {
    expect(specs('echo git checkout -- f.ts')).toEqual([])
    expect(specs('git commit -m "git restore f.ts; git checkout -- ."')).toEqual([])
    expect(specs('git checkout')).toEqual([])
    expect(specs('git checkout --')).toEqual([])
  })

  it('carries the in-command cd and -C for the repo lookup', () => {
    expect(restoreInvocations('cd sub && git checkout -- f.ts')[0]).toMatchObject({
      cdPath: 'sub',
      pathspecs: ['f.ts'],
    })
    expect(restoreInvocations('git -C /repo restore f.ts')[0].cArgs).toEqual(['-C', '/repo'])
  })
})

// The hook copies into each fixture's git dir, so every case uses its own
// session id and reads only the backup directory that session produced.
describe('hook end-to-end', { timeout: 30_000 }, () => {
  const script = fileURLToPath(new URL('./backup-before-restore.mjs', import.meta.url))
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0)
    return r.stdout.trim()
  }
  let sessions = 0
  const hook = (command: string, cwd: string, over: Record<string, unknown> = {}) => {
    const session_id = `sess${++sessions}-0000-4000-8000-000000000000`
    const payload = JSON.stringify({ session_id, tool_name: 'Bash', cwd, tool_input: { command }, ...over })
    const r = spawnSync('node', [script], { cwd, input: payload, encoding: 'utf8' })
    return { ...r, session: session_id.slice(0, 8), sessionId: session_id }
  }
  const context = (stdout: string): string => {
    const out = JSON.parse(stdout)
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput).not.toHaveProperty('permissionDecision')
    return out.hookSpecificOutput.additionalContext
  }
  const backupDir = (ctx: string) => ctx.split('\n').find(l => l.includes('restore-backups'))!.trim()
  const makeRepo = (name: string) => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), name)))
    git(repo, ['init', '-q', '-b', 'main'])
    git(repo, ['config', 'user.email', 't@example.com'])
    git(repo, ['config', 'user.name', 't'])
    mkdirSync(join(repo, 'sub'))
    for (const f of ['a.txt', 'b.txt', 'clean.txt', 'g.txt', 'sub/g.txt']) {
      writeFileSync(join(repo, f), 'one\ntwo\nthree\n')
    }
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'base'])
    return repo
  }

  const repo = makeRepo('restore-backup-')
  writeFileSync(join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n') // +2 -1 versus HEAD
  writeFileSync(join(repo, 'b.txt'), 'one\n') // +0 -2
  writeFileSync(join(repo, 'g.txt'), 'root edit\n')
  writeFileSync(join(repo, 'sub/g.txt'), 'sub edit\n')
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir'])

  it('copies a dirty file before the restore and reports count, dir and line counts', () => {
    const r = hook('git checkout -- a.txt', repo)
    expect(r.status).toBe(0)
    const ctx = context(r.stdout)
    expect(ctx).toContain('1 file')
    expect(ctx).toMatch(/\+2 -1\s+a\.txt/)
    const dir = backupDir(ctx)
    expect(dir.startsWith(join(gitDir, 'restore-backups', r.session))).toBe(true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\nfour\n')
  })

  it('does nothing for a clean file: no backup, no context', () => {
    const r = hook('git checkout -- clean.txt', repo)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(existsSync(join(gitDir, 'restore-backups', r.session))).toBe(false)
  })

  it('copies every dirty file under `-- .` and none of the clean ones', () => {
    const r = hook('git checkout HEAD -- .', repo)
    const ctx = context(r.stdout)
    expect(ctx).toContain('4 files')
    const dir = backupDir(ctx)
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(dir, 'sub/g.txt'), 'utf8')).toBe('sub edit\n')
    expect(existsSync(join(dir, 'clean.txt'))).toBe(false)
    expect(ctx).toMatch(/\+0 -2\s+b\.txt/)
  })

  it('is a no-op for a restore of the index only', () => {
    const r = hook('git restore --staged a.txt', repo)
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('backs up a worktree-touching git restore', () => {
    const ctx = context(hook('git restore a.txt b.txt', repo).stdout)
    expect(ctx).toContain('2 files')
  })

  it('resolves the pathspec against an in-command cd', () => {
    const r = hook('cd sub && git checkout -- g.txt', repo)
    const ctx = context(r.stdout)
    expect(ctx).toContain('1 file')
    const dir = backupDir(ctx)
    expect(readFileSync(join(dir, 'sub/g.txt'), 'utf8')).toBe('sub edit\n')
    expect(existsSync(join(dir, 'g.txt'))).toBe(false)
  })

  it('copies every dirty file when the pathspec is a shell variable', () => {
    const ctx = context(hook('for f in a.txt; do git checkout -- "$f"; done', repo).stdout)
    expect(ctx).toContain('4 files')
    expect(ctx).toContain('$f')
  })

  it('reports an unresolvable cd target instead of guessing a repository', () => {
    const r = hook('cd "$WT" && git checkout -- a.txt', repo)
    expect(r.status).toBe(0)
    const ctx = context(r.stdout)
    expect(ctx).toContain('$WT')
    expect(ctx).not.toContain('restore-backups')
  })

  it('reports an unresolvable -C target the same way', () => {
    const ctx = context(hook('git -C "$WT" checkout -- a.txt', repo).stdout)
    expect(ctx).toContain('$WT')
    expect(ctx).not.toContain('restore-backups')
  })

  it('copies nothing for a branch switch or a mention in prose', () => {
    expect(hook('git checkout main', repo).stdout).toBe('')
    expect(hook('echo "git checkout -- a.txt"', repo).stdout).toBe('')
  })

  it('stores a worktree backup under that worktree own git dir', () => {
    const wt = join(repo, '..', `${repo.split('/').pop()}-wt`)
    git(repo, ['worktree', 'add', '-q', '--detach', wt, 'HEAD'])
    writeFileSync(join(wt, 'a.txt'), 'worktree edit\n')
    const wtGitDir = git(wt, ['rev-parse', '--absolute-git-dir'])
    expect(wtGitDir).not.toBe(gitDir)
    const dir = backupDir(context(hook('git checkout -- a.txt', wt).stdout))
    expect(dir.startsWith(join(wtGitDir, 'restore-backups'))).toBe(true)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('worktree edit\n')
  })

  it('writes a manifest naming the command, cwd, session and copies', () => {
    const r = hook('git checkout -- b.txt', repo)
    const dir = backupDir(context(r.stdout))
    expect(readdirSync(dir).sort()).toEqual(['b.txt', 'manifest.txt'])
    const manifest = readFileSync(join(dir, 'manifest.txt'), 'utf8')
    expect(manifest).toContain('command: git checkout -- b.txt')
    expect(manifest).toContain(`cwd: ${repo}`)
    expect(manifest).toContain(`session: ${r.sessionId}`)
    expect(manifest).toContain('+0 -2\tb.txt')
    expect(manifest).toMatch(/^time: \d{4}-\d\d-\d\dT/m)
  })

  it('keys the backup by a sanitized session prefix, with a fallback for none', () => {
    const odd = backupDir(context(hook('git checkout -- b.txt', repo, { session_id: '../a/b' }).stdout))
    expect(odd.startsWith(join(gitDir, 'restore-backups', 'ab', ''))).toBe(true)
    const bare = backupDir(context(hook('git checkout -- b.txt', repo, { session_id: undefined }).stdout))
    expect(bare.startsWith(join(gitDir, 'restore-backups', 'nosession', ''))).toBe(true)
  })

  it('reports a failure to write the backup instead of crashing', () => {
    const locked = makeRepo('restore-backup-locked-')
    writeFileSync(join(locked, 'a.txt'), 'edit\n')
    const lockedGitDir = git(locked, ['rev-parse', '--absolute-git-dir'])
    chmodSync(lockedGitDir, 0o555)
    try {
      const r = hook('git checkout -- a.txt', locked)
      expect(r.status).toBe(0)
      expect(context(r.stdout)).toContain('backup-before-restore: failed before copying everything')
    } finally {
      chmodSync(lockedGitDir, 0o755)
    }
  })

  // Working-tree shapes other than an edited regular file.
  const edge = makeRepo('restore-backup-edge-')
  symlinkSync('a.txt', join(edge, 'link'))
  writeFileSync(join(edge, 'gone.txt'), 'x\n')
  writeFileSync(join(edge, 'dir-now'), 'x\n')
  writeFileSync(join(edge, 'locked.txt'), 'x\n')
  git(edge, ['add', '.'])
  git(edge, ['commit', '-qm', 'edge files'])
  rmSync(join(edge, 'link'))
  symlinkSync('b.txt', join(edge, 'link')) // retargeted
  rmSync(join(edge, 'gone.txt')) // deleted: HEAD still holds it
  rmSync(join(edge, 'dir-now'))
  mkdirSync(join(edge, 'dir-now')) // tracked file replaced by a directory
  writeFileSync(join(edge, 'locked.txt'), 'edited\n')
  chmodSync(join(edge, 'locked.txt'), 0o000)

  it('copies a retargeted symlink as a link', () => {
    const dir = backupDir(context(hook('git checkout -- link', edge).stdout))
    expect(readlinkSync(join(dir, 'link'))).toBe('b.txt')
  })

  it('stays silent for a file deleted in the working tree', () => {
    expect(hook('git checkout -- gone.txt', edge).stdout).toBe('')
  })

  it('reports what it could not copy, with the reason, and still writes the manifest', () => {
    const ctx = context(hook('git checkout -- dir-now locked.txt', edge).stdout)
    expect(ctx).toContain('copied 0 files')
    expect(ctx).toContain('not copied: dir-now (not a regular file)')
    expect(ctx).toContain('not copied: locked.txt (EACCES)')
    expect(ctx).toContain('line counts unavailable')
    expect(readFileSync(join(backupDir(ctx), 'manifest.txt'), 'utf8')).toContain('not copied (EACCES)\tlocked.txt')
  })

  it('copies the other named files when one of them is unreadable', () => {
    writeFileSync(join(edge, 'a.txt'), 'edge edit\n')
    const ctx = context(hook('git checkout -- a.txt locked.txt', edge).stdout)
    expect(ctx).toContain('copied 1 file')
    expect(ctx).toMatch(/\?\s+a\.txt/)
    expect(readFileSync(join(backupDir(ctx), 'a.txt'), 'utf8')).toBe('edge edit\n')
  })

  it('lists files within the context budget and counts the rest', () => {
    const many = makeRepo('restore-backup-many-')
    const names = Array.from({ length: 150 }, (_, i) => `${'deeply-nested-directory-name/'.repeat(3)}file-${i}.txt`)
    mkdirSync(join(many, 'deeply-nested-directory-name/'.repeat(3)), { recursive: true })
    for (const n of names) writeFileSync(join(many, n), 'x\n')
    git(many, ['add', '.'])
    git(many, ['commit', '-qm', 'many'])
    for (const n of names) writeFileSync(join(many, n), 'y\n')
    const ctx = context(hook('git checkout -- .', many).stdout)
    expect(ctx).toContain('150 files')
    expect(ctx.split('\n').at(-1)).toMatch(/^ {2}…and \d+ more, listed in manifest\.txt$/)
    expect(ctx.length).toBeLessThanOrEqual(NOTE_BUDGET + 100)
    const manifest = readFileSync(join(backupDir(ctx), 'manifest.txt'), 'utf8')
    for (const n of names) expect(manifest).toContain(`\t${n}\n`)
  })

  it('stays silent on a garbled or empty payload and outside a repo', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'restore-backup-norepo-')))
    expect(hook('git checkout -- a.txt', outside).stdout).toBe('')
    const garbled = spawnSync('node', [script], { cwd: repo, input: 'not json', encoding: 'utf8' })
    expect(garbled.status).toBe(0)
    expect(garbled.stdout).toBe('')
    expect(hook('', repo).stdout).toBe('')
  })

  it('falls back to the process cwd when the payload has none', () => {
    const ctx = context(hook('cd sub && git checkout -- g.txt', repo, { cwd: undefined }).stdout)
    expect(ctx).toContain('1 file')
    expect(readFileSync(join(backupDir(ctx), 'manifest.txt'), 'utf8')).toContain(`cwd: ${repo}\n`)
  })
})
