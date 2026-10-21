// Removes, in one commit, every pr-preview/pr-<n>/ on gh-pages whose PR is no
// longer open or has been idle (no update) for PR_PREVIEW_IDLE_DAYS days, first
// rewriting each idle PR's preview-link comment to say how to redeploy. Run by
// .github/workflows/remove-pr-previews.yml on PR close and on a schedule; extra
// arguments name PRs to remove even while open.
//
//   GITHUB_REPOSITORY=owner/repo [PR_PREVIEW_IDLE_DAYS=30] node scripts/sweep-pr-previews.ts [pr-number ...]
//
// Works from any clone whose `origin` can push gh-pages: it fetches only the
// branch tip and builds the commit through a scratch index, so the full site
// is never checked out.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePrNumber } from './approved-pr-preview.ts'
import { isMainModule } from './is-main-module.mjs'

const BRANCH = 'gh-pages'
const REMOTE_REF = `refs/remotes/origin/${BRANCH}`
const PREVIEW_ROOT = 'pr-preview'
const PREVIEW_DIR = /^pr-([1-9][0-9]*)$/
const PUSH_ATTEMPTS = 5
const DEFAULT_IDLE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
// The hidden header marocchino/sticky-pull-request-comment finds the preview comment by.
const PREVIEW_COMMENT_MARKER = '<!-- Sticky Pull Request Commentpr-preview -->'
const PREVIEW_COMMENT_AUTHOR = 'github-actions[bot]'

export type Git = (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => string
export type Gh = (args: string[]) => string

/** `updatedAt` is GitHub's: comments, reviews and edits bump it as well as pushes. */
export type OpenPr = { number: number; updatedAt: Date }

export const gitIn = (cwd: string): Git => (args, opts = {}) =>
  execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...opts.env },
  }).trim()

/**
 * The pr-<n> directory names to remove: the PR is not open, is named in
 * `alsoRemove`, or was last updated before `idleBefore`. Only that last kind is
 * `expired`, since its PR stays open. Any other name is never touched.
 */
export function previewsToRemove<P extends OpenPr>(names: string[], open: readonly P[], { idleBefore, alsoRemove }: {
  idleBefore: Date
  alsoRemove: readonly number[]
}): { removed: string[]; expired: P[] } {
  const byNumber = new Map(open.map(pr => [pr.number, pr]))
  const removed: string[] = []
  const expired: P[] = []
  for (const name of names) {
    const match = PREVIEW_DIR.exec(name)
    if (match === null) continue
    const number = Number(match[1])
    const pr = byNumber.get(number)
    if (pr === undefined || alsoRemove.includes(number)) {
      removed.push(name)
    } else if (pr.updatedAt < idleBefore) {
      removed.push(name)
      expired.push(pr)
    }
  }
  return { removed, expired }
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

function marked<P extends OpenPr>(markExpired: (pr: P) => void, pr: P): boolean {
  try {
    markExpired(pr)
    return true
  } catch (error) {
    console.warn(`could not mark PR ${pr.number}'s preview expired; keeping it for a later run:`, error)
    return false
  }
}

/**
 * Never force-pushes: a deploy that lands mid-sweep rejects the push, and the
 * sweep starts over from the new tip so that deploy survives. `openPrs` is read
 * after each fetch, so every preview in the fetched tip was deployed while its
 * PR was open and still counts as open, and as active, unless that read says
 * otherwise.
 *
 * `markExpired` runs before the push, so a preview whose notice failed stays
 * up (`unmarked`) for a later run to retry, and a failure never leaves a live
 * link pointing at a removed preview. A notice from a rejected attempt can
 * name a PR the retry then keeps; accepted, since a redeploy rewrites the
 * comment once it is published.
 */
export function sweepPreviews<P extends OpenPr>({ git, openPrs, idleBefore, alsoRemove = [], markExpired = () => {} }: {
  git: Git
  openPrs: () => readonly P[]
  idleBefore: Date
  alsoRemove?: number[]
  markExpired?: (pr: P) => void
}): { removed: string[]; expired: P[]; unmarked: P[] } {
  for (let attempt = 1; ; attempt++) {
    // Not blobless: that needs partial-clone config, and every later step would lazily fetch what it touches.
    git(['fetch', '--quiet', '--depth', '1', 'origin', `+refs/heads/${BRANCH}:${REMOTE_REF}`])
    const tip = git(['rev-parse', REMOTE_REF])
    const open = openPrs()
    const names = git(['ls-tree', '-d', '--name-only', tip, `${PREVIEW_ROOT}/`])
      .split('\n').filter(Boolean).map(path => path.slice(PREVIEW_ROOT.length + 1))
    const found = previewsToRemove(names, open, { idleBefore, alsoRemove })
    const unmarked = found.expired.filter(pr => !marked(markExpired, pr))
    const result = {
      removed: found.removed.filter(name => !unmarked.some(pr => name === `pr-${pr.number}`)),
      expired: found.expired.filter(pr => !unmarked.includes(pr)),
      unmarked,
    }
    if (result.removed.length === 0) return result
    const commit = commitWithout(git, tip, result.removed)
    try {
      git(['push', '--quiet', 'origin', `${commit}:refs/heads/${BRANCH}`])
      return result
    } catch (error) {
      if (attempt === PUSH_ATTEMPTS) throw error
      console.warn(`push to ${BRANCH} rejected (attempt ${attempt}/${PUSH_ATTEMPTS}); rebuilding on the new tip`)
    }
  }
}

function expiredPreviewComment(number: number, repository: string, idleDays: number): string {
  const headSha = `"$(gh pr view ${number} --repo ${repository} --json headRefOid --jq .headRefOid)"`
  return [
    '### PR preview expired',
    `This PR had no activity for ${idleDays} days, so its preview was removed to keep the Pages site small.`,
    'A push to a same-repository PR brings it back. To redeploy the current head without one:',
    [
      '```sh',
      `gh workflow run approved-pr-preview.yml --repo ${repository} --ref master -f pr_number=${number} -f head_sha=${headSha}`,
      '```',
    ].join('\n'),
    PREVIEW_COMMENT_MARKER,
  ].join('\n\n')
}

/**
 * Rewrites the PR's preview-link comment in place, keeping the marker so the
 * next deploy updates it rather than adding another. Editing notifies nobody,
 * which a new comment on every expired PR would.
 */
export function markPreviewExpired(gh: Gh, repository: string, number: number, idleDays: number): boolean {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/issues/${number}/comments?per_page=100`])) as
    { id: number; user: { login: string } | null; body?: string }[][]
  const comment = pages.flat().find(c => c.user?.login === PREVIEW_COMMENT_AUTHOR && c.body?.includes(PREVIEW_COMMENT_MARKER))
  if (comment === undefined) return false
  gh(['api', '--method', 'PATCH', `repos/${repository}/issues/comments/${comment.id}`,
    '-f', `body=${expiredPreviewComment(number, repository, idleDays)}`])
  return true
}

// A PR opening or closing between pages can shift another past the page boundary;
// accepted while the open PRs fit on one page.
function openPullRequests(gh: Gh, repository: string): OpenPr[] {
  const out = gh(['api', '--paginate', `repos/${repository}/pulls?state=open&per_page=100`,
    '--jq', '.[] | [.number, .updated_at] | @tsv'])
  return out.split('\n').filter(Boolean).map(line => {
    const [number, updatedAt] = line.split('\t')
    return { number: Number(number), updatedAt: new Date(updatedAt) }
  })
}

function idleDaysFromEnv(): number {
  const value = process.env.PR_PREVIEW_IDLE_DAYS || String(DEFAULT_IDLE_DAYS)
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error('PR_PREVIEW_IDLE_DAYS must be a positive whole number of days')
  return Number(value)
}

if (isMainModule(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('set GITHUB_REPOSITORY (owner/repo)')
  const idleDays = idleDaysFromEnv()
  const alsoRemove = process.argv.slice(2).map(parsePrNumber)
  const gh: Gh = args => execFileSync('gh', args, { encoding: 'utf8' })
  const { removed, unmarked } = sweepPreviews({
    git: gitIn(process.cwd()), openPrs: () => openPullRequests(gh, repository),
    idleBefore: new Date(Date.now() - idleDays * DAY_MS), alsoRemove,
    markExpired: pr => {
      if (!markPreviewExpired(gh, repository, pr.number, idleDays)) console.log(`PR ${pr.number} has no preview comment to update`)
    },
  })
  console.log(removed.length > 0 ? `Removed ${removed.length} previews: ${removed.join(', ')}` : 'No stale previews.')
  if (unmarked.length > 0) process.exitCode = 1
}
