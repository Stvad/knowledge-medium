import { describe, expect, it } from 'vitest'
import {
  bodyFilePaths,
  buildDenyMessage,
  deriveLabelPriority,
  extractBeadIds,
  issueNumberFromRef,
  matchesPrCommand,
  planClosePushes,
  planCloseReconciliation,
  planPriorityFixes,
  type BeadRow,
  type IssueInfo,
} from './bd-github-sync.mjs'

const issues = (entries: [number, IssueInfo][]) => new Map<number, IssueInfo>(entries)
const bead = (over: Partial<BeadRow>): BeadRow => ({
  id: 'km-x',
  status: 'open',
  priority: 2,
  external_ref: 'https://github.com/Stvad/knowledge-medium/issues/1',
  ...over,
})

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
    'gh issue comment 34 --body-file /tmp/c.md',
  ])('matches publishing command: %s', cmd => {
    expect(matchesPrCommand(cmd)).toBe(true)
  })

  it.each(['gh pr view 12', 'gh pr list', 'gh issue list', 'git commit -m "gh pr createish"', 'echo hello'])(
    'ignores non-publishing command: %s',
    cmd => {
      expect(matchesPrCommand(cmd)).toBe(false)
    },
  )
})

describe('bodyFilePaths', () => {
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
  it('parses the trailing issue number', () => {
    expect(issueNumberFromRef('https://github.com/Stvad/knowledge-medium/issues/600')).toBe(600)
  })
  it('returns null for absent or non-issue refs', () => {
    expect(issueNumberFromRef(null)).toBeNull()
    expect(issueNumberFromRef('https://github.com/Stvad/knowledge-medium/pull/600')).toBeNull()
  })
})

describe('planCloseReconciliation', () => {
  it('closes only non-closed beads whose GitHub issue is closed', () => {
    const plan = planCloseReconciliation(
      [
        bead({ id: 'km-a', external_ref: 'https://x/issues/1' }),
        bead({ id: 'km-b', status: 'in_progress', external_ref: 'https://x/issues/2' }),
        bead({ id: 'km-c', status: 'closed', external_ref: 'https://x/issues/3' }),
        bead({ id: 'km-d', external_ref: null }),
        bead({ id: 'km-e', external_ref: 'https://x/issues/5' }),
      ],
      issues([
        [1, { state: 'CLOSED', labels: [] }],
        [2, { state: 'CLOSED', labels: [] }],
        [3, { state: 'CLOSED', labels: [] }],
        [5, { state: 'OPEN', labels: [] }],
      ]),
    )
    expect(plan).toEqual([
      { id: 'km-a', number: 1 },
      { id: 'km-b', number: 2 },
    ])
  })
})

describe('planPriorityFixes', () => {
  it('re-derives only beads at the flattened default whose label disagrees', () => {
    const plan = planPriorityFixes(
      [
        bead({ id: 'km-flat', external_ref: 'https://x/issues/1' }), // P2 + label P1 → fix
        bead({ id: 'km-agrees', external_ref: 'https://x/issues/2' }), // P2 + label P2 → leave
        bead({ id: 'km-deliberate', priority: 1, external_ref: 'https://x/issues/3' }), // not flattened → leave
        bead({ id: 'km-nolabel', external_ref: 'https://x/issues/4' }),
        bead({ id: 'km-noissue', external_ref: null }),
      ],
      issues([
        [1, { state: 'OPEN', labels: ['P1'] }],
        [2, { state: 'OPEN', labels: ['P2'] }],
        [3, { state: 'OPEN', labels: ['P4'] }],
        [4, { state: 'OPEN', labels: ['bug'] }],
      ]),
    )
    expect(plan).toEqual([{ id: 'km-flat', to: 1 }])
  })
})

describe('planClosePushes', () => {
  it('pushes closes for closed beads whose issue is open — or absent from the pre-sync map', () => {
    const plan = planClosePushes(
      [
        bead({ id: 'km-a', status: 'closed', external_ref: 'https://x/issues/1' }), // open issue → push
        bead({ id: 'km-b', status: 'closed', external_ref: 'https://x/issues/2' }), // closed issue → converged
        bead({ id: 'km-c', status: 'closed', external_ref: 'https://x/issues/3' }), // minted during this run → push
        bead({ id: 'km-d', status: 'closed', external_ref: null }), // never synced → nothing to push to
        bead({ id: 'km-e', status: 'open', external_ref: 'https://x/issues/5' }), // not closed → not ours
      ],
      issues([
        [1, { state: 'OPEN', labels: [] }],
        [2, { state: 'CLOSED', labels: [] }],
        [5, { state: 'OPEN', labels: [] }],
      ]),
    )
    expect(plan).toEqual([
      { id: 'km-a', number: 1 },
      { id: 'km-c', number: 3 },
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
