import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { isSyntheticUuid, parseAllowlist } from './check-staged-pii.mjs'

// High-entropy ids assembled at runtime, so this file carries no uuid literal
// the guard would flag when it is committed.
const REAL = ['3f9d2b71', 'c84e', '4a06', '9b5e', 'd17a60c2e4f8'].join('-')
const REAL_2 = ['e6a41c09', '5d7b', '4f3e', 'a812', '0c95b7e3d4a6'].join('-')
const REAL_3 = ['7b2e94d0', 'a3f1', '4c68', '8d25', 'f06e1b9c7a34'].join('-')
const READWISE_NS = '45fb169f-ffac-458b-b2a7-6cec87d2d7ee'

// Deterministic PRNG (mulberry32), so the random-id corpus is identical every run.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const hex = (rand: () => number, n: number) =>
  Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('')
const v4 = (rand: () => number) =>
  `${hex(rand, 8)}-${hex(rand, 4)}-4${hex(rand, 3)}-${'89ab'[Math.floor(rand() * 4)]}${hex(rand, 3)}-${hex(rand, 12)}`
// v7 = 48-bit millisecond timestamp, then random bits.
const v7 = (rand: () => number) => {
  const ts = Math.floor(Date.UTC(2024, 0, 1) + rand() * 5 * 365 * 86_400_000)
    .toString(16)
    .padStart(12, '0')
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${hex(rand, 3)}-${'89ab'[Math.floor(rand() * 4)]}${hex(rand, 3)}-${hex(rand, 12)}`
}

describe('isSyntheticUuid', () => {
  it.each([
    // documentation examples, with the tails fixtures vary
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440001',
    '123e4567-e89b-12d3-a456-426614174000',
    // one repeated digit, with or without version/variant nibbles
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '55555555-5555-4555-8555-555555555555',
    '88888888-8888-4888-8888-888888888888',
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    // zero padding around a counter or a spelled word
    '0000c0de-0000-7000-8000-000000000001',
    '0000c0de-0000-7000-8000-000000000002',
    '0000c0de-0000-7000-8000-000000000003',
    '00000000-dead-4bad-a000-000000000000',
    '00000000-0000-4000-8000-00000000beef',
    // ascending, descending and interleaved nibble runs
    '0123abcd-4567-89ef-0123-456789abcdef',
    'fedcba98-7654-3210-fedc-ba9876543210',
    '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    '0f7b3c1a-9d2e-4f60-8a1b-2c3d4e5f6a7b',
    // a repeated word
    'deadbeef-dead-beef-dead-beefdeadbeef',
  ])('%s is synthetic', uuid => {
    expect(isSyntheticUuid(uuid)).toBe(true)
    expect(isSyntheticUuid(uuid.toUpperCase())).toBe(true)
  })

  it('no generated v4 or v7 id is synthetic', () => {
    const rand = prng(20260924)
    const exempt = []
    for (let i = 0; i < 20_000; i++) {
      for (const id of [v4(rand), v7(rand)]) if (isSyntheticUuid(id)) exempt.push(id)
    }
    expect(exempt).toEqual([])
  })

  it('the high-entropy test ids are not synthetic', () => {
    for (const id of [REAL, REAL_2, REAL_3]) expect(isSyntheticUuid(id)).toBe(false)
  })
})

describe('parseAllowlist', () => {
  it('reads a uuid followed by its reason, ignoring comments and bare uuids', () => {
    const list = parseAllowlist(
      [
        '# comment line',
        '',
        `${REAL.toUpperCase()}  the example namespace`,
        REAL_2, // no reason: not an entry
      ].join('\n'),
    )
    expect([...list]).toEqual([REAL])
  })
})

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0)
  return r.stdout
}
const write = (repo: string, file: string, content: string) => writeFileSync(join(repo, file), content)
const stage = (repo: string, file: string, content: string) => {
  write(repo, file, content)
  git(repo, ['add', file])
}
const commitFile = (repo: string, file: string, content: string) => {
  stage(repo, file, content)
  git(repo, ['commit', '-qm', `write ${file}`])
}
const makeRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pii-guard-')))
  git(repo, ['init', '-q', '-b', 'base'])
  git(repo, ['config', 'user.email', 't@example.com'])
  git(repo, ['config', 'user.name', 't'])
  commitFile(repo, 'f.txt', 'clean\n')
  return repo
}
// A merge left in progress: `side` commits its files directly, as a branch
// that already passed (or predates) the guard would, and `base` moves on.
const startMerge = (repo: string, sides: Record<string, Record<string, string>>) => {
  for (const [branch, files] of Object.entries(sides)) {
    git(repo, ['checkout', '-q', '-b', branch, 'base'])
    for (const [file, content] of Object.entries(files)) commitFile(repo, file, content)
  }
  git(repo, ['checkout', '-q', 'base'])
  commitFile(repo, 'f.txt', 'clean\nbase change\n')
  git(repo, ['merge', '-q', '--no-commit', '--no-ff', ...Object.keys(sides)])
}
const script = fileURLToPath(new URL('./check-staged-pii.mjs', import.meta.url))
const runHook = (repo: string, command: string, { scriptPath = script, cwd = repo } = {}) => {
  const payload = JSON.stringify({ tool_name: 'Bash', cwd, tool_input: { command } })
  return spawnSync('node', [scriptPath], { cwd, input: payload, encoding: 'utf8' })
}
const ALLOWLIST = 'scripts/check-staged-pii.allowlist'
const shippedAllowlist = readFileSync(new URL('./check-staged-pii.allowlist', import.meta.url), 'utf8')
// The block message states what was found and where; it never guesses why.
const expectFactsOnly = (stderr: string) => {
  expect(stderr).toContain('feedback_no_pii_in_commits')
  expect(stderr).not.toMatch(/\b(likely|probably|perhaps|maybe|looks like|seems|you may want)\b/i)
}

describe('check-staged-pii end-to-end', { timeout: 30_000 }, () => {
  const repo = makeRepo()
  mkdirSync(join(repo, 'scripts'))
  // REAL_3 is listed only in this repo's committed allowlist, not the shipped one.
  commitFile(repo, ALLOWLIST, `${shippedAllowlist}${REAL_3}  a constant of the repo being committed\n`)
  const hook = (command: string) => runHook(repo, command)
  // A failed assertion must not leave its staged or edited files behind for the next test.
  afterEach(() => {
    git(repo, ['reset', '-q', '--hard'])
  })

  it('still blocks when the hook script is reached through a symlinked directory', () => {
    const linked = join(realpathSync(mkdtempSync(join(tmpdir(), 'pii-guard-link-'))), 'scripts')
    symlinkSync(dirname(script), linked)
    const r = runHook(repo, `git commit -m "touch block ${REAL}"`, { scriptPath: join(linked, 'check-staged-pii.mjs') })
    expect(r.status).toBe(2)
  })

  it('blocks a uuid in the -m message', () => {
    const r = hook(`git commit -m "touch block ${REAL}"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('(commit message)')
    expect(r.stderr).toContain(REAL)
    expectFactsOnly(r.stderr)
  })

  it('does NOT block a uuid that is only in a redirect path (scratchpad shape)', () => {
    expect(hook(`git commit -m "clean message" > /tmp/claude-1/${REAL}/scratchpad/out.log`).status).toBe(0)
  })

  it('blocks a uuid smuggled through a variable expansion', () => {
    const r = hook(`MSG="touch block ${REAL}"; git commit -m "$MSG"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('(command line)')
    expectFactsOnly(r.stderr)
  })

  it('blocks a uuid beside a slash in a variable-expanded message', () => {
    const r = hook(`MSG="fix page/${REAL} rendering"; git commit -m "$MSG"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('(command line)')
  })

  it('blocks a uuid in a heredoc commit body (the $(cat <<EOF) shape)', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nfix block ${REAL}\nEOF\n)"`
    expect(hook(cmd).status).toBe(2)
  })

  it('does not block printed prose that mentions git commit beside a uuid', () => {
    expect(hook(`printf '%s\\n' git commit -m ${REAL}`).status).toBe(0)
  })

  it('still blocks a staged uuid regardless of the command line', () => {
    stage(repo, 'g.txt', `id: ${REAL}\n`)
    const r = hook('git commit -m "clean message"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(`  g.txt:1: ${REAL}`)
    expectFactsOnly(r.stderr)
  })

  it('blocks a uuid on a content line that reads like a +++ file header', () => {
    stage(repo, 'inc.c', `++ x; // ${REAL}\n`)
    const r = hook('git commit -m "increment"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(`  inc.c:1: ${REAL}`)
  })

  it('blocks a uuid on an edited last line that has no trailing newline', () => {
    commitFile(repo, 'tail.txt', 'a\nb')
    stage(repo, 'tail.txt', `a\nb ${REAL}`)
    const r = hook('git commit -m "edit tail"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(`  tail.txt:2: ${REAL}`)
  })

  it('blocks a high-entropy uuid that overlaps an exempt one', () => {
    stage(repo, 'glued.txt', `x 00000000-0000-0000-0000-0000${REAL}\n`)
    const r = hook('git commit -m "glued"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(REAL)
  })

  describe('synthetic and allowlisted uuids', () => {
    it('allows synthetic fixture uuids staged in a test file', () => {
      stage(
        repo,
        'fixtures.test.ts',
        [
          `const A = '550e8400-e29b-41d4-a716-446655440000'`,
          `const B = '0000c0de-0000-7000-8000-000000000001'`,
          `const C = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'`,
        ].join('\n') + '\n',
      )
      expect(hook('git commit -m "add fixtures"').status).toBe(0)
    })

    it('allows a synthetic uuid in the message and in an expanded variable', () => {
      expect(hook('git commit -m "use 00000000-0000-4000-8000-000000000000 as the nil id"').status).toBe(0)
      expect(hook('MSG="fixture 11111111-1111-4111-8111-111111111111"; git commit -m "$MSG"').status).toBe(0)
    })

    it('allows the shipped allowlisted namespace constant', () => {
      stage(repo, 'ns.ts', `const READWISE_NS = '${READWISE_NS}'\n`)
      expect(hook('git commit -m "touch namespace"').status).toBe(0)
    })

    it('allows a uuid listed in the committed allowlist of the repo being committed', () => {
      stage(repo, 'ns3.ts', `const LOCAL_NS = '${REAL_3}'\n`)
      expect(hook('git commit -m "touch namespace"').status).toBe(0)
    })

    it('blocks a new allowlist entry, and its uuid elsewhere, until the entry is committed', () => {
      stage(repo, ALLOWLIST, `${shippedAllowlist}${REAL_3}  x\n${REAL_2}  a namespace added with its constant\n`)
      stage(repo, 'ns2.ts', `const NEW_NS = '${REAL_2}'\n`)
      const r = hook('git commit -m "add namespace"')
      expect(r.status).toBe(2)
      const entryLine = shippedAllowlist.split('\n').length + 1 // after the shipped lines and the REAL_3 entry
      expect(r.stderr).toContain(`  ${ALLOWLIST}:${entryLine}: ${REAL_2}`)
      expect(r.stderr).toContain(`  ns2.ts:1: ${REAL_2}`)
    })

    it('blocks a uuid whose allowlist entry is only in the working tree', () => {
      write(repo, ALLOWLIST, `${shippedAllowlist}${REAL_3}  x\n${REAL_2}  a namespace added with its constant\n`)
      stage(repo, 'ns2.ts', `const NEW_NS = '${REAL_2}'\n`)
      const r = hook('git commit -m "add namespace"')
      expect(r.status).toBe(2)
      expect(r.stderr).toContain(REAL_2)
    })

    it('blocks a high-entropy uuid in a test file', () => {
      stage(repo, 'real.test.ts', `const id = '${REAL}'\n`)
      const r = hook('git commit -m "add test"')
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('real.test.ts')
    })

    it('blocks a high-entropy uuid on a line that also holds exempt ones', () => {
      stage(repo, 'mixed.ts', `[${READWISE_NS}, 00000000-0000-4000-8000-000000000000, ${REAL}]\n`)
      const r = hook('git commit -m "mixed"')
      expect(r.status).toBe(2)
      expect(r.stderr).toContain(REAL)
      expect(r.stderr).not.toContain(READWISE_NS)
    })
  })

  describe('VAR= values', () => {
    const scratch = `/private/tmp/claude-501/-Users-someone-project/${REAL}/scratchpad`

    it('allows the session directory of the Claude Code temp root', () => {
      expect(hook(`S=${scratch} && git commit -F "$S/msg.txt"`).status).toBe(0)
      expect(hook(`S="${scratch}/"; git commit -m "clean"`).status).toBe(0)
      expect(hook(`S=/tmp/claude-1000/project/${REAL}; git commit -m "clean"`).status).toBe(0)
    })

    it.each([
      ['in an absolute route', `MSG="/page/${REAL}/rendering"`],
      ['after the last slash', `S=/tmp/${REAL}`],
      ['inside a filename', `S=/tmp/x/${REAL}.txt`],
      ['inside a directory name', `S=/tmp/run-${REAL}/x`],
      ['in a relative path', `S=tmp/${REAL}/x`],
      ['as a session directory under another root', `S=/home/x/tmp/claude-501/project/${REAL}/scratchpad`],
      ['as the project directory of the temp root', `S=/tmp/claude-501/${REAL}/scratchpad`],
      ['below the session directory', `S=/tmp/claude-501/project/sub/${REAL}/scratchpad`],
      ['as a session directory name with a suffix', `S=/tmp/claude-501/project/${REAL}.bak/x`],
    ])('blocks a uuid %s', (_label, assign) => {
      const r = hook(`${assign}; git commit -m "clean"`)
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('(command line)')
    })

    it('blocks a second uuid in a filename of an otherwise exempt path', () => {
      const r = hook(`S=${scratch}/${REAL_2}.txt; git commit -m "clean"`)
      expect(r.status).toBe(2)
      expect(r.stderr).toContain(REAL_2)
    })
  })
})

describe('check-staged-pii under git configuration that reshapes the diff', { timeout: 30_000 }, () => {
  it.each([
    ['diff.noprefix', 'true'],
    ['diff.mnemonicPrefix', 'true'],
    ['diff.dstPrefix', 'new/'],
  ])('blocks and names the file with %s=%s', (key, value) => {
    const repo = makeRepo()
    git(repo, ['config', key, value])
    stage(repo, 'g.txt', `id: ${REAL}\n`)
    const r = runHook(repo, 'git commit -m "clean"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(`  g.txt:1: ${REAL}`)
  })

  it('scans the whole index from a subdirectory with diff.relative=true', () => {
    const repo = makeRepo()
    git(repo, ['config', 'diff.relative', 'true'])
    mkdirSync(join(repo, 'sub'))
    stage(repo, 'g.txt', `id: ${REAL}\n`)
    const r = runHook(repo, 'git commit -m "clean"', { cwd: join(repo, 'sub') })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(`  g.txt:1: ${REAL}`)
  })

  it('numbers lines past the context lines of fused hunks (diff.interHunkContext)', () => {
    const repo = makeRepo()
    git(repo, ['config', 'diff.interHunkContext', '10'])
    commitFile(repo, 'f2.txt', 'a\nb\nc\nd\ne\n')
    stage(repo, 'f2.txt', `a\n${REAL_2}\nb\nc\nd\n${REAL}\ne\n`)
    const r = runHook(repo, 'git commit -m "clean"')
    expect(r.stderr).toContain(`  f2.txt:2: ${REAL_2}`)
    expect(r.stderr).toContain(`  f2.txt:6: ${REAL}`)
  })

  it.each([
    ['café.md', 'café.md'],
    ['a"b.md', 'a\\"b.md'],
    ['a b.md', 'a b.md'],
  ])('blocks and names a staged file called %s', (file, shown) => {
    const repo = makeRepo()
    stage(repo, file, `id: ${REAL}\n`)
    const r = runHook(repo, 'git commit -m "clean"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(`  ${shown}:1: ${REAL}`)
  })

  it('prints nothing outside a git repository', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pii-guard-norepo-')))
    const r = runHook(dir, 'git commit -m "clean"')
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
  })
})

describe('check-staged-pii during a merge', { timeout: 30_000 }, () => {
  const repo = makeRepo()
  const hook = (command: string) => runHook(repo, command)
  startMerge(repo, { side: { 'side.txt': `id: ${REAL}\n` } })

  it('does not flag lines the merged branch already committed', () => {
    expect(git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).trim()).not.toBe('')
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('side.txt')
    expect(hook('git commit -m "merge side"').status).toBe(0)
  })

  it('blocks a line new relative to both parents', () => {
    onTestFinished(() => {
      git(repo, ['rm', '-q', '--cached', '--ignore-unmatch', 'resolution.txt'])
    })
    stage(repo, 'resolution.txt', `id: ${REAL_2}\n`)
    const r = hook('git commit -m "merge side"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('resolution.txt')
    expect(r.stderr).not.toContain('side.txt')
    expect(r.stderr).toContain('scanned only where new relative to HEAD and every merge head')
    expectFactsOnly(r.stderr)
  })

  it('blocks a uuid added to a merged file during resolution', () => {
    stage(repo, 'side.txt', `id: ${REAL}\nnote: ${REAL_2}\n`)
    const r = hook('git commit -m "merge side"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(REAL_2)
    expect(r.stderr).not.toContain(REAL)
  })
})

describe('check-staged-pii during other merge shapes', { timeout: 30_000 }, () => {
  it('does not flag either parent copy of a line both parents add', () => {
    const repo = makeRepo()
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`)
    const withIdAt = (at: number) => [...lines.slice(0, at), `id: ${REAL}`, ...lines.slice(at)].join('\n') + '\n'
    commitFile(repo, 'shared.txt', lines.join('\n') + '\n')
    git(repo, ['checkout', '-q', '-b', 'side'])
    commitFile(repo, 'shared.txt', withIdAt(2))
    git(repo, ['checkout', '-q', 'base'])
    commitFile(repo, 'shared.txt', withIdAt(10))
    git(repo, ['merge', '-q', '--no-commit', '--no-ff', 'side'])
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8').split(REAL)).toHaveLength(3)
    expect(runHook(repo, 'git commit -m "merge side"').status).toBe(0)
  })

  it('does not flag lines any head of an octopus merge already committed', () => {
    const repo = makeRepo()
    startMerge(repo, { one: { 'a.txt': `id: ${REAL}\n` }, two: { 'b.txt': `id: ${REAL_2}\n` } })
    expect(git(repo, ['diff', '--cached', '--name-only']).trim().split('\n')).toEqual(['a.txt', 'b.txt'])
    expect(runHook(repo, 'git commit -m "octopus"').status).toBe(0)
  })

  it('blocks a uuid resolved in after a merged content line that reads like a +++ file header', () => {
    const repo = makeRepo()
    startMerge(repo, { side: { 's.txt': '++ a\n' } })
    stage(repo, 's.txt', `++ a\nid: ${REAL_2}\n`)
    const r = runHook(repo, 'git commit -m "merge side"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(`  s.txt:2: ${REAL_2}`)
  })

  it('treats a branch named MERGE_HEAD as no merge', () => {
    const repo = makeRepo()
    git(repo, ['checkout', '-q', '-b', 'holder'])
    commitFile(repo, 'g.txt', `id: ${REAL}\n`)
    git(repo, ['checkout', '-q', 'base'])
    git(repo, ['branch', 'MERGE_HEAD', 'holder'])
    stage(repo, 'g.txt', `id: ${REAL}\n`)
    expect(runHook(repo, 'git commit -m "clean"').status).toBe(2)
  })

  it('scans every staged line, and says so, when a merge head cannot be diffed', () => {
    const repo = makeRepo()
    stage(repo, 'g.txt', `id: ${REAL}\n`)
    const mergeHeadFile = git(repo, ['rev-parse', '--git-path', 'MERGE_HEAD']).trim()
    writeFileSync(join(repo, mergeHeadFile), `${'1'.repeat(8)}${'2'.repeat(32)}\n`)
    const r = runHook(repo, 'git commit -m "clean"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(`  g.txt:1: ${REAL}`)
    expect(r.stderr).not.toContain('scanned only where new')
    expect(r.stderr).toContain('every line added relative to HEAD was scanned')
  })
})
