import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  allowsBeadIds,
  allowsIssueRefs,
  bodyFilePaths,
  buildDenyMessage,
  buildIssueRefsMessage,
  closeKeywordRefs,
  extractIssueRefs,
  deriveLabelPriority,
  detectReverts,
  extractBeadIds,
  issueNumberFromRef,
  matchesCommitCommand,
  hasDynamicBody,
  hasStdinBody,
  matchesPrCommand,
  planClosePushes,
  planCloseReconciliation,
  planLocalWins,
  planMintedNonOpen,
  planReopenedClosed,
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
    'gh pr close 12 --comment "see the tracker"',
    'gh pr reopen 12 -c "reopening"',
    'gh issue reopen 9 -c "still broken"',
    // documented builtin aliases (gh <cmd> create --help, ALIASES section)
    'gh pr new --title t --body b',
    'gh issue new --body "text"',
    'gh release new v2 --notes n',
    // gh global options before the subcommand
    'gh -R Stvad/knowledge-medium pr comment 12 -b "text"',
    'gh --repo other/repo issue create -t t',
    'gh issue comment 34 --body-file /tmp/c.md',
    'gh release create v1 --notes "x"',
    'GITHUB_TOKEN=x gh pr create --fill',
    'foo; gh issue create -t t',
    // command substitutions execute even inside double quotes
    'echo "$(gh pr create --fill)"',
    'x=`gh issue create -t t`',
    // wrapper commands and path-qualified gh still publish
    'env gh pr create --body x',
    'env -u GH_HOST gh pr create --body x',
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

  it('skips the stdin sentinel and its device-path disguises', () => {
    expect(bodyFilePaths('gh pr create -F -')).toEqual([])
    expect(bodyFilePaths('gh pr comment 1 -F /dev/stdin')).toEqual([])
    expect(bodyFilePaths('gh pr comment 1 --body-file /dev/fd/3')).toEqual([])
  })

  it('extracts release notes and PR template files', () => {
    expect(bodyFilePaths('gh release create v1 --notes-file notes.md')).toEqual(['notes.md'])
    expect(bodyFilePaths('gh pr create --template body.md --title t')).toEqual(['body.md'])
  })

  it('handles ATTACHED short-option values without capturing mid-word', () => {
    expect(bodyFilePaths('gh pr create -Fbody.md --title t')).toEqual(['body.md'])
    expect(hasStdinBody('cat x | gh pr comment 1 -F-')).toBe(true)
    // "-F" inside an ordinary word must not start a capture
    expect(bodyFilePaths('gh pr comment 1 --body x-File.md')).toEqual([])
  })

  it('classifies stdin bodies from RAW values — quoting the sentinel must not hide it', () => {
    expect(hasStdinBody('gh pr comment 12 -F "-"')).toBe(true)
    expect(hasStdinBody('gh pr comment 12 -F "/dev/stdin"')).toBe(true)
    expect(hasStdinBody('gh pr comment 12 -F -')).toBe(true)
    expect(hasStdinBody('gh pr comment 12 -F body.md')).toBe(false)
    expect(hasStdinBody('git commit -m "mentions -F - in prose"')).toBe(false)
  })

  // gh issue create's --template names a REPOSITORY template, not a file —
  // resolving it locally made the fail-closed missing-file check block a
  // legitimate command (reproduced by review).
  it('does not read issue-create template names as local files', () => {
    expect(bodyFilePaths('gh issue create --template "Bug Report" --title t')).toEqual([])
  })

  // Hit live: a commit message PROSE-mentioning --notes-file was read as a
  // file reference and the fail-closed missing-file check blocked the commit.
  it('ignores body-file flags that appear only inside quoted prose', () => {
    expect(bodyFilePaths('git commit -m "gh release --notes-file joins body-file extraction"')).toEqual([])
    expect(bodyFilePaths('gh pr comment 5 --body "try --body-file x.md next time"')).toEqual([])
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

describe('extractIssueRefs', () => {
  it('finds and dedups GitHub-style references', () => {
    expect(extractIssueRefs('Fixes #643 and relates to #652; see #643 again')).toEqual([643, 652])
  })

  it('ignores hex colors, HTML entities, and glued word chars', () => {
    expect(extractIssueRefs('color: #652fff; it&#39;s fine; ticket#12x; ###')).toEqual([])
  })

  it('ignores all-numeric 6-digit hex colors but keeps 5-digit issue numbers', () => {
    expect(extractIssueRefs('background: #123456 on #000000')).toEqual([])
    expect(extractIssueRefs('see #12345')).toEqual([12345])
  })

  it('matches refs embedded in ordinary punctuation', () => {
    expect(extractIssueRefs('(#12), #34.')).toEqual([12, 34])
  })
})

describe('closeKeywordRefs', () => {
  it('finds the auto-close keyword forms', () => {
    expect(closeKeywordRefs('Fixes #1, fixed: #2, Closes #3, resolved #4 — and mentions #5')).toEqual([1, 2, 3, 4])
  })

  it('does not fire inside larger words', () => {
    expect(closeKeywordRefs('prefixes #6 and affixed #7')).toEqual([])
  })
})

describe('allowsIssueRefs', () => {
  it('honors the escape in command position, not in quoted prose', () => {
    expect(allowsIssueRefs('KM_ISSUE_REFS_OK=1 gh pr create --body "see #12"')).toBe(true)
    expect(allowsIssueRefs('gh pr create --body "run with KM_ISSUE_REFS_OK=1 next time"')).toBe(false)
  })
})

describe('hasDynamicBody', () => {
  it('flags expansion-built bodies, leaves literal and single-quoted ones alone', () => {
    expect(hasDynamicBody('gh pr comment 1 --body "$(cat body.md)"')).toBe(true)
    expect(hasDynamicBody('gh pr comment 1 -b "$BODY"')).toBe(true)
    expect(hasDynamicBody('gh release create v1 --notes "`gen-notes`"')).toBe(true)
    expect(hasDynamicBody('gh pr merge 1 --subject "$(cat subject.md)"')).toBe(true)
    // attached short-option values are CLI-supported: -t"$(…)" and -tfoo
    expect(hasDynamicBody('gh pr merge 1 -t"$(cat subject.md)"')).toBe(true)
    expect(hasDynamicBody('gh pr comment 1 -b"$MESSAGE"')).toBe(true)
    expect(hasDynamicBody('gh issue close 1 -c "$(cat message.txt)"')).toBe(true)
    expect(hasDynamicBody('gh pr reopen 1 --comment "$MESSAGE"')).toBe(true)
    expect(hasDynamicBody('gh pr create -t "$TITLE" -b b')).toBe(true)
    expect(hasDynamicBody('gh pr comment 1 --body "plain #12 text"')).toBe(false)
    expect(hasDynamicBody("gh pr comment 1 --body '$(literal, single quotes)'")).toBe(false)
    expect(hasDynamicBody('git commit -m "escape \\$PATH handling"')).toBe(false)
  })
})

describe('qualified issue references', () => {
  it('normalizes owner/repo#N and issue URLs for THIS repo', () => {
    expect(extractIssueRefs(`Fixes ${REPO}#123`)).toEqual([123])
    expect(extractIssueRefs(`see https://github.com/${REPO}/issues/456 and github.com/${REPO}/pull/789`)).toEqual([456, 789])
    expect(closeKeywordRefs(`Fixes ${REPO}#123`)).toEqual([123])
    expect(closeKeywordRefs(`resolves https://github.com/${REPO}/issues/456`)).toEqual([456])
  })

  it('leaves foreign-repo qualified refs alone', () => {
    expect(extractIssueRefs('Fixes gastownhall/beads#42')).toEqual([])
    expect(extractIssueRefs('see https://github.com/gastownhall/beads/issues/42')).toEqual([])
  })
})

describe('matchesCommitCommand', () => {
  it('matches git commit in command position, not in quoted prose', () => {
    expect(matchesCommitCommand('git commit -m "message"')).toBe(true)
    expect(matchesCommitCommand('/usr/bin/git commit --amend')).toBe(true)
    expect(matchesCommitCommand('echo "git commit is next"')).toBe(false)
    expect(matchesCommitCommand('git log')).toBe(false)
  })

  it('sees through git global options before the subcommand', () => {
    expect(matchesCommitCommand('git -C /workspace/repo commit -m m')).toBe(true)
    expect(matchesCommitCommand('git -c user.name=x commit -m m')).toBe(true)
    expect(matchesCommitCommand('git --git-dir=/r/.git commit -m m')).toBe(true)
    expect(matchesCommitCommand('git push origin commit')).toBe(false)
  })
})

describe('buildIssueRefsMessage', () => {
  it('echoes ground truth and flags the dangerous shapes', () => {
    const msg = buildIssueRefsMessage(
      [
        { number: 653, info: { title: 'Real title', state: 'open', isPr: false } },
        { number: 999, info: 'not-found' },
        { number: 700, info: { title: 'Some PR', state: 'open', isPr: true } },
        { number: 500, info: { title: 'Done already', state: 'closed', isPr: false } },
        { number: 42, info: null },
      ],
      new Set([700, 500]),
    )
    expect(msg).toContain('#653 → "Real title" (issue, open)')
    expect(msg).toContain('#999 → NO SUCH ISSUE OR PR')
    expect(msg).toContain('close keyword targets a PR')
    expect(msg).toContain('close keyword on an already-closed issue')
    expect(msg).toContain('#42 → COULD NOT VERIFY')
    // an unresolved reference suppresses the bypass footer: offering it
    // there would invite bypassing a reference no one has read
    expect(msg).not.toContain('KM_ISSUE_REFS_OK=1')
    expect(msg).toContain('could not be verified')
  })

  it('offers the bypass only when every reference resolved to a real title', () => {
    const msg = buildIssueRefsMessage(
      [{ number: 653, info: { title: 'Real title', state: 'open', isPr: false } }],
      new Set<number>(),
    )
    expect(msg).toContain('KM_ISSUE_REFS_OK=1')
    // a nonexistent number has no title anyone could have verified
    const notFound = buildIssueRefsMessage([{ number: 999, info: 'not-found' }], new Set<number>())
    expect(notFound).not.toContain('KM_ISSUE_REFS_OK=1')
  })
})

describe('planReopenedClosed', () => {
  it('flags a closed bead whose linked issue is open (GitHub-side reopen)', () => {
    const beads = [bead({ id: 'km-a', status: 'closed', external_ref: ref(9) })]
    expect(planReopenedClosed(beads, issues([[9, { state: 'OPEN', labels: [] }]]))).toEqual([
      { id: 'km-a', number: 9 },
    ])
  })

  it('ignores open beads, closed issues, and unlinked beads', () => {
    const map = issues([[9, { state: 'CLOSED', labels: [] }]])
    expect(planReopenedClosed([bead({ id: 'km-a', status: 'closed', external_ref: ref(9) })], map)).toEqual([])
    expect(planReopenedClosed([bead({ id: 'km-a', status: 'open', external_ref: ref(9) })], issues([[9, { state: 'OPEN', labels: [] }]]))).toEqual([])
    expect(planReopenedClosed([bead({ id: 'km-a', status: 'closed', external_ref: null })], map)).toEqual([])
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

describe('planMintedNonOpen', () => {
  it('flags a non-open bead whose first issue the pre-push just minted', () => {
    const pre = [bead({ id: 'km-a', status: 'closed', external_ref: null })]
    const fresh = [bead({ id: 'km-a', status: 'closed', external_ref: ref(12) })]
    expect(planMintedNonOpen(pre, fresh)).toEqual([{ id: 'km-a', number: 12 }])
  })

  it('covers every lifecycle status GitHub OPEN cannot represent', () => {
    for (const status of ['in_progress', 'blocked', 'deferred']) {
      const pre = [bead({ id: 'km-a', status, external_ref: null })]
      const fresh = [bead({ id: 'km-a', status, external_ref: ref(12) })]
      expect(planMintedNonOpen(pre, fresh)).toEqual([{ id: 'km-a', number: 12 }])
    }
  })

  it('ignores open mints, pre-existing refs, and beads new in fresh', () => {
    expect(
      planMintedNonOpen(
        [bead({ id: 'km-a', status: 'open', external_ref: null })],
        [bead({ id: 'km-a', status: 'open', external_ref: ref(12) })],
      ),
    ).toEqual([])
    expect(
      planMintedNonOpen(
        [bead({ id: 'km-a', status: 'closed', external_ref: ref(12) })],
        [bead({ id: 'km-a', status: 'closed', external_ref: ref(12) })],
      ),
    ).toEqual([])
    expect(planMintedNonOpen([], [bead({ id: 'km-a', status: 'closed', external_ref: ref(12) })])).toEqual([])
  })
})

describe('detectReverts', () => {
  const snap = bead({
    id: 'km-a',
    status: 'in_progress',
    priority: 1,
    title: 'T',
    description: 'D-new',
    assignee: 'V',
    updated_at: '2026-08-20T02:00:00Z',
  })

  it('reports a snapshot row whose issue-backed fields changed', () => {
    for (const change of [
      { status: 'open' },
      { description: 'D-old' },
      { title: 'T-old' },
      { priority: 2 },
      { issue_type: 'task' },
      { assignee: undefined },
    ] satisfies Partial<BeadRow>[]) {
      expect(detectReverts([snap], byId([{ ...snap, ...change }]))).toEqual([snap])
    }
  })

  it('stays quiet when nothing changed or the row vanished', () => {
    expect(detectReverts([snap], byId([{ ...snap }]))).toEqual([])
    expect(detectReverts([snap], byId([]))).toEqual([])
  })

  it('compares labels as a set — order-insensitive, content-sensitive', () => {
    const labelled = { ...snap, labels: ['ui', 'bug'] }
    expect(detectReverts([labelled], byId([{ ...labelled, labels: ['bug', 'ui'] }]))).toEqual([])
    expect(detectReverts([labelled], byId([{ ...labelled, labels: ['bug'] }]))).toEqual([labelled])
    expect(detectReverts([{ ...snap, labels: [] }], byId([{ ...snap, labels: ['stale'] }]))).toEqual([
      { ...snap, labels: [] },
    ])
  })
})

describe('planRestoreArgs', () => {
  it('restores an open-lifecycle row with one update carrying the status', () => {
    const row = bead({ id: 'km-a', status: 'in_progress', priority: 1, title: 'T', description: 'D', assignee: 'V', issue_type: 'bug' })
    expect(planRestoreArgs(row)).toEqual([
      ['update', 'km-a', '--title', 'T', '-d', 'D', '-p', '1', '-t', 'bug', '-a', 'V', '-s', 'in_progress'],
    ])
  })

  it('restores a closed row via close, clearing the assignee it never had', () => {
    const row = bead({ id: 'km-a', status: 'closed', priority: 2, title: 'T', description: 'D', close_reason: 'done' })
    expect(planRestoreArgs(row)).toEqual([
      ['update', 'km-a', '--title', 'T', '-d', 'D', '-p', '2', '-a', ''],
      ['close', 'km-a', '-r', 'done'],
    ])
  })

  it('replays the label delta against the post-pull row', () => {
    const row = bead({ id: 'km-a', status: 'open', priority: 2, title: 'T', description: 'D', labels: ['ui', 'keep'] })
    const post = bead({ ...row, labels: ['keep', 'stale'] })
    expect(planRestoreArgs(row, post)[0]).toEqual([
      'update', 'km-a', '--title', 'T', '-d', 'D', '-p', '2', '-a', '', '--add-label', 'ui', '--remove-label', 'stale', '-s', 'open',
    ])
  })

  it('re-adds every snapshot label when the post row is unknown (conservative path)', () => {
    const row = bead({ id: 'km-a', status: 'open', priority: 2, title: 'T', description: 'D', labels: ['ui'] })
    const [update] = planRestoreArgs(row)
    expect(update).toContain('--add-label')
    expect(update).toContain('ui')
    expect(update).not.toContain('--remove-label')
  })
})

// Process-level pins for runSync's #647 guards: the push-before-pull ordering
// and the snapshot→restore→push-back net, which unit tests on the plan
// functions cannot see. bd and gh are PATH-fronted shims; the bd shim serves
// a different `bd list` fixture per call so the post-pull list can show a
// revert. Measured ~150ms per spawn solo; budgeted for the 6x load stretch.
describe('runSync process behavior', { timeout: 20_000 }, () => {
  const script = fileURLToPath(new URL('./bd-github-sync.mjs', import.meta.url))

  const makeSyncRepo = (opts: { issues: object[]; lists: object[][]; shows?: (object[] | string)[]; failCloseId?: string }) => {
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
    const shows = opts.shows ?? []
    shows.forEach((rows, i) =>
      writeFileSync(join(repo, `show-${i + 1}.json`), typeof rows === 'string' ? rows : JSON.stringify(rows, null, 2)),
    )
    const lastShow = shows[shows.length - 1] ?? []
    writeFileSync(join(repo, 'show-last.json'), typeof lastShow === 'string' ? lastShow : JSON.stringify(lastShow, null, 2))
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
        '  show)',
        `    m=$(cat "${repo}/show-count" 2>/dev/null || echo 0)`,
        `    m=$((m+1)); echo $m > "${repo}/show-count"`,
        `    if [ -f "${repo}/show-$m.json" ]; then cat "${repo}/show-$m.json"; else cat "${repo}/show-last.json"; fi;;`,
        '  github) echo "Pushed 0 issues";;',
        ...(opts.failCloseId
          ? [`  close) if [ "$2" = "${opts.failCloseId}" ]; then echo "Error: cannot close"; else echo ok; fi;;`]
          : []),
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
    const run = (...args: string[]) => spawnSync('node', [script, ...args], { cwd: repo, env, encoding: 'utf8' })
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
      shows: [[snapshot], [revertedRow]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('restored km-t2')
    const log = shimCalls()
    expect(log).toContain('bd show km-t2 --json')
    expect(log).toContain('bd update km-t2 --title T -d D-new -p 1 -a Vlad -s in_progress')
    expect(log).toContain('bd github sync --push-only --issues km-t2')
  })

  // A half-restored row must NOT be pushed: publishing it would stamp GitHub
  // newer and bury the loss, while leaving GitHub older keeps the row a
  // suspect so the next sync retries the restore. The revert also flattens
  // priority here, so the id enters through the priority-fix leg too — the
  // exclusion must hold for the whole union, not just restoredOk.
  it('keeps a failed restore out of the push-back, including the priority-fix leg', () => {
    const closedLocal = { id: 'km-t4', status: 'closed', priority: 1, title: 'T', description: 'D', external_ref: ref(4), updated_at: '2026-08-20T02:00:00Z' }
    const revertedRow = { ...closedLocal, status: 'open', priority: 2 }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(4, '2026-08-20T01:00:00Z')],
      lists: [[closedLocal], [closedLocal], [revertedRow]],
      shows: [[{ ...closedLocal, close_reason: 'done' }], [revertedRow]],
      failCloseId: 'km-t4',
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('FAILED to restore')
    expect(shimCalls()).toContain('bd update km-t4 -p 1')
    expect(shimCalls()).not.toContain('--issues km-t4')
  })

  // Assignment rides on `bd show` rows (list rows lack the field), and an
  // unassigned snapshot must CLEAR a pulled stale assignee (-a '' does).
  it('detects and restores an assignment-only revert', () => {
    const newer = { id: 'km-t9', status: 'open', priority: 1, title: 'T', description: 'D', external_ref: ref(9), updated_at: '2026-08-20T02:00:00Z' }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(9, '2026-08-20T01:00:00Z')],
      lists: [[newer], [newer], [newer]],
      shows: [[newer], [{ ...newer, assignee: 'stale-import' }]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('restored km-t9')
    expect(shimCalls()).toContain('bd update km-t9 --title T -d D -p 1 -a  -s open')
    expect(shimCalls()).toContain('--issues km-t9')
  })

  // Same reasoning as the close-adoption abort: pulling with the snapshot
  // missing is exactly the undetectable loss the guard exists to prevent.
  it('aborts before the pull when the suspect snapshot cannot be read', () => {
    const newer = { id: 'km-t5', status: 'open', priority: 1, title: 'T', description: 'D-new', external_ref: ref(5), updated_at: '2026-08-20T02:00:00Z' }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(5, '2026-08-20T01:00:00Z')],
      lists: [[newer], [newer], [newer]],
      shows: ['Error fetching km-t5: dolt exploded'],
    })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('could not snapshot km-t5')
    expect(shimCalls()).not.toContain('bd github sync\n')
  })

  it('restores a labels-only revert via the label delta', () => {
    const newer = { id: 'km-tA', status: 'open', priority: 1, title: 'T', description: 'D', external_ref: ref(10), updated_at: '2026-08-20T02:00:00Z', labels: ['ui'] }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(10, '2026-08-20T01:00:00Z')],
      lists: [[newer], [newer], [newer]],
      shows: [[newer], [{ ...newer, labels: [] }]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('restored km-tA')
    expect(shimCalls()).toContain('--add-label ui')
    expect(shimCalls()).toContain('--issues km-tA')
  })

  // A failed post-pull read must not discard the snapshot — the DB may
  // already hold the reverted row, and the next sync's snapshot would
  // capture that, losing the newer local edit for good.
  it('conservatively restores every suspect when the post-pull read fails', () => {
    const newer = { id: 'km-tB', status: 'open', priority: 1, title: 'T', description: 'D-new', external_ref: ref(11), updated_at: '2026-08-20T02:00:00Z' }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(11, '2026-08-20T01:00:00Z')],
      lists: [[newer], [newer], [newer]],
      shows: [[newer], 'Error fetching km-tB: transient'],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('conservatively restoring')
    expect(r.stdout).toContain('restored km-tB')
    expect(shimCalls()).toContain('bd update km-tB --title T -d D-new -p 1 -a  -s open')
  })

  // Trap 3 meets the pre-push: the mint creates the issue OPEN with a fresh
  // timestamp, so the timestamp suspect test can never flag the closed bead
  // — the minted-closed plan must snapshot it or the pull loses the close.
  it('snapshots and restores a closed bead whose first issue the pre-push minted', () => {
    const preRow = { id: 'km-tC', status: 'closed', priority: 1, title: 'T', description: 'D', updated_at: '2026-08-19T00:00:00Z' }
    const minted = { ...preRow, external_ref: ref(12) }
    const revertedRow = { ...minted, status: 'open' }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z')],
      lists: [[preRow], [minted], [revertedRow]],
      shows: [[{ ...minted, close_reason: 'done' }], [revertedRow]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('restored km-tC')
    expect(shimCalls()).toContain('bd close km-tC -r done')
    expect(shimCalls()).toContain('--issues km-tC')
  })

  // The documented asymmetry, enforced: a GitHub-side reopen bumps the issue
  // timestamp, so the newer-local test cannot flag the closed bead — the
  // reopened-closed plan must snapshot it so the restore closes the bead
  // again and the push-back re-closes the issue.
  it('undoes a GitHub-side reopen of a closed bead', () => {
    const closedRow = { id: 'km-tD', status: 'closed', priority: 1, title: 'T', description: 'D', external_ref: ref(14), updated_at: '2026-08-19T00:00:00Z' }
    const revertedRow = { ...closedRow, status: 'open' }
    const { run, shimCalls } = makeSyncRepo({
      issues: [{ number: 14, state: 'OPEN', labels: [{ name: 'priority::high' }], updatedAt: '2026-08-20T05:00:00Z' }],
      lists: [[closedRow], [closedRow], [revertedRow]],
      shows: [[{ ...closedRow, close_reason: 'done' }], [revertedRow]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('restored km-tD')
    expect(shimCalls()).toContain('bd close km-tD -r done')
    expect(shimCalls()).toContain('--issues km-tD')
  })

  // bd's partial-output shape: found rows on stdout, `Error…` for the rest,
  // exit 0 — valid JSON that silently covers only some suspects.
  it('aborts when the snapshot covers only part of the suspect set', () => {
    const a = { id: 'km-t7', status: 'open', priority: 1, title: 'T', description: 'D', external_ref: ref(7), updated_at: '2026-08-20T02:00:00Z' }
    const b = { ...a, id: 'km-t8', external_ref: ref(8) }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(7, '2026-08-20T01:00:00Z'), ghIssue(8, '2026-08-20T01:00:00Z')],
      lists: [[a, b], [a, b], [a, b]],
      shows: [[a]],
    })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('could not snapshot')
    expect(shimCalls()).not.toContain('bd github sync\n')
  })

  it('stays silent under --quiet when a converged run changed nothing', () => {
    const row = { id: 'km-t6', status: 'open', priority: 1, title: 'T', description: 'D', external_ref: ref(6), updated_at: '2026-08-19T00:00:00Z' }
    const { run } = makeSyncRepo({
      issues: [ghIssue(6, '2026-08-20T00:00:00Z')],
      lists: [[row], [row], [row]],
    })
    const r = run('--quiet')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
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

  const makeRepo = (opts: { dbReady: boolean; ghIssues?: Record<number, object> }) => {
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
    for (const [n, body] of Object.entries(opts.ghIssues ?? {}))
      writeFileSync(join(repo, `gh-issue-${n}.json`), JSON.stringify(body))
    writeFileSync(
      join(shimDir, 'gh'),
      [
        '#!/bin/sh',
        `echo "gh $@" >> "${shimLog}"`,
        'if [ "$1" = "api" ]; then',
        '  n=$(basename "$2")',
        `  if [ -f "${repo}/gh-issue-$n.json" ]; then cat "${repo}/gh-issue-$n.json"; exit 0; fi`,
        '  echo \'{"message":"Not Found"}\'; exit 1',
        'fi',
        'exit 0',
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'gh'), 0o755)
    const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, BD_GITHUB_SYNC_DRY: '1' }
    const hook = (command: string) => {
      const payload = JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command } })
      return spawnSync('node', [script, '--hook-pre-pr'], { cwd: repo, env, input: payload, encoding: 'utf8' })
    }
    return { hook, repo, shimCalls: () => readFileSync(shimLog, 'utf8') }
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

  // The #N echo-gate: every issue reference in publish text gets one block
  // round showing its ground truth — a plausible-but-wrong number is only
  // catchable by putting the real title in front of the author.
  it('echoes issue references with their real titles and blocks once', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: { title: 'Real GC failure', state: 'open' } } })
    const r = hook('gh pr create --title t --body "relates to #653 and #999"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
    expect(r.stderr).toContain('#999 → NO SUCH ISSUE OR PR')
    // the nonexistent number suppresses the bypass offer for the whole round
    expect(r.stderr).not.toContain('KM_ISSUE_REFS_OK=1')
    const resolved = hook('gh pr create --title t --body "relates to #653"')
    expect(resolved.stderr).toContain('KM_ISSUE_REFS_OK=1')
  })

  it('honors KM_ISSUE_REFS_OK before any lookup (zero gh calls)', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true, ghIssues: { 653: { title: 'Real GC failure', state: 'open' } } })
    const r = hook('KM_ISSUE_REFS_OK=1 gh pr create --title t --body "relates to #653"')
    expect(r.status).toBe(0)
    expect(shimCalls()).not.toContain('gh api')
  })

  it('warns when a close keyword targets a pull request', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: { title: 'Some PR', state: 'open', pull_request: {} } } })
    const r = hook('gh pr create --title t --body "Fixes #700"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
  })

  // The mixed case: the bead deny licenses a KM_ISSUE_REFS_OK=1 re-run, so
  // any #N already in the text must be echoed in the SAME round — otherwise
  // that licence would publish unverified numbers.
  it('echoes pre-existing issue refs inside the bead-id deny round', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: { title: 'Real GC failure', state: 'open' } } })
    const r = hook('gh pr create --title t --body "tracks km-zzzz, relates to #653"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('km-zzzz')
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
  })

  // The commit leg: close keywords act when the commit reaches the default
  // branch, so they get the echo round; plain mentions and ordinary commits
  // pass with zero subprocesses.
  it('gates close-keyword refs in git commit messages', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: { title: 'Some PR', state: 'open', pull_request: {} } } })
    const r = hook('git commit -m "land the fix\n\nFixes #700"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
  })

  it('gates a close keyword behind git global options (git -C … commit)', () => {
    const { hook, repo } = makeRepo({ dbReady: true, ghIssues: { 700: { title: 'Some PR', state: 'open', pull_request: {} } } })
    const r = hook(`git -C ${repo} commit -m "Fixes #700"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
  })

  // A referenced body file the hook cannot read fails CLOSED: silently
  // skipping it would publish whatever references it holds unverified.
  it('blocks a publish whose body file cannot be resolved', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    const r = hook('cd subdir && gh pr create -F body.md')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Cannot read body file')
    expect(shimCalls()).toBe('')
  })

  // No foreign-repo shortcut: three rounds of target-parse bypasses retired
  // it. Every publish runs the gate, -R or not — including the multi-segment
  // payload where a foreign first segment used to bypass a same-repo second.
  it('gates every publish regardless of -R, including multi-segment payloads', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: { title: 'Real GC failure', state: 'open' } } })
    expect(hook('gh --repo other/repo pr comment 12 -b "relates to #653"').status).toBe(2)
    const multi = hook('gh -R owner/other issue comment 1 -b ok; gh pr create -b "relates to #653"')
    expect(multi.status).toBe(2)
    expect(multi.stderr).toContain('Real GC failure')
  })

  // A quoted -R value is blanked by the skeleton; if that read as a foreign
  // target the gate would switch itself off (round-10 regression shape).
  it('still gates a publish whose same-repo -R value is quoted', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: { title: 'Real GC failure', state: 'open' } } })
    const r = hook('gh -R "Stvad/knowledge-medium" pr comment 12 -b "relates to #653"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Real GC failure')
  })

  it('fails closed on an expansion-built body', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    const r = hook('gh pr comment 1 --body "$(cat body.md)"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('shell expansion')
    expect(shimCalls()).toBe('')
  })

  it('fails closed on a pipe-fed stdin body but lets heredoc stdin through', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: { title: 'Real GC failure', state: 'open' } } })
    const piped = hook('cat body.md | gh pr comment 12 -F -')
    expect(piped.status).toBe(2)
    expect(piped.stderr).toContain('stdin')
    // quoting the sentinel blanked it in the skeleton and bypassed the rule
    const quoted = hook('cat body.md | gh pr comment 12 -F "-"')
    expect(quoted.status).toBe(2)
    expect(quoted.stderr).toContain('stdin')
    // /dev/stdin is stdin in disguise: reading it in the hook scans the
    // hook's own drained stream while gh publishes the piped file
    const device = hook('cat body.md | gh pr comment 12 -F /dev/stdin')
    expect(device.status).toBe(2)
    expect(device.stderr).toContain('stdin')
    const heredoc = hook('gh pr comment 12 -F - <<EOF\nrelates to #653\nEOF')
    expect(heredoc.status).toBe(2)
    expect(heredoc.stderr).toContain('Real GC failure')
  })

  // The command's addressee is not published text: a positional target URL
  // must not cost a confirmation round, while the same URL inside a quoted
  // body is publication text and still verifies.
  it('ignores positional target URLs but verifies URLs inside bodies', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true, ghIssues: { 653: { title: 'Real GC failure', state: 'open' } } })
    const target = hook(`gh pr comment https://github.com/Stvad/knowledge-medium/pull/653 --body "looks good"`)
    expect(target.status).toBe(0)
    expect(shimCalls()).not.toContain('gh api')
    const inBody = hook(`gh pr comment 12 --body "see https://github.com/Stvad/knowledge-medium/issues/653"`)
    expect(inBody.status).toBe(2)
    expect(inBody.stderr).toContain('Real GC failure')
    // quoted prose that merely RESEMBLES a positional target keeps its refs:
    // the strip applies only when the skeleton confirms an unquoted target
    const prose = hook(`gh pr comment 12 --body "instruction: pr comment https://github.com/Stvad/knowledge-medium/issues/653"`)
    expect(prose.status).toBe(2)
    expect(prose.stderr).toContain('Real GC failure')
    // even a FULL gh-command spelled out in prose keeps its ref: the strip
    // runs only when the skeleton confirms an unquoted positional target
    const fullProse = hook(`gh pr comment 12 --body "run: gh pr comment https://github.com/Stvad/knowledge-medium/issues/653 --body ok"`)
    expect(fullProse.status).toBe(2)
    expect(fullProse.stderr).toContain('Real GC failure')
  })

  // --recover republishes cached input from a failed create — content the
  // hook never saw; same fail-closed family as stdin pipes and expansions.
  it('fails closed on recovered publication input', () => {
    const { hook } = makeRepo({ dbReady: true })
    const r = hook('gh pr create --recover abc123 --title t')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('recovered input')
  })

  it('scans file-backed commit messages (-F) for close keywords', () => {
    const { hook, repo } = makeRepo({ dbReady: true, ghIssues: { 700: { title: 'Some PR', state: 'open', pull_request: {} } } })
    writeFileSync(join(repo, 'msg.txt'), 'land the fix\n\nFixes #700\n')
    const r = hook(`git commit -F ${join(repo, 'msg.txt')}`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
  })

  it('lets plain-mention and escaped commits pass with zero lookups', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true, ghIssues: { 653: { title: 'Real GC failure', state: 'open' } } })
    expect(hook('git commit -m "see #653 for context"').status).toBe(0)
    expect(hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"').status).toBe(0)
    expect(shimCalls()).not.toContain('gh api')
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
