import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type Gh, type Git, gitIn, markPreviewExpired, type OpenPr, stalePreviewDirs, sweepPreviews,
} from './sweep-pr-previews.ts'

const git = (cwd: string, ...args: string[]) => gitIn(cwd)(args)

function commitFiles(repo: string, files: Record<string, string>, remove: string[] = []) {
  for (const path of remove) git(repo, 'rm', '-r', '--quiet', path)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), content)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '--quiet', '-m', 'publish')
  git(repo, 'push', '--quiet', 'origin', 'gh-pages')
}

// One seeded origin + publisher + sweeper trio, copied per test. Remotes are
// relative so each copy talks to its own origin.
let root: string
let template: string
let caseCount = 0
let origin: string
let publisher: string
let work: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'sweep-pr-previews-'))
  template = join(root, 'template')
  git(root, 'init', '--quiet', '--bare', '--initial-branch', 'gh-pages', join(template, 'origin.git'))
  for (const repo of ['publisher', 'work']) {
    git(root, 'init', '--quiet', '--initial-branch', 'gh-pages', join(template, repo))
    git(join(template, repo), 'remote', 'add', 'origin', '../origin.git')
    git(join(template, repo), 'config', 'user.name', 'test')
    git(join(template, repo), 'config', 'user.email', 'test@example.invalid')
  }
  commitFiles(join(template, 'publisher'), {
    'index.html': 'production',
    '.nojekyll': '',
    'pr-preview/pr-1/index.html': 'closed',
    'pr-preview/pr-2/index.html': 'open',
    'pr-preview/pr-3/.nojekyll': '',
    'pr-preview/README.md': 'not a preview',
  })
})

beforeEach(() => {
  const dir = join(root, `case-${++caseCount}`)
  cpSync(template, dir, { recursive: true })
  origin = join(dir, 'origin.git')
  publisher = join(dir, 'publisher')
  work = join(dir, 'work')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

const publish = (files: Record<string, string>, remove: string[] = []) => commitFiles(publisher, files, remove)
const publishedFiles = () => git(origin, 'ls-tree', '-r', '--name-only', 'gh-pages').split('\n')
const tip = () => git(origin, 'rev-parse', 'gh-pages')

const workGit = (): Git => gitIn(work)

const idleBefore = new Date('2026-09-21T00:00:00Z')
const openPr = (number: number, updatedAt: string): OpenPr => ({ number, updatedAt: new Date(updatedAt) })
const active = (number: number) => openPr(number, '2026-10-20T00:00:00Z')
const idle = (number: number) => openPr(number, '2026-09-01T00:00:00Z')

const sweep = (options: Omit<Parameters<typeof sweepPreviews>[0], 'git' | 'idleBefore'> & { git?: Git }) =>
  sweepPreviews({ git: workGit(), idleBefore, ...options })

describe('stalePreviewDirs', () => {
  it('names only pr-<n> directories whose PR is not kept', () => {
    expect(stalePreviewDirs(['pr-1', 'pr-2', 'pr-03', 'pr-x', 'shared'], new Set([2]))).toEqual(['pr-1'])
  })
})

// Each case runs a handful of real git processes (~300ms alone).
describe('sweepPreviews', { timeout: 20_000 }, () => {
  it('removes closed previews in one fast-forward commit and leaves everything else', () => {
    const before = tip()
    const result = sweep({ openPrs: () => [active(2)] })

    expect(result.removed).toEqual(['pr-1', 'pr-3'])
    expect(publishedFiles()).toEqual(['.nojekyll', 'index.html', 'pr-preview/README.md', 'pr-preview/pr-2/index.html'])
    expect(git(origin, 'rev-parse', 'gh-pages^')).toBe(before)
  })

  it('pushes nothing when no preview is stale', () => {
    const before = tip()
    const result = sweep({ openPrs: () => [active(1), active(2), active(3)] })

    expect(result.removed).toEqual([])
    expect(tip()).toBe(before)
  })

  it('also removes explicitly named PRs, open or not, without reporting them expired', () => {
    const result = sweep({ openPrs: () => [active(1), idle(2), active(3)], alsoRemove: [2] })

    expect(result.expired).toEqual([])

    expect(publishedFiles()).toEqual([
      '.nojekyll', 'index.html', 'pr-preview/README.md', 'pr-preview/pr-1/index.html', 'pr-preview/pr-3/.nojekyll',
    ])
  })

  it('expires previews of idle open PRs and reports every idle PR left without one', () => {
    const result = sweep({ openPrs: () => [active(2), idle(3), idle(7)] })

    expect(result).toEqual({ removed: ['pr-1', 'pr-3'], expired: [idle(3), idle(7)] })
    expect(publishedFiles()).toEqual(['.nojekyll', 'index.html', 'pr-preview/README.md', 'pr-preview/pr-2/index.html'])
  })

  // A PR that becomes active mid-sweep (opened, or pushed to after idling) and
  // deploys: its preview must survive, so open PRs have to be read after the
  // fetch that first sees the deploy.
  function deployingMidSweep(at: 'fetch' | 'push', number: number, open: OpenPr[]) {
    const inner = workGit()
    let raced = false
    const git: Git = (args, opts) => {
      if (args[0] === at && !raced) {
        raced = true
        open = [...open.filter(pr => pr.number !== number), active(number)]
        publish({ [`pr-preview/pr-${number}/index.html`]: 'deployed mid-sweep', 'index.html': 'production v2' })
      }
      return inner(args, opts)
    }
    return { git, openPrs: () => open }
  }

  it('reads open PRs after fetching, so a preview deployed just before the fetch is kept', () => {
    const result = sweep(deployingMidSweep('fetch', 4, [active(2)]))

    expect(result.removed).toEqual(['pr-1', 'pr-3'])
    expect(publishedFiles()).toContain('pr-preview/pr-4/index.html')
  })

  it('rebuilds on the new tip when a deploy lands mid-sweep, keeping that deploy', () => {
    const result = sweep(deployingMidSweep('push', 4, [active(2)]))

    expect(result.removed).toEqual(['pr-1', 'pr-3'])
    expect(publishedFiles()).toEqual([
      '.nojekyll', 'index.html', 'pr-preview/README.md', 'pr-preview/pr-2/index.html', 'pr-preview/pr-4/index.html',
    ])
    expect(git(origin, 'show', 'gh-pages:index.html')).toBe('production v2')
  })

  it('keeps an idle PR whose redeploy lands mid-sweep, and does not report it expired', () => {
    const result = sweep(deployingMidSweep('push', 3, [active(2), idle(3)]))

    expect(result).toEqual({ removed: ['pr-1'], expired: [] })
    expect(git(origin, 'show', 'gh-pages:pr-preview/pr-3/index.html')).toBe('deployed mid-sweep')
  })

  it('treats a branch with no pr-preview directory as nothing to sweep', () => {
    publish({}, ['pr-preview'])
    const before = tip()

    expect(sweep({ openPrs: () => [] }).removed).toEqual([])
    expect(tip()).toBe(before)
  })
})

describe('markPreviewExpired', () => {
  const marker = '<!-- Sticky Pull Request Commentpr-preview -->'
  const bot = { login: 'github-actions[bot]' }

  function fakeGh(comments: object[]) {
    const patches: string[][] = []
    const gh: Gh = args => {
      if (args.includes('PATCH')) {
        patches.push(args)
        return '{}'
      }
      return JSON.stringify([comments])
    }
    const body = () => patches[0]?.find(arg => arg.startsWith('body='))
    return { gh, patches, body }
  }

  it("rewrites only the bot's preview comment, keeping its marker so the next deploy reuses it", () => {
    const { gh, patches, body } = fakeGh([
      { id: 10, user: { login: 'someone' }, body: `quoting ${marker}` },
      { id: 11, user: bot, body: 'another bot comment' },
      { id: 12, user: bot, body: `View preview\n${marker}` },
    ])

    expect(markPreviewExpired(gh, 'o/r', 5, 30)).toBe(true)
    expect(patches).toHaveLength(1)
    expect(patches[0]).toContain('repos/o/r/issues/comments/12')
    expect(body()).toContain(marker)
    // Instructions that depend on the PR's base or head would go stale as the PR changes; the docs hold them.
    expect(body()).toContain('docs/pr-preview-deployments.md#redeploying-an-expired-preview')
  })

  it('edits nothing when the PR has no preview comment', () => {
    const { gh, patches } = fakeGh([{ id: 11, user: bot, body: 'another bot comment' }])

    expect(markPreviewExpired(gh, 'o/r', 5, 30)).toBe(false)
    expect(patches).toEqual([])
  })

  // marocchino skips a minimized comment and posts a fresh one, so a PR can carry several.
  it('rewrites every preview comment that does not already say it expired, newest first', () => {
    const expiredBody = () => {
      const probe = fakeGh([{ id: 1, user: bot, body: marker }])
      markPreviewExpired(probe.gh, 'o/r', 5, 30)
      return probe.body()!.slice('body='.length)
    }
    const { gh, patches } = fakeGh([
      { id: 12, user: bot, body: `View preview\n${marker}` },
      { id: 13, user: bot, body: expiredBody() },
      { id: 14, user: bot, body: `View preview\n${marker}` },
    ])

    expect(markPreviewExpired(gh, 'o/r', 5, 30)).toBe(true)
    expect(patches.map(args => args.find(arg => arg.includes('/comments/')))).toEqual([
      'repos/o/r/issues/comments/14', 'repos/o/r/issues/comments/12',
    ])
  })

  // Every run re-notifies every expired PR, so an edit that already landed must not be repeated.
  it('edits nothing when the comment already says the preview expired', () => {
    const first = fakeGh([{ id: 12, user: bot, body: marker }])
    markPreviewExpired(first.gh, 'o/r', 5, 30)
    const again = fakeGh([{ id: 12, user: bot, body: first.body()!.slice('body='.length) }])

    expect(markPreviewExpired(again.gh, 'o/r', 5, 30)).toBe(false)
    expect(again.patches).toEqual([])
  })
})
