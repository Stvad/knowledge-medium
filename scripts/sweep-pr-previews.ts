// Removes, in one commit, every pr-preview/pr-<n>/ on gh-pages whose PR is no
// longer open or has been idle (no update) for PR_PREVIEW_IDLE_DAYS days, then
// rewrites the preview-link comment of each open PR left without one that way
// to say how to redeploy. Run by .github/workflows/remove-pr-previews.yml on PR
// close and on a schedule; extra arguments name PRs to remove even while open.
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
// The hidden header marocchino/sticky-pull-request-comment finds the preview comment by: what
// `header: pr-preview` in the preview workflows, and rossjrw's own comment step, write.
const PREVIEW_COMMENT_MARKER = '<!-- Sticky Pull Request Commentpr-preview -->'
const PREVIEW_COMMENT_AUTHOR = 'github-actions[bot]'
const EXPIRED_HEADING = '### PR preview expired'

export type Git = (args: string[], opts?: { env?: NodeJS.ProcessEnv }) => string
export type Gh = (args: string[]) => string

/** `updatedAt` is GitHub's: comments, reviews and edits bump it as well as pushes. */
export type OpenPr = { number: number; updatedAt: Date; fork: boolean; base: string }
type NoticeTarget = Pick<OpenPr, 'number' | 'fork' | 'base'>

export const gitIn = (cwd: string): Git => (args, opts = {}) =>
  execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...opts.env },
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
 * sweep starts over from the new tip so that deploy survives. `openPrs` is read
 * after each fetch, so every preview in the fetched tip was deployed while its
 * PR was open and still counts as open, and as active, unless that read says
 * otherwise.
 *
 * Write expiry notices only after this returns: a notice bumps the PR's
 * `updatedAt`, which would read as activity on a retry. A redeploy of
 * byte-identical content moves no tip, so one that lands between this read
 * and the push is still swept; accepted, since only a maintainer redeploying
 * an unchanged head in those seconds meets it.
 */
export function sweepPreviews({ git, openPrs, idleBefore, alsoRemove = [] }: {
  git: Git
  openPrs: () => readonly OpenPr[]
  idleBefore: Date
  alsoRemove?: number[]
}): { removed: string[]; expired: OpenPr[] } {
  for (let attempt = 1; ; attempt++) {
    // Not blobless: that needs partial-clone config, and every later step would lazily fetch what it touches.
    git(['fetch', '--quiet', '--depth', '1', 'origin', `+refs/heads/${BRANCH}:${REMOTE_REF}`])
    const tip = git(['rev-parse', REMOTE_REF])
    const open = openPrs().filter(pr => !alsoRemove.includes(pr.number))
    // Every idle PR, not only those this run removes, so a notice that failed is retried.
    const expired = open.filter(pr => pr.updatedAt < idleBefore)
    const names = git(['ls-tree', '-d', '--name-only', tip, `${PREVIEW_ROOT}/`])
      .split('\n').filter(Boolean).map(path => path.slice(PREVIEW_ROOT.length + 1))
    const removed = stalePreviewDirs(names, new Set(open.filter(pr => !expired.includes(pr)).map(pr => pr.number)))
    const result = { removed, expired }
    if (removed.length === 0) return result
    const commit = commitWithout(git, tip, removed)
    try {
      git(['push', '--quiet', 'origin', `${commit}:refs/heads/${BRANCH}`])
      return result
    } catch (error) {
      if (attempt === PUSH_ATTEMPTS) throw error
      console.warn(`push to ${BRANCH} rejected (attempt ${attempt}/${PUSH_ATTEMPTS}); rebuilding on the new tip`)
    }
  }
}

function redeployInstructions({ number, fork, base }: NoticeTarget, repository: string): string[] {
  const push = 'A push brings it back once the PR has no merge conflict.'
  // The approval flow refuses a PR that does not target master, and a fork push never deploys.
  if (base !== 'master') return [fork ? 'A maintainer can approve a reviewed head to bring it back once the PR targets master.' : push]
  const command = (headSha: string) => [
    '```sh',
    `gh workflow run approved-pr-preview.yml --repo ${repository} --ref master -f pr_number=${number} -f head_sha=${headSha}`,
    '```',
  ].join('\n')
  // Approving a fork is approving one reviewed commit, so its command must not fill in whatever the head is now.
  if (fork) return ['A maintainer can approve a reviewed head to bring it back:', command('<reviewed head SHA>')]
  return [`${push} To redeploy the current head without one:`,
    command(`"$(gh pr view ${number} --repo ${repository} --json headRefOid --jq .headRefOid)"`)]
}

function expiredPreviewComment(pr: NoticeTarget, repository: string, idleDays: number): string {
  return [
    EXPIRED_HEADING,
    `This PR had no activity for ${idleDays} days, so its preview was removed to keep the Pages site small.`,
    ...redeployInstructions(pr, repository),
    PREVIEW_COMMENT_MARKER,
  ].join('\n\n')
}

/**
 * Rewrites the PR's preview-link comments in place, skipping any that already
 * say the preview expired, and keeps the marker so the next deploy updates
 * them rather than adding another. Editing notifies nobody, which a new
 * comment on every expired PR would.
 *
 * There can be several, because marocchino skips a minimized comment and posts
 * a fresh one, so every older one is hidden. The newest goes first: the first
 * edit bumps `updatedAt` and ends the PR's retries, so a failure after it can
 * only leave a hidden comment stale.
 */
export function markPreviewExpired(gh: Gh, repository: string, pr: NoticeTarget, idleDays: number): boolean {
  const pages = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/issues/${pr.number}/comments?per_page=100`])) as
    { id: number; user: { login: string } | null; body?: string }[][]
  const stale = pages.flat().filter(c =>
    c.user?.login === PREVIEW_COMMENT_AUTHOR && c.body?.includes(PREVIEW_COMMENT_MARKER) && !c.body.startsWith(EXPIRED_HEADING))
  for (const comment of stale.reverse()) {
    gh(['api', '--method', 'PATCH', `repos/${repository}/issues/comments/${comment.id}`,
      '-f', `body=${expiredPreviewComment(pr, repository, idleDays)}`])
  }
  return stale.length > 0
}

/** One `number, updated_at, head repository, base branch` line per PR; a deleted head repository is empty, so a fork. */
export function parseOpenPulls(tsv: string, repository: string): OpenPr[] {
  return tsv.split('\n').filter(Boolean).map(line => {
    const [number, updatedAt, headRepository, base] = line.split('\t')
    return { number: Number(number), updatedAt: new Date(updatedAt), fork: headRepository !== repository, base }
  })
}

// A PR opening or closing between pages can shift another past the page boundary;
// accepted while the open PRs fit on one page.
function openPullRequests(gh: Gh, repository: string): OpenPr[] {
  return parseOpenPulls(gh(['api', '--paginate', `repos/${repository}/pulls?state=open&per_page=100`,
    '--jq', '.[] | [.number, .updated_at, .head.repo.full_name // "", .base.ref] | @tsv']), repository)
}

function idleWindowFromEnv(): { idleDays: number; idleBefore: Date } {
  const value = process.env.PR_PREVIEW_IDLE_DAYS || String(DEFAULT_IDLE_DAYS)
  const idleBefore = new Date(Date.now() - Number(value) * DAY_MS)
  // An out-of-range day count makes an Invalid Date, which no `<` matches, so expiry would silently stop.
  if (!/^[1-9][0-9]*$/.test(value) || Number.isNaN(idleBefore.getTime())) {
    throw new Error('PR_PREVIEW_IDLE_DAYS must be a positive whole number of days')
  }
  return { idleDays: Number(value), idleBefore }
}

// A workflow command ends at the first newline, so the cause is encoded onto one line.
const workflowCommandData = (text: string) => text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

if (isMainModule(import.meta.url)) {
  const repository = process.env.GITHUB_REPOSITORY
  if (!repository) throw new Error('set GITHUB_REPOSITORY (owner/repo)')
  const { idleDays, idleBefore } = idleWindowFromEnv()
  const alsoRemove = process.argv.slice(2).map(parsePrNumber)
  const gh: Gh = args => execFileSync('gh', args, { encoding: 'utf8' })
  const { removed, expired } = sweepPreviews({
    git: gitIn(process.cwd()), openPrs: () => openPullRequests(gh, repository),
    idleBefore, alsoRemove,
  })
  console.log(removed.length > 0 ? `Removed ${removed.length} previews: ${removed.join(', ')}` : 'No stale previews.')
  // A failure only warns, since a failing exit would skip the workflow's own comment
  // cleanup; the next run retries it for as long as the PR stays idle.
  for (const pr of expired) {
    try {
      if (markPreviewExpired(gh, repository, pr, idleDays)) console.log(`Marked PR ${pr.number}'s preview expired`)
    } catch (error) {
      const cause = (error as { stderr?: string }).stderr?.trim() || String(error)
      console.log(`::warning::${workflowCommandData(`Could not mark PR ${pr.number}'s preview expired: ${cause}`)}`)
    }
  }
}
