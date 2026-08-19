import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  allowsBeadIds,
  bodyFilePaths,
  buildDenyMessage,
  deriveLabelPriority,
  extractBeadIds,
  issueNumberFromRef,
  matchesPrCommand,
  planClosePushes,
  planCloseReconciliation,
  planPriorityFixes,
  REPO,
  resolveBodyPath,
  type BeadRow,
  type IssueInfo,
} from './bd-github-sync.mjs'

const ref = (n: number) => `https://github.com/${REPO}/issues/${n}`
const issues = (entries: [number, IssueInfo][]) => new Map<number, IssueInfo>(entries)
const bead = (over: Partial<BeadRow>): BeadRow => ({
  id: 'km-x',
  status: 'open',
  priority: 2,
  external_ref: ref(1),
  ...over,
})
const byId = (beads: BeadRow[]) => new Map(beads.map(b => [b.id, b]))

describe('extractBeadIds', () => {
  it('finds short and long-form ids, deduplicated, in order', () => {
    expect(
      extractBeadIds('Fixes km-e4aa and km-1786746066130-174-003836b1; part of km-e4aa'),
    ).toEqual(['km-e4aa', 'km-1786746066130-174-003836b1'])
  })

  it('does not match inside larger words or hyphen chains', () => {
    // "km-" must start the token: a branch or package name containing the
    // letters must not trip the PR gate.
    expect(extractBeadIds('vkm-abc akm-def wikm-1')).toEqual([])
    expect(extractBeadIds('beads-github-sync-workflow km-')).toEqual([])
  })

  it('matches ids embedded in punctuation but not uppercase variants', () => {
    expect(extractBeadIds('(km-abc), km-def.')).toEqual(['km-abc', 'km-def'])
    expect(extractBeadIds('KM-ABC')).toEqual([])
  })
})

describe('matchesPrCommand', () => {
  it.each([
    'gh pr create --title t --body b',
    'cd /repo && gh pr create -F body.md',
    'gh pr edit 12 --body "x"',
    'gh pr comment 12 --body "x"',
    'gh pr review 5 --body "looks wrong"',
    'gh pr merge 5 --body "merge text"',
    'gh issue create --title t --body b',
    'gh issue edit 9 --body "x"',
    'gh issue close 9 --comment "done"',
    'gh issue comment 34 --body-file /tmp/c.md',
    'gh release create v1 --notes "x"',
    'GITHUB_TOKEN=x gh pr create --fill',
    'foo; gh issue create -t t',
    // command substitutions execute even inside double quotes
    'echo "$(gh pr create --fill)"',
    'x=`gh issue create -t t`',
    // wrapper commands and path-qualified gh still publish
    'env gh pr create --body x',
    'xargs gh issue close',
    '/usr/local/bin/gh pr create --fill',
    'VAR="a b" gh pr edit 1 --body x',
  ])('matches publishing command: %s', cmd => {
    expect(matchesPrCommand(cmd)).toBe(true)
  })

  it.each([
    'gh pr view 12',
    'gh pr list',
    'gh issue list',
    'gh issue view 9',
    'echo hello',
    // gh not in command position: text that merely MENTIONS a publishing
    // command must not trip the gate (it could mint issues as a side effect).
    'git commit -m "docs: gh pr comment flow"',
    'git log --grep "gh issue create"',
    'echo "run gh pr create later"',
    // quoted prose with fake segment starts must not fake command position
    'git commit -m "fix parser; gh pr comment is the follow-up"',
    'git commit -m "fix x\ngh pr comment next\nrefs the tracker"',
    "echo 'single quotes never execute $(gh pr create)'",
  ])('ignores non-publishing command: %s', cmd => {
    expect(matchesPrCommand(cmd)).toBe(false)
  })
})

describe('allowsBeadIds', () => {
  it('honors the marker in command-prefix position', () => {
    expect(allowsBeadIds('KM_ALLOW_BEAD_IDS=1 gh pr create --body "km-abc"')).toBe(true)
    expect(allowsBeadIds('cd /r && KM_ALLOW_BEAD_IDS=1 gh pr edit 1 --body x')).toBe(true)
    expect(allowsBeadIds('FOO=bar KM_ALLOW_BEAD_IDS=1 gh pr create')).toBe(true)
  })

  it('ignores the marker quoted inside an argument (it would be published)', () => {
    expect(allowsBeadIds('gh pr create --body "mentions KM_ALLOW_BEAD_IDS=1 in prose"')).toBe(false)
    // quoted prose with a fake segment start must not smuggle the marker in
    expect(allowsBeadIds('gh pr create --body "prose; KM_ALLOW_BEAD_IDS=1 more"')).toBe(false)
    expect(allowsBeadIds('gh pr create --body "line one\nKM_ALLOW_BEAD_IDS=1 line two"')).toBe(false)
  })
})

describe('bodyFilePaths / resolveBodyPath', () => {
  it('extracts plain, =-joined, and quoted paths from --body-file and -F', () => {
    expect(bodyFilePaths('gh pr create --body-file /tmp/a.md')).toEqual(['/tmp/a.md'])
    expect(bodyFilePaths('gh pr create --body-file=/tmp/b.md')).toEqual(['/tmp/b.md'])
    expect(bodyFilePaths(`gh pr create -F "/tmp/with space.md" -F '/tmp/q.md'`)).toEqual([
      '/tmp/with space.md',
      '/tmp/q.md',
    ])
  })

  it('skips the stdin sentinel', () => {
    expect(bodyFilePaths('gh pr create -F -')).toEqual([])
  })

  it('resolves ~, absolute, and relative paths like the shell would have', () => {
    expect(resolveBodyPath('~/b.md', '/cwd', '/home/u')).toBe('/home/u/b.md')
    expect(resolveBodyPath('/abs/b.md', '/cwd', '/home/u')).toBe('/abs/b.md')
    expect(resolveBodyPath('rel/b.md', '/cwd', '/home/u')).toBe('/cwd/rel/b.md')
  })
})

describe('deriveLabelPriority', () => {
  it('reads the machine label (upstream word vocabulary) first, then the hand label', () => {
    expect(deriveLabelPriority(['priority::high', 'P3'])).toBe(1)
    expect(deriveLabelPriority(['priority::critical'])).toBe(0)
    expect(deriveLabelPriority(['priority::none'])).toBe(4)
    expect(deriveLabelPriority(['bug', 'P3'])).toBe(3)
    expect(deriveLabelPriority(['p0'])).toBe(0)
  })

  it('returns null when no priority label exists or it is out of range', () => {
    expect(deriveLabelPriority(['bug', 'ui'])).toBeNull()
    expect(deriveLabelPriority(['P5', 'priority::9', 'priority::urgent'])).toBeNull()
  })
})

describe('issueNumberFromRef', () => {
  it('parses the trailing issue number of a ref into THIS repo', () => {
    expect(issueNumberFromRef(ref(600))).toBe(600)
  })

  it('returns null for absent, non-issue, or FOREIGN refs', () => {
    expect(issueNumberFromRef(null)).toBeNull()
    expect(issueNumberFromRef(`https://github.com/${REPO}/pull/600`)).toBeNull()
    // A number collision on another repo's issues must never close ours.
    expect(issueNumberFromRef('https://github.com/gastownhall/beads/issues/42')).toBeNull()
  })
})

describe('planCloseReconciliation', () => {
  it('closes only non-closed beads whose GitHub issue is closed — deferred included', () => {
    const plan = planCloseReconciliation(
      [
        bead({ id: 'km-a', external_ref: ref(1) }),
        bead({ id: 'km-b', status: 'in_progress', external_ref: ref(2) }),
        bead({ id: 'km-f', status: 'deferred', external_ref: ref(6) }),
        bead({ id: 'km-c', status: 'closed', external_ref: ref(3) }),
        bead({ id: 'km-d', external_ref: null }),
        bead({ id: 'km-e', external_ref: ref(5) }),
      ],
      issues([
        [1, { state: 'CLOSED', labels: [] }],
        [2, { state: 'CLOSED', labels: [] }],
        [6, { state: 'CLOSED', labels: [] }],
        [3, { state: 'CLOSED', labels: [] }],
        [5, { state: 'OPEN', labels: [] }],
      ]),
    )
    expect(plan).toEqual([
      { id: 'km-a', number: 1 },
      { id: 'km-b', number: 2 },
      { id: 'km-f', number: 6 },
    ])
  })
})

describe('planClosePushes', () => {
  it('pushes closes for closed beads whose issue is open — or minted beyond the fetched range', () => {
    const plan = planClosePushes(
      [
        bead({ id: 'km-a', status: 'closed', external_ref: ref(1) }), // open issue → push
        bead({ id: 'km-b', status: 'closed', external_ref: ref(2) }), // closed issue → converged
        bead({ id: 'km-c', status: 'closed', external_ref: ref(700) }), // minted during this run (beyond max) → push
        bead({ id: 'km-g', status: 'closed', external_ref: ref(4) }), // absent WITHIN range → deleted/transferred, leave
        bead({ id: 'km-d', status: 'closed', external_ref: null }), // never synced → nothing to push to
        bead({ id: 'km-e', status: 'open', external_ref: ref(5) }), // not closed → not ours
      ],
      issues([
        [1, { state: 'OPEN', labels: [] }],
        [2, { state: 'CLOSED', labels: [] }],
        [5, { state: 'OPEN', labels: [] }],
      ]),
      5,
    )
    expect(plan).toEqual([
      { id: 'km-a', number: 1 },
      { id: 'km-c', number: 700 },
    ])
  })
})

describe('planPriorityFixes', () => {
  it('restores beads this run flattened (pre ≠2 → post 2) to their pre-sync value', () => {
    const pre = byId([bead({ id: 'km-flat', priority: 1 }), bead({ id: 'km-was2', priority: 2 })])
    const post = [
      bead({ id: 'km-flat', priority: 2 }), // flattened by this run → restore 1
      bead({ id: 'km-was2', priority: 2 }), // was already 2 → possibly deliberate → untouched
    ]
    expect(planPriorityFixes(pre, post, issues([]))).toEqual([{ id: 'km-flat', to: 1 }])
  })

  it('does not fight a deliberate P2 even when a stale hand label disagrees', () => {
    const pre = byId([bead({ id: 'km-deliberate', priority: 2, external_ref: ref(1) })])
    const post = [bead({ id: 'km-deliberate', priority: 2, external_ref: ref(1) })]
    expect(planPriorityFixes(pre, post, issues([[1, { state: 'OPEN', labels: ['P1'] }]]))).toEqual([])
  })

  it('derives from labels only for beads NEW this run', () => {
    const post = [
      bead({ id: 'km-new-hand', priority: 2, external_ref: ref(1) }), // new + hand label → derive
      bead({ id: 'km-new-machine', priority: 2, external_ref: ref(2) }), // new + machine label → derive
      bead({ id: 'km-new-none', priority: 2, external_ref: ref(3) }), // new, no label → leave
      bead({ id: 'km-new-p2', priority: 2, external_ref: ref(4) }), // new, label agrees → leave
      bead({ id: 'km-closed', status: 'closed', priority: 2, external_ref: ref(1) }), // closed → not ours
    ]
    expect(
      planPriorityFixes(
        byId([]),
        post,
        issues([
          [1, { state: 'OPEN', labels: ['P1'] }],
          [2, { state: 'OPEN', labels: ['priority::high'] }],
          [3, { state: 'OPEN', labels: ['bug'] }],
          [4, { state: 'OPEN', labels: ['P2'] }],
        ]),
      ),
    ).toEqual([
      { id: 'km-new-hand', to: 1 },
      { id: 'km-new-machine', to: 1 },
    ])
  })
})

describe('buildDenyMessage', () => {
  it('lists the substitution table and flags unmapped ids', () => {
    const msg = buildDenyMessage([{ id: 'km-a', number: 12 }], ['km-zz'])
    expect(msg).toContain('km-a → #12')
    expect(msg).toContain('issues/12')
    expect(msg).toContain('km-zz')
    expect(msg).toContain('KM_ALLOW_BEAD_IDS=1')
  })
})

// Process-level pins for hookPrePr's composition — the ordering and gating
// that unit tests on the pure functions cannot see. Runs the real entry point
// in a scratch git repo with NO .beads/embeddeddolt and a PATH-fronted `bd`
// shim that logs every invocation: the fresh-clone invariant is exactly "no
// bd process is ever spawned there" (the first bd command would create an
// empty DB that then refuses to pull).
// Measured ~150ms per spawn solo; budgeted for the 6x load stretch.
describe('hookPrePr process behavior', { timeout: 20_000 }, () => {
  const script = fileURLToPath(new URL('./bd-github-sync.mjs', import.meta.url))

  const makeRepo = (opts: { dbReady: boolean }) => {
    const repo = mkdtempSync(join(tmpdir(), 'bd-sync-hook-'))
    spawnSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, '.beads'))
    if (opts.dbReady) mkdirSync(join(repo, '.beads', 'embeddeddolt'))
    const shimDir = join(repo, 'shim')
    mkdirSync(shimDir)
    const shimLog = join(repo, 'bd-shim.log')
    writeFileSync(shimLog, '')
    writeFileSync(join(shimDir, 'bd'), `#!/bin/sh\necho "bd $@" >> "${shimLog}"\nexit 0\n`)
    chmodSync(join(shimDir, 'bd'), 0o755)
    const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, BD_GITHUB_SYNC_DRY: '1' }
    const hook = (command: string) => {
      const payload = JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command } })
      return spawnSync('node', [script, '--hook-pre-pr'], { cwd: repo, env, input: payload, encoding: 'utf8' })
    }
    return { hook, shimCalls: () => readFileSync(shimLog, 'utf8') }
  }

  it('blocks a bead-id publish in a DB-less clone WITHOUT ever spawning bd', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: false })
    const r = hook('gh pr create --title t --body "tracks km-zzzz"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('km-zzzz')
    expect(r.stderr).toContain('No GitHub issue found')
    expect(shimCalls()).toBe('')
  })

  it('honors the escape hatch BEFORE any lookup or mint (DB-ready repo, zero bd calls)', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    const r = hook('KM_ALLOW_BEAD_IDS=1 gh pr create --body "km-zzzz deliberately"')
    expect(r.status).toBe(0)
    expect(shimCalls()).toBe('')
  })

  it('lets a quoted mention of a publishing command pass end-to-end', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: false })
    const r = hook('git commit -m "fix parser; gh pr comment is the follow-up\nrefs km-zzzz"')
    expect(r.status).toBe(0)
    expect(shimCalls()).toBe('')
  })
})
