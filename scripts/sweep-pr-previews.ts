// Removes every pr-preview/pr-<n>/ on gh-pages whose PR is no longer open, in one
// commit. Run by .github/workflows/remove-pr-previews.yml on PR close and on a
// schedule; extra arguments name PRs to remove even while open.
//
//   GITHUB_REPOSITORY=owner/repo node scripts/sweep-pr-previews.ts [pr-number ...]
//
// Works from any clone whose `origin` can push gh-pages: it fetches only the
// branch tip and builds the commit through a scratch index, so the multi-GB
// site is never checked out.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePrNumber } from './approved-pr-preview.ts'
import { isMainModule } from './is-main-module.mjs'

const PREVIEW_ROOT = 'pr-preview'
const PREVIEW_DIR = /^pr-([1-9][0-9]*)$/
const PUSH_ATTEMPTS = 5

export type Git = (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => string

export const gitIn = (cwd: string, env: NodeJS.ProcessEnv = {}): Git => (args, opts = {}) =>
  execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, ...opts.env },
  }).trim()

/** The pr-<n> directory names whose PR is not in `keep`; any other name is never touched. */
export function stalePreviewDirs(names: string[], keep: ReadonlySet<number>): string[] {
  return names.filter(name => {
    const match = PREVIEW_DIR.exec(name)
    return match !== null && !keep.has(Number(match[1]))
  })
}

function commitWithout(git: Git, tip: string, dirs: string[]): string {
  const scratch = mkdtempSync(join(tmpdir(), 'sweep-pr-previews-'))
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') }
    git(['read-tree', tip], { env })
    git(['rm', '-r', '--cached', '--quiet', '--', ...dirs.map(dir => `${PREVIEW_ROOT}/${dir}`)], { env })
    const tree = git(['write-tree'], { env })
    return git(['commit-tree', tree, '-p', tip, '-m', `Remove ${dirs.length} stale PR previews\n\n${dirs.join(', ')}`])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Never force-pushes: a deploy that lands mid-sweep rejects the push, and the
 * sweep starts over from the new tip so that deploy survives.
 */
export function sweepPreviews({ git, branch, openPrs, alsoRemove = [] }: {
  git: Git
  branch: string
  openPrs: ReadonlySet<number>
  alsoRemove?: number[]
}): { removed: string[] } {
  const keep = new Set([...openPrs].filter(number => !alsoRemove.includes(number)))
  const remoteRef = `refs/remotes/origin/${branch}`
  for (let attempt = 1; ; attempt++) {
    git(['fetch', '--quiet', '--depth', '1', 'origin', `+refs/heads/${branch}:${remoteRef}`])
    const tip = git(['rev-parse', remoteRef])
    const names = git(['ls-tree', '-d', '--name-only', tip, `${PREVIEW_ROOT}/`])
      .split('\n').filter(Boolean).map(path => path.slice(PREVIEW_ROOT.length + 1))
    const removed = stalePreviewDirs(names, keep)
    if (removed.length === 0) return { removed }
    const commit = commitWithout(git, tip, removed)
    try {
      git(['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`])
      return { removed }
    } catch (error) {
      if (attempt === PUSH_ATTEMPTS) throw error
      console.warn(`push to ${branch} rejected (attempt ${attempt}/${PUSH_ATTEMPTS}); rebuilding on the new tip`)
    }
  }
}

function openPullRequests(repository: string): Set<number> {
  const out = execFileSync('gh', ['api', '--paginate', `repos/${repository}/pulls?state=open&per_page=100`, '--jq', '.[].number'], {
    encoding: 'utf8',
  })
  return new Set(out.split('\n').filter(Boolean).map(Number))
}

if (isMainModule(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('set GITHUB_REPOSITORY (owner/repo)')
  const alsoRemove = process.argv.slice(2).map(parsePrNumber)
  const { removed } = sweepPreviews({
    git: gitIn(process.cwd()), branch: 'gh-pages', openPrs: openPullRequests(repository), alsoRemove,
  })
  console.log(removed.length > 0 ? `Removed ${removed.length} previews: ${removed.join(', ')}` : 'No stale previews.')
}
