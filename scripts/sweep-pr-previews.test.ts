import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type Git, gitIn, stalePreviewDirs, sweepPreviews } from './sweep-pr-previews.ts'

const identity = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
}
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: { ...process.env, ...identity }, encoding: 'utf8' }).trim()

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

const workGit = (): Git => gitIn(work, identity)

describe('stalePreviewDirs', () => {
  it('names only pr-<n> directories whose PR is not kept', () => {
    expect(stalePreviewDirs(['pr-1', 'pr-2', 'pr-03', 'pr-x', 'shared'], new Set([2]))).toEqual(['pr-1'])
  })
})

// Each case runs a handful of real git processes (~300ms alone).
describe('sweepPreviews', { timeout: 20_000 }, () => {
  it('removes closed previews in one fast-forward commit and leaves everything else', () => {
    const before = tip()
    const result = sweepPreviews({ git: workGit(), branch: 'gh-pages', openPrs: () => new Set([2]) })

    expect(result.removed).toEqual(['pr-1', 'pr-3'])
    expect(publishedFiles()).toEqual(['.nojekyll', 'index.html', 'pr-preview/README.md', 'pr-preview/pr-2/index.html'])
    expect(git(origin, 'rev-parse', 'gh-pages^')).toBe(before)
  })

  it('pushes nothing when no preview is stale', () => {
    const before = tip()
    const result = sweepPreviews({ git: workGit(), branch: 'gh-pages', openPrs: () => new Set([1, 2, 3]) })

    expect(result.removed).toEqual([])
    expect(tip()).toBe(before)
  })

  it('also removes explicitly named PRs, open or not', () => {
    sweepPreviews({ git: workGit(), branch: 'gh-pages', openPrs: () => new Set([1, 2, 3]), alsoRemove: [2] })

    expect(publishedFiles()).toEqual([
      '.nojekyll', 'index.html', 'pr-preview/README.md', 'pr-preview/pr-1/index.html', 'pr-preview/pr-3/.nojekyll',
    ])
  })

  // A PR that opens mid-sweep and deploys: its preview must survive, so the open
  // set has to be read after the fetch that first sees the preview.
  function openingMidSweep(at: 'fetch' | 'push') {
    const open = new Set([2])
    const inner = workGit()
    let raced = false
    const git: Git = (args, opts) => {
      if (args[0] === at && !raced) {
        raced = true
        open.add(4)
        publish({ 'pr-preview/pr-4/index.html': 'new open PR', 'index.html': 'production v2' })
      }
      return inner(args, opts)
    }
    return { git, openPrs: () => new Set(open) }
  }

  it('reads open PRs after fetching, so a preview deployed just before the fetch is kept', () => {
    const result = sweepPreviews({ ...openingMidSweep('fetch'), branch: 'gh-pages' })

    expect(result.removed).toEqual(['pr-1', 'pr-3'])
    expect(publishedFiles()).toContain('pr-preview/pr-4/index.html')
  })

  it('rebuilds on the new tip when a deploy lands mid-sweep, keeping that deploy', () => {
    const result = sweepPreviews({ ...openingMidSweep('push'), branch: 'gh-pages' })

    expect(result.removed).toEqual(['pr-1', 'pr-3'])
    expect(publishedFiles()).toEqual([
      '.nojekyll', 'index.html', 'pr-preview/README.md', 'pr-preview/pr-2/index.html', 'pr-preview/pr-4/index.html',
    ])
    expect(git(origin, 'show', 'gh-pages:index.html')).toBe('production v2')
  })

  it('treats a branch with no pr-preview directory as nothing to sweep', () => {
    publish({}, ['pr-preview'])
    const before = tip()

    expect(sweepPreviews({ git: workGit(), branch: 'gh-pages', openPrs: () => new Set() }).removed).toEqual([])
    expect(tip()).toBe(before)
  })
})
