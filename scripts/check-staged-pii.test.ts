import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { isSyntheticUuid, parseAllowlist } from './check-staged-pii.mjs'

// High-entropy ids assembled at runtime, so this file carries no uuid literal
// the guard would flag when it is committed.
const REAL = ['3f9d2b71', 'c84e', '4a06', '9b5e', 'd17a60c2e4f8'].join('-')
const REAL_2 = ['e6a41c09', '5d7b', '4f3e', 'a812', '0c95b7e3d4a6'].join('-')
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
    expect(isSyntheticUuid(REAL)).toBe(false)
    expect(isSyntheticUuid(REAL_2)).toBe(false)
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

const makeRepo = () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pii-guard-')))
  git(repo, ['init', '-q', '-b', 'base'])
  git(repo, ['config', 'user.email', 't@example.com'])
  git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'f.txt'), 'clean\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'base'])
  return repo
}
const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0)
  return r.stdout
}
const script = fileURLToPath(new URL('./check-staged-pii.mjs', import.meta.url))
const runHook = (repo: string, command: string, scriptPath = script) => {
  const payload = JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command } })
  return spawnSync('node', [scriptPath], { cwd: repo, input: payload, encoding: 'utf8' })
}
const ALLOWLIST = 'scripts/check-staged-pii.allowlist'
const shippedAllowlist = readFileSync(new URL('./check-staged-pii.allowlist', import.meta.url), 'utf8')
// The block message states what was found and where; it never guesses why.
const expectFactsOnly = (stderr: string) => {
  expect(stderr).toContain('feedback_no_pii_in_commits')
  expect(stderr).not.toMatch(/\b(likely|probably|perhaps|maybe|looks like|seems)\b/i)
}

describe('check-staged-pii end-to-end', { timeout: 30_000 }, () => {
  const repo = makeRepo()
  mkdirSync(join(repo, 'scripts'))
  writeFileSync(join(repo, ALLOWLIST), shippedAllowlist)
  git(repo, ['add', ALLOWLIST])
  git(repo, ['commit', '-qm', 'allowlist'])
  const hook = (command: string) => runHook(repo, command)
  const stage = (file: string, content: string) => {
    writeFileSync(join(repo, file), content)
    git(repo, ['add', file])
  }
  // A failed assertion must not leave its staged or edited files behind for the next test.
  afterEach(() => {
    git(repo, ['reset', '-q', '--hard'])
  })

  it('still blocks when the hook script is reached through a symlinked directory', () => {
    const linked = join(realpathSync(mkdtempSync(join(tmpdir(), 'pii-guard-link-'))), 'scripts')
    symlinkSync(dirname(script), linked)
    const r = runHook(repo, `git commit -m "touch block ${REAL}"`, join(linked, 'check-staged-pii.mjs'))
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
    stage('g.txt', `id: ${REAL}\n`)
    const r = hook('git commit -m "clean message"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('g.txt')
    expectFactsOnly(r.stderr)
  })

  describe('synthetic and allowlisted uuids', () => {
    it('allows synthetic fixture uuids staged in a test file', () => {
      stage(
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

    it('allows an allowlisted namespace constant', () => {
      stage('ns.ts', `const READWISE_NS = '${READWISE_NS}'\n`)
      expect(hook('git commit -m "touch namespace"').status).toBe(0)
    })

    it('allows a uuid whose allowlist entry is staged in the same commit', () => {
      writeFileSync(join(repo, ALLOWLIST), `${shippedAllowlist}${REAL_2}  a namespace added with its constant\n`)
      git(repo, ['add', ALLOWLIST])
      stage('ns2.ts', `const NEW_NS = '${REAL_2}'\n`)
      expect(hook('git commit -m "add namespace"').status).toBe(0)
    })

    it('blocks a uuid whose allowlist entry is only in the working tree', () => {
      writeFileSync(join(repo, ALLOWLIST), `${shippedAllowlist}${REAL_2}  a namespace added with its constant\n`)
      stage('ns2.ts', `const NEW_NS = '${REAL_2}'\n`)
      const r = hook('git commit -m "add namespace"')
      expect(r.status).toBe(2)
      expect(r.stderr).toContain(REAL_2)
    })

    it('blocks a high-entropy uuid in a test file', () => {
      stage('real.test.ts', `const id = '${REAL}'\n`)
      const r = hook('git commit -m "add test"')
      expect(r.status).toBe(2)
      expect(r.stderr).toContain('real.test.ts')
    })

    it('blocks a high-entropy uuid on a line that also holds exempt ones', () => {
      stage('mixed.ts', `[${READWISE_NS}, 00000000-0000-4000-8000-000000000000, ${REAL}]\n`)
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

describe('check-staged-pii during a merge', { timeout: 30_000 }, () => {
  const repo = makeRepo()
  const hook = (command: string) => runHook(repo, command)
  // The side branch commits its uuid directly, as a branch that already
  // passed (or predates) the guard would.
  git(repo, ['checkout', '-q', '-b', 'side'])
  writeFileSync(join(repo, 'side.txt'), `id: ${REAL}\n`)
  git(repo, ['add', 'side.txt'])
  git(repo, ['commit', '-qm', 'side'])
  git(repo, ['checkout', '-q', 'base'])
  writeFileSync(join(repo, 'f.txt'), 'clean\nbase change\n')
  git(repo, ['commit', '-qam', 'base change'])
  git(repo, ['merge', '-q', '--no-commit', '--no-ff', 'side'])

  it('does not flag lines the merged branch already committed', () => {
    expect(git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).trim()).not.toBe('')
    expect(git(repo, ['diff', '--cached', '--name-only']).trim()).toBe('side.txt')
    expect(hook('git commit -m "merge side"').status).toBe(0)
  })

  it('blocks a line new relative to both parents', () => {
    writeFileSync(join(repo, 'resolution.txt'), `id: ${REAL_2}\n`)
    git(repo, ['add', 'resolution.txt'])
    const r = hook('git commit -m "merge side"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('resolution.txt')
    expect(r.stderr).not.toContain('side.txt')
    expect(r.stderr).toContain('MERGE_HEAD')
    expectFactsOnly(r.stderr)
    git(repo, ['rm', '-q', '--cached', 'resolution.txt'])
  })

  it('blocks a uuid added to a merged file during resolution', () => {
    writeFileSync(join(repo, 'side.txt'), `id: ${REAL}\nnote: ${REAL_2}\n`)
    git(repo, ['add', 'side.txt'])
    const r = hook('git commit -m "merge side"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(REAL_2)
    expect(r.stderr).not.toContain(`id: ${REAL}`)
  })
})
