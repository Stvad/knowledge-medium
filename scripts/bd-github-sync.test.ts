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
  detectReverts,
  extractBeadIds,
  issueNumberFromRef,
  matchesPrCommand,
  planClosePushes,
  planCloseReconciliation,
  planLocalWins,
  planPriorityFixes,
  planRestoreArgs,
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
    // apostrophes inside double-quoted args must not bridge spans and
    // swallow the publish between them (round-3 regression shape)
    `git commit -m "don't regress the parser" && gh pr comment 5 --body "it doesn't handle km-abc yet"`,
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
    // apostrophes in surrounding args must not swallow the marker
    expect(
      allowsBeadIds(`git commit -m "don't" && KM_ALLOW_BEAD_IDS=1 gh pr comment 5 --body "isn't km-x"`),
    ).toBe(true)
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

describe('planLocalWins', () => {
  it('flags a bead whose local row is strictly newer than its GitHub copy', () => {
    const beads = [bead({ id: 'km-a', external_ref: ref(1), updated_at: '2026-08-20T02:00:00Z' })]
    const map = issues([[1, { state: 'OPEN', labels: [], updatedAt: '2026-08-20T01:00:00Z' }]])
    expect(planLocalWins(beads, map)).toEqual([{ id: 'km-a', number: 1 }])
  })

  it('does not flag older-or-equal local rows, unmapped beads, or missing timestamps', () => {
    const map = issues([[1, { state: 'OPEN', labels: [], updatedAt: '2026-08-20T01:00:00Z' }]])
    expect(planLocalWins([bead({ external_ref: ref(1), updated_at: '2026-08-20T00:59:00Z' })], map)).toEqual([])
    expect(planLocalWins([bead({ external_ref: ref(1), updated_at: '2026-08-20T01:00:00Z' })], map)).toEqual([])
    expect(planLocalWins([bead({ external_ref: null, updated_at: '2026-08-20T02:00:00Z' })], map)).toEqual([])
    expect(planLocalWins([bead({ external_ref: ref(1) })], map)).toEqual([])
    expect(
      planLocalWins(
        [bead({ external_ref: ref(2), updated_at: '2026-08-20T02:00:00Z' })],
        issues([[2, { state: 'OPEN', labels: [] }]]),
      ),
    ).toEqual([])
  })
})

describe('detectReverts', () => {
  const snap = bead({
    id: 'km-a',
    status: 'in_progress',
    priority: 1,
    title: 'T',
    description: 'D-new',
    updated_at: '2026-08-20T02:00:00Z',
  })

  it('reports a snapshot row whose issue-backed fields changed', () => {
    for (const change of [
      { status: 'open' },
      { description: 'D-old' },
      { title: 'T-old' },
      { priority: 2 },
    ] satisfies Partial<BeadRow>[]) {
      expect(detectReverts([snap], byId([{ ...snap, ...change }]))).toEqual([snap])
    }
  })

  it('stays quiet when nothing changed or the row vanished', () => {
    expect(detectReverts([snap], byId([{ ...snap }]))).toEqual([])
    expect(detectReverts([snap], byId([]))).toEqual([])
  })
})

describe('planRestoreArgs', () => {
  it('restores an open-lifecycle row with one update carrying the status', () => {
    const row = bead({ id: 'km-a', status: 'in_progress', priority: 1, title: 'T', description: 'D', assignee: 'V' })
    expect(planRestoreArgs(row)).toEqual([
      ['update', 'km-a', '--title', 'T', '-d', 'D', '-p', '1', '-a', 'V', '-s', 'in_progress'],
    ])
  })

  it('restores a closed row via close, carrying the original reason', () => {
    const row = bead({ id: 'km-a', status: 'closed', priority: 2, title: 'T', description: 'D', close_reason: 'done' })
    expect(planRestoreArgs(row)).toEqual([
      ['update', 'km-a', '--title', 'T', '-d', 'D', '-p', '2'],
      ['close', 'km-a', '-r', 'done'],
    ])
  })
})

// Process-level pins for runSync's #647 guards: the push-before-pull ordering
// and the snapshot→restore→push-back net, which unit tests on the plan
// functions cannot see. bd and gh are PATH-fronted shims; the bd shim serves
// a different `bd list` fixture per call so the post-pull list can show a
// revert. Measured ~150ms per spawn solo; budgeted for the 6x load stretch.
describe('runSync process behavior', { timeout: 20_000 }, () => {
  const script = fileURLToPath(new URL('./bd-github-sync.mjs', import.meta.url))

  const makeSyncRepo = (opts: { issues: object[]; lists: object[][]; show?: object[] }) => {
    const repo = mkdtempSync(join(tmpdir(), 'bd-sync-run-'))
    spawnSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, '.beads', 'embeddeddolt'), { recursive: true })
    const shimDir = join(repo, 'shim')
    mkdirSync(shimDir)
    const shimLog = join(repo, 'shim.log')
    writeFileSync(shimLog, '')
    writeFileSync(join(repo, 'gh-issues.json'), JSON.stringify(opts.issues))
    opts.lists.forEach((rows, i) => writeFileSync(join(repo, `list-${i + 1}.json`), JSON.stringify(rows)))
    writeFileSync(join(repo, 'list-last.json'), JSON.stringify(opts.lists[opts.lists.length - 1]))
    writeFileSync(join(repo, 'show.json'), JSON.stringify(opts.show ?? [], null, 2))
    writeFileSync(
      join(shimDir, 'bd'),
      [
        '#!/bin/sh',
        `echo "bd $@" >> "${shimLog}"`,
        'case "$1" in',
        '  --version) echo "bd-shim 0.0.0";;',
        '  list)',
        `    n=$(cat "${repo}/list-count" 2>/dev/null || echo 0)`,
        `    n=$((n+1)); echo $n > "${repo}/list-count"`,
        `    if [ -f "${repo}/list-$n.json" ]; then cat "${repo}/list-$n.json"; else cat "${repo}/list-last.json"; fi;;`,
        `  show) cat "${repo}/show.json";;`,
        '  github) echo "Pushed 0 issues";;',
        '  *) echo ok;;',
        'esac',
        'exit 0',
      ].join('\n') + '\n',
    )
    writeFileSync(
      join(shimDir, 'gh'),
      [
        '#!/bin/sh',
        `echo "gh $@" >> "${shimLog}"`,
        'case "$1 $2" in',
        '  "auth token") echo shim-token;;',
        `  "issue list") cat "${repo}/gh-issues.json";;`,
        '  *) echo null;;',
        'esac',
        'exit 0',
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'bd'), 0o755)
    chmodSync(join(shimDir, 'gh'), 0o755)
    const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` }
    const run = () => spawnSync('node', [script], { cwd: repo, env, encoding: 'utf8' })
    return { run, shimCalls: () => readFileSync(shimLog, 'utf8') }
  }

  const ghIssue = (number: number, updatedAt: string) => ({
    number,
    state: 'OPEN',
    labels: [{ name: 'priority::high' }],
    updatedAt,
  })

  it('pushes local state out BEFORE the pull, and stays quiet with no suspects', () => {
    const row = { id: 'km-t1', status: 'open', priority: 1, title: 'T', description: 'D', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z')],
      lists: [[row], [row], [row]],
    })
    const r = run()
    expect(r.status).toBe(0)
    const log = shimCalls()
    const pushOnly = log.indexOf('bd github sync --push-only')
    const bare = log.indexOf('bd github sync\n')
    expect(pushOnly).toBeGreaterThan(-1)
    expect(bare).toBeGreaterThan(-1)
    expect(pushOnly).toBeLessThan(bare)
    expect(log).not.toContain('bd show')
    expect(log).not.toContain('bd update')
    expect(log).not.toContain('bd close')
  })

  // Position pin: the pre-pull push must run AFTER close-adoption — swapped,
  // a still-open bead's push would re-open its GitHub-closed issue (trap 1).
  it('adopts GitHub-side closes BEFORE the pre-pull push', () => {
    const row = { id: 'km-t3', status: 'open', priority: 1, title: 'T', description: 'D', external_ref: ref(3), updated_at: '2026-08-19T00:00:00Z' }
    const { run, shimCalls } = makeSyncRepo({
      issues: [{ number: 3, state: 'CLOSED', labels: [{ name: 'priority::high' }], updatedAt: '2026-08-20T00:00:00Z' }],
      lists: [[row], [{ ...row, status: 'closed' }], [{ ...row, status: 'closed' }]],
    })
    const r = run()
    expect(r.status).toBe(0)
    const log = shimCalls()
    const close = log.indexOf('bd close km-t3')
    const pushOnly = log.indexOf('bd github sync --push-only')
    expect(close).toBeGreaterThan(-1)
    expect(pushOnly).toBeGreaterThan(-1)
    expect(close).toBeLessThan(pushOnly)
  })

  it('restores a newer local row the pull reverted, then pushes it back out', () => {
    const newer = { id: 'km-t2', status: 'in_progress', priority: 1, title: 'T', description: 'D-new', external_ref: ref(2), updated_at: '2026-08-20T02:00:00Z' }
    const revertedRow = { ...newer, status: 'open', description: 'D-old' }
    const snapshot = { ...newer, assignee: 'Vlad' }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(2, '2026-08-20T01:00:00Z')],
      lists: [[newer], [newer], [revertedRow]],
      show: [snapshot],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('restored km-t2')
    const log = shimCalls()
    expect(log).toContain('bd show km-t2 --json')
    expect(log).toContain('bd update km-t2 --title T -d D-new -p 1 -a Vlad -s in_progress')
    expect(log).toContain('bd github sync --push-only --issues km-t2')
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
    // The shim answers --version with real text: initializedDbRoot treats
    // empty stdout as "bd missing", which would silently turn dbReady repos
    // DB-less and make the zero-calls assertions vacuous.
    writeFileSync(join(shimDir, 'bd'), `#!/bin/sh\necho "bd $@" >> "${shimLog}"\necho "bd-shim 0.0.0"\nexit 0\n`)
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

  // Positive control: the zero-calls assertions above are negative tests, so
  // prove the shim plumbing actually intercepts when bd SHOULD run —
  // otherwise a broken PATH front would pass all of them vacuously.
  it('routes lookup through bd in a DB-ready repo (shim interception works)', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    const r = hook('gh pr create --title t --body "tracks km-zzzz"')
    expect(r.status).toBe(2)
    expect(shimCalls()).toContain('bd --version')
    expect(shimCalls()).toContain('bd show km-zzzz --json')
  })
})
