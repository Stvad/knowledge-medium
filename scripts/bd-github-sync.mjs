#!/usr/bin/env node
/**
 * beads↔GitHub sync with the documented traps guarded (AGENTS.md beads
 * section; memory reference_bd_github_sync_close_ordering):
 *
 * 1. A GitHub-side close (hand-close or a merged "Fixes #N") is CLOBBERED by
 *    the next sync — the still-open bead pushes over it and re-opens the
 *    issue. So GitHub-side closes are adopted into beads BEFORE syncing, and
 *    a failure to read or adopt ABORTS the run: proceeding with a partial
 *    view is exactly the clobber this step exists to prevent.
 * 2. A pull flattens bead priority to P2 when the issue lacks a priority::*
 *    machine label. Flattening is detected by comparing each bead's priority
 *    BEFORE and AFTER the sync (≠2 → 2 means this run's pull did it) and
 *    restoring the pre-sync value — never by guessing from labels, which
 *    would fight a deliberate P2. Only beads NEW this run (no pre-sync row)
 *    fall back to label derivation, since for them the label is the only
 *    signal.
 * 3. A bead closed BEFORE its first sync stays closed locally but its issue is
 *    minted OPEN. So after syncing, closed beads whose issue is open get the
 *    issue closed via gh — NOT via a selective bd push, which applies the
 *    last_sync watermark and silently skips any bead updated before it
 *    (observed live: a day-old close never pushed). gh-closing is safe in
 *    exactly this direction because the bead is already closed: the states
 *    agree afterwards, so the next sync has nothing to revert.
 *    Note the deliberate asymmetry with (1): GitHub-side CLOSES are adopted
 *    (they come from PR merges), GitHub-side REOPENS do not stick (beads is
 *    the source of truth; reopen the bead instead).
 * 4. The pull applies a strictly OLDER GitHub copy over newer local rows —
 *    text edits, claims and closes alike — despite the documented
 *    prefer-newer default (#647; measured live). Guarded twice: local state
 *    is pushed out BEFORE the pull (after close-adoption, so an un-adopted
 *    open bead cannot re-open its issue), and beads whose local row is still
 *    newer than their GitHub copy — the push watermark skips older edits —
 *    are snapshotted before the pull and restored + re-pushed if it reverted
 *    them.
 *
 * Accepted race: an issue closed on GitHub DURING the sync window can be
 * re-opened by the in-flight push, and because the reopen is then the state
 * every later fetch sees, no later run re-adopts the close. Inherent to a
 * push-based mirror; close the bead instead if it happens.
 *
 * Modes:
 *   node scripts/bd-github-sync.mjs               # full sync (manual / SessionEnd)
 *   node scripts/bd-github-sync.mjs --quiet       # only report when something changed
 *   node scripts/bd-github-sync.mjs --dry-run     # print plans, mutate nothing
 *   node scripts/bd-github-sync.mjs --hook-pre-pr # Claude Code PreToolUse(Bash) hook:
 *       fast-exits unless the command PUBLISHES text on GitHub (gh pr
 *       create/edit/comment/review/merge, gh issue create/edit/comment/close,
 *       gh release create/edit, gh api graphql mutations — matched only where
 *       gh is in command position, so a commit message MENTIONING these does
 *       not trip it). Published text is verified after publication by
 *       bd-publish-verify.mjs (PostToolUse), which reads the GitHub object
 *       back and can repair it — so this gate scans the raw command string
 *       and deliberately does NOT chase stdin/expansion/--recover bodies;
 *       its parsing surface is FROZEN (#672 — decline coverage findings
 *       here). Bead ids (km-…) BLOCK (exit 2) with the km→#N substitution
 *       table, minting issues for unmapped beads first — the number should
 *       be in hand BEFORE the text ships. The #N echo-gate (and body-file
 *       reading) remains pre-publish ONLY where the verifier cannot reach:
 *       gh pr merge (merge-commit text), gh pr review (its output names no
 *       URL), graphql mutations (response envelope unresolvable), --silent
 *       api mutations (fail closed — no output at all), and git commit
 *       close keywords (commit text never becomes a GitHub object). The
 *       commit leg runs INDEPENDENTLY of the publish legs — one invocation
 *       can do both.
 *       Unrepairable-verb text built by shell expansion fails closed (the
 *       one guard restored from the pre-shrink gate — no post-hoc read
 *       exists for it). ACCEPTED residuals of this leg, declined as
 *       channel-enumeration (round 5 of review; the decision record is the
 *       tracker): api mutations whose --jq/--template output omits html_url
 *       go unverified, and a refs-approved --silent mutation's @file/--input
 *       payload is not read for bead ids.
 *       Escape hatches: KM_ALLOW_BEAD_IDS=1 / KM_ISSUE_REFS_OK=1 prefixes.
 *       The FULL sync does not run here: converged it still costs ~60s (a GET
 *       compare per issue), which is too slow to sit in front of every PR.
 *       SessionEnd and manual runs carry it.
 *       BD_GITHUB_SYNC_DRY=1 in the ENVIRONMENT suppresses the mint — the
 *       valve every pipe-test of the hook uses.
 *
 * Every path no-ops silently when bd, the beads DB, or a gh token is missing
 * (cloud sessions) — and no bd command runs before the DB's existence is
 * confirmed, because the FIRST bd command in a fresh clone creates an empty
 * DB that then refuses to pull. The hook's bead-id block still fires without
 * a DB: an unmappable reference is worth blocking even where the sync can't
 * run.
 *
 * bd prints `Error:` and exits 0, sometimes on stderr — failure is detected
 * from both streams, never from the exit code alone.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = 'Stvad/knowledge-medium'

// ---------------------------------------------------------------------------
// Pure logic (unit-tested in bd-github-sync.test.ts)
// ---------------------------------------------------------------------------

export const BEAD_ID = /(?<![\w-])km-[a-z0-9]+(?:-[a-z0-9]+)*(?![\w-])/g

/** Unique bead ids referenced in a blob of text, in first-seen order. */
export const extractBeadIds = text => [...new Set(text.match(BEAD_ID) ?? [])]

// gh must sit in COMMAND position — matching it anywhere in the text lets a
// commit message that merely mentions "gh pr comment" trip the gate and mint
// issues as a side effect of a local command. Position alone is not enough:
// quoted prose can contain `;`/newlines that fake a segment start, so the
// positional regexes run against a SKELETON of the command with quoted spans
// removed. ONE left-to-right pass decides span ownership — the shell's rule
// for balanced input; sequential per-quote passes let an apostrophe inside
// one double-quoted arg pair with one in a later arg and swallow a genuine
// publish between them. Single-quoted text never executes and is dropped;
// command substitutions DO execute, even inside double quotes, so their
// bodies are lifted out as segments of their own; double-quoted remainders
// blank. Heredoc bodies are left in place — an ACCEPTED false-positive
// surface: a heredoc line that starts with a publish verb fakes command
// position and blocks, and the escape hatch covers it; parsing heredocs is
// more surface than this guard warrants. (Commands arrive from the Bash
// tool, so quotes are balanced; this is a guard, not a shell parser.)
const commandSkeleton = cmd => {
  const lifted = []
  const liftSubstitutions = span => {
    for (const m of span.matchAll(/\$\(([^)]*)\)/g)) lifted.push(m[1])
    for (const m of span.matchAll(/`([^`]*)`/g)) lifted.push(m[1])
  }
  const skeleton = cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\$\(([^)]*)\)|`([^`]*)`/g, (m, dollarBody, tickBody) => {
    if (dollarBody !== undefined) {
      lifted.push(dollarBody)
      return '$()'
    }
    if (tickBody !== undefined) {
      lifted.push(tickBody)
      return '``'
    }
    if (m.startsWith('"')) {
      liftSubstitutions(m)
      return '""'
    }
    return "''"
  })
  return [skeleton, ...lifted].join('\n')
}

// A command position opens at the string start, after a separator, or after
// one of the shell's control keywords — a FINITE set, unlike wrapper
// commands, so listing it is complete rather than an enumeration.
const SEGMENT_START = String.raw`(?:^|[;&|({]\s*|\b(?:if|then|elif|else|do|until|while)\s+)`
// VAR=val assignments and common wrapper commands may precede the real verb;
// wrappers take options of their own (env -u NAME, xargs -0), skipped with
// the value-optional branch that harmlessly over-matches.
const COMMAND_PREFIXES = String.raw`(?:(?:command|env|nohup|time|xargs)\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*|[A-Za-z_]\w*=\S*\s+)*`
// Global options (-R/--repo, --hostname) may sit between `gh` and the
// subcommand, same shape as git's (the value-optional branch over-matches
// harmlessly).
const GH_GLOBAL_OPTS = String.raw`(?:-\S+\s+(?:[^-\s]\S*\s+)?)*`
const GH_PUBLISH = new RegExp(
  SEGMENT_START +
    COMMAND_PREFIXES +
    String.raw`(?:\S*\/)?gh\s+` +
    GH_GLOBAL_OPTS +
    String.raw`(?:pr\s+(?:create|new|edit|comment|review|merge|close|reopen)|issue\s+(?:create|new|edit|comment|close|reopen)|release\s+(?:create|new|edit))\b`,
  'm',
)

/** Does this shell command publish PR/issue/release text on GitHub? */
export const matchesPrCommand = cmd => GH_PUBLISH.test(commandSkeleton(cmd))

// `gh api` mutations (explicit -X/--method POST|PATCH|PUT, or field/input
// flags, which make gh default to POST) — the channel review replies actually
// go out through, which the publish matcher above cannot see. No endpoint
// filter: the post-publish verifier's URL extraction is the real filter, and
// a mutation aimed at a text-free endpoint just yields no target. Plain GETs
// stay out so the verifier does not fetch-and-echo after every read.
const GH_API = new RegExp(
  SEGMENT_START + COMMAND_PREFIXES + String.raw`(?:\S*\/)?gh\s+` + GH_GLOBAL_OPTS + String.raw`api\s`,
  'm',
)
export const matchesApiPublish = cmd => {
  const sk = commandSkeleton(cmd)
  if (!GH_API.test(sk)) return false
  return (
    /(?<![\w-])(?:-X|--method)(?:=|\s+)?(?:POST|PATCH|PUT)\b/i.test(sk) ||
    /(?<![\w-])(?:--raw-field|--field|--input)(?:=|\s)/.test(sk) ||
    // field short flags accept ATTACHED key=value forms: -fbody=…, -Fbody=…
    /(?<![\w-])-[fF](?:=|\s|[A-Za-z_])/.test(sk)
  )
}

/**
 * Which target kinds this command's CLI publish verbs can have produced.
 * Bounds the post-publish verifier's surface: the Bash tool merges the whole
 * invocation's output, so a compound command can print URLs of objects it
 * never touched — a kind no verb here produces must not even be fetched.
 * (gh api mutations are not consulted: their output names the exact object.)
 */
export const publishableKinds = cmd => {
  const sk = commandSkeleton(cmd)
  const kinds = new Set()
  if (/\bpr\s+(?:create|new|edit|merge)\b/.test(sk)) kinds.add('pr')
  if (/\bpr\s+(?:close|reopen)\b/.test(sk)) kinds.add('pr').add('comment')
  if (/\bissue\s+(?:create|new|edit)\b/.test(sk)) kinds.add('issue')
  if (/\bissue\s+(?:close|reopen)\b/.test(sk)) kinds.add('issue').add('comment')
  if (/\b(?:pr|issue)\s+comment\b/.test(sk)) kinds.add('comment')
  if (/\bpr\s+review\b/.test(sk)) kinds.add('review').add('review-comment')
  if (/\brelease\s+(?:create|new|edit)\b/.test(sk)) kinds.add('release')
  return kinds
}

// Commit messages become public and their close keywords act when the commit
// reaches the default branch, so `git commit` gets the narrow leg of the
// reference gate: close-keyword refs only, scanned from the raw command
// (the message lives inside quotes the skeleton blanks). Plain mentions and
// ordinary commits pass untouched — zero subprocesses.
// Git global options (-C <path>, -c k=v, --git-dir=…) may sit between `git`
// and the subcommand; the value-optional branch over-matches harmlessly —
// a false positive only costs a zero-subprocess keyword scan.
const GIT_COMMIT = new RegExp(
  SEGMENT_START + COMMAND_PREFIXES + String.raw`(?:\S*\/)?git\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*commit\b`,
  'm',
)
export const matchesCommitCommand = cmd => GIT_COMMIT.test(commandSkeleton(cmd))

// There is deliberately NO foreign-repo (-R/--repo) shortcut: three review
// rounds each found a way to make its target parse lie (quoted values,
// expansions, multi-segment payloads), and every miss switched the gate OFF.
// A publish aimed at another repo simply runs the gate against this repo's
// issue space — its refs come back not-found and the escape hatch covers the
// (essentially unused) case. A never-exercised convenience is not worth a
// recurring bypass surface.

// Publishes post-publication repair cannot reach, which therefore keep the
// pre-publish #N echo-gate (and body-file reading): `gh pr merge` text lands
// in the merge commit, and review/close/reopen output names `repo#N`, never
// a URL the verifier could find the review or -c comment by. Comment-less
// closes pass for free — no refs in the command text, nothing to echo.
const GH_UNREPAIRABLE = new RegExp(
  SEGMENT_START +
    COMMAND_PREFIXES +
    String.raw`(?:\S*\/)?gh\s+` +
    GH_GLOBAL_OPTS +
    String.raw`(?:pr\s+(?:merge|review|close|reopen)|issue\s+(?:close|reopen))\b`,
  'm',
)
export const matchesUnrepairableCommand = cmd => GH_UNREPAIRABLE.test(commandSkeleton(cmd))

// GraphQL mutations publish through a response envelope the verifier cannot
// safely resolve (requested body fields quote foreign URLs), so their text
// is checked pre-publish, from the raw command — inline queries sit in it
// whole; a query=@file body is an accepted residual. The \bmutation\b test
// runs on the RAW text (the query is quoted, so the skeleton blanks it);
// prose containing the word costs one echo round, covered by the escape.
export const matchesGraphqlMutation = cmd =>
  matchesApiPublish(cmd) && /\bgraphql\b/.test(commandSkeleton(cmd)) && /\bmutation\b/.test(cmd)

// A body built by shell expansion cannot be inspected before it publishes —
// and for the unrepairable verbs there is no after, so those keep this
// fail-closed check (restored from the pre-shrink gate, where it was
// review-hardened; the shrink deleted it on a rationale that is exactly
// wrong for this class). Single-quoted values never expand and stay out.
// The separator is optional (the CLI accepts ATTACHED short-option values:
// -t"$(…)", -tfoo), and the value is matched as a full shell WORD — quoted
// and unquoted segments concatenated (prefix"$(cat x)") form ONE argument.
export const hasDynamicBody = cmd => {
  for (const m of cmd.matchAll(
    /(?<![\w-])(?:--body|--notes|--subject|--title|--comment|-[bntc])(?:=|\s+)?((?:"[^"]*"|'[^']*'|[^\s'"])+)/g,
  )) {
    if (/[$`]/.test(m[1].replace(/'[^']*'/g, ''))) return true
  }
  return false
}

// The escape hatch must also be in command-prefix position of the SKELETON —
// honored from quoted prose, a PR body QUOTING it would both bypass the gate
// and publish the marker.
const ALLOW_MARKER = new RegExp(SEGMENT_START + COMMAND_PREFIXES + String.raw`KM_ALLOW_BEAD_IDS=1\s`, 'm')
export const allowsBeadIds = cmd => ALLOW_MARKER.test(commandSkeleton(cmd))

// GitHub-style issue references in publishable text. Guessed numbers are the
// top hallucination since the #N-not-bead-id policy: a wrong number usually
// RESOLVES to a real, unrelated issue and reads as correct to every reviewer,
// so each reference is echoed back with its actual title once (exit 2) and
// the re-run confirms with KM_ISSUE_REFS_OK=1. The lookbehind kills HTML
// entities (&#39;) and glued word chars; the lookahead kills hex colors.
// Capped at 5 digits: 6-digit all-numeric tokens are far more likely CSS hex
// colors (#123456, #000000) than issue numbers in a repo three orders of
// magnitude away from #100000. A 3-digit shorthand color (#123) stays
// ambiguous and costs one confirm round — accepted.
const ISSUE_MENTION = /(?<![&\w#])#(\d{1,5})(?!\w)/g
// GitHub's qualified closing forms for THIS repo — `owner/repo#N` and full
// issue/PR URLs — normalize to #N so both extractors see them; qualified
// refs into foreign repos stay out (they cannot be verified in our issue
// space and our close keywords cannot act on them from here anyway).
const QUALIFIED_REF = new RegExp(
  String.raw`(?:https?:\/\/)?github\.com\/${REPO.replace('/', '\\/')}\/(?:issues|pull)\/(\d{1,5})\b|` +
    String.raw`(?<![\w\/])${REPO.replace('/', '\\/')}#(\d{1,5})(?!\w)`,
  'gi',
)
const normalizeQualifiedRefs = text => text.replace(QUALIFIED_REF, (_, a, b) => `#${a ?? b}`)
export const extractIssueRefs = text =>
  [...new Set([...normalizeQualifiedRefs(text).matchAll(ISSUE_MENTION)].map(m => Number(m[1])))]

// GitHub's auto-close keywords: a wrong number here CLOSES an unrelated
// issue on merge, so these references get the loudest warnings.
const CLOSE_KEYWORD = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?):?\s+#(\d{1,5})(?!\w)/gi
export const closeKeywordRefs = text =>
  [...new Set([...normalizeQualifiedRefs(text).matchAll(CLOSE_KEYWORD)].map(m => Number(m[1])))]

const ISSUE_REFS_OK = new RegExp(SEGMENT_START + COMMAND_PREFIXES + String.raw`KM_ISSUE_REFS_OK=1\s`, 'm')
export const allowsIssueRefs = cmd => ISSUE_REFS_OK.test(commandSkeleton(cmd))

/**
 * The echo table: one line of ground truth per referenced number, warnings
 * on the shapes that are wrong regardless of intent. `refs` is
 * [{number, info}] where info is {title, state, isPr} | 'not-found' | null
 * (null = the lookup itself failed).
 */
export const buildIssueRefsMessage = (refs, closeNums, mode = 'pre') => {
  const lines = refs.map(({ number, info }) => {
    if (info === 'not-found') return `  #${number} → NO SUCH ISSUE OR PR — a guessed number?`
    if (!info) return `  #${number} → COULD NOT VERIFY (gh lookup failed)`
    const kind = info.isPr ? 'PULL REQUEST' : 'issue'
    const warns = [
      ...(closeNums.has(number) && info.isPr ? ['⚠ close keyword targets a PR'] : []),
      ...(closeNums.has(number) && !info.isPr && info.state !== 'open' ? ['⚠ close keyword on an already-closed issue'] : []),
    ]
    return `  #${number} → "${info.title}" (${kind}, ${info.state})${warns.length ? ` ${warns.join(' ')}` : ''}`
  })
  // The bypass footer appears only when every reference resolved to a real
  // title: advertising it over a failed lookup or a nonexistent number would
  // invite bypassing a reference no one has read.
  const anyUnresolved = refs.some(({ info }) => info === null || info === 'not-found')
  const footer =
    mode === 'post'
      ? anyUnresolved
        ? 'Some references could not be verified — a number that does not resolve in PUBLISHED text is almost certainly a guess; fix the published body now.'
        : 'This text is already published — if any reference above is not the one you meant, fix it now (gh pr edit / gh issue edit / gh api PATCH).'
      : anyUnresolved
        ? 'Some references could not be verified (failed lookups or nonexistent numbers) — fix them and re-run; do not bypass unverified references.'
        : 'If every reference above is the one you mean, re-run with KM_ISSUE_REFS_OK=1 prefixed.'
  return [
    mode === 'post'
      ? 'Issue references in the published text — check each against the issue you meant:'
      : 'Issue-reference check — verify each number against its real title before publishing:',
    ...lines,
    footer,
    'If the numbers are wrong, fix them first: `bd show <bead-id>` → External:, or `gh issue list --search "<words>"`. Never write a number you have not read this session.',
  ].join('\n')
}

/**
 * Message/body-file values on the legs that still read files pre-publish
 * (git commit -F/--file, gh pr merge/review -F/--body-file — text the
 * post-publication verifier can never see). A real flag sits OUTSIDE quotes,
 * so it must survive into the skeleton — a quoted mention ("use -F x next
 * time") is prose, and with the fail-closed missing-file check a prose
 * mention would block the command outright. Values are still extracted from
 * the raw text (quoted paths are blanked in the skeleton). Not full shell
 * parsing.
 */
const messageFileValues = cmd => {
  if (!/(?<![\w-])(?:--body-file|--file|-F)/.test(commandSkeleton(cmd))) return []
  return [...cmd.matchAll(/(?<![\w-])(?:--body-file|--file|-F)(?:=|\s+)?("[^"]*"|'[^']*'|[^\s'"]+)/g)].map(m =>
    m[1].replace(/^(["'])(.*)\1$/, '$2'),
  )
}

// Stdin in disguise: the hook reading these would consume its OWN stdin (an
// empty, already-drained stream), not what the shell pipes in. Classified
// from the RAW values — a quoted sentinel (-F "-") is blanked in the
// skeleton, and missing it means the hook scans nothing while the pipe
// carries the text.
const STDIN_PATH = /^(?:-|\/dev\/stdin|\/dev\/fd\/\d+|\/proc\/self\/fd\/\d+)$/
export const bodyFilePaths = cmd => messageFileValues(cmd).filter(p => !STDIN_PATH.test(p))
export const hasStdinBody = cmd => messageFileValues(cmd).some(p => STDIN_PATH.test(p))

/** Resolve a body-file path the way the shell would have: ~, then cwd. */
export const resolveBodyPath = (p, cwd, home) =>
  p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : isAbsolute(p) ? p : resolve(cwd, p)

/**
 * Priority 0–4 from GitHub label names. The machine label (`priority::high`,
 * upstream's PriorityMapping vocabulary) wins over the hand label (`P1`).
 * Only consulted for beads that did not exist before this run — see header.
 */
const PRIORITY_WORDS = { critical: 0, high: 1, medium: 2, low: 3, none: 4 }
export const deriveLabelPriority = labels => {
  for (const name of labels) {
    const m = name.match(/^priority::(\w+)$/i)
    if (m && m[1].toLowerCase() in PRIORITY_WORDS) return PRIORITY_WORDS[m[1].toLowerCase()]
  }
  for (const name of labels) {
    const m = name.match(/^[pP]([0-4])$/)
    if (m) return Number(m[1])
  }
  return null
}

// Pinned to THIS repo: an external_ref pointing anywhere else (another repo's
// issue, a PR URL) must never contribute an issue number here — a number
// collision would close the wrong public issue.
const ISSUE_REF = new RegExp(`^https://github\\.com/${REPO}/issues/(\\d+)$`)
export const issueNumberFromRef = ref => {
  const m = ISSUE_REF.exec(ref ?? '')
  return m ? Number(m[1]) : null
}

/** Non-closed beads (open/in_progress/blocked/deferred) whose issue is closed. */
export const planCloseReconciliation = (beads, issueByNumber) =>
  beads
    .filter(b => b.status !== 'closed')
    .map(b => ({ id: b.id, number: issueNumberFromRef(b.external_ref) }))
    .filter(({ number }) => number !== null && issueByNumber.get(number)?.state === 'CLOSED')

/**
 * Closed beads whose GitHub issue is still open. An issue absent from the map
 * counts as open only when its number is BEYOND the highest fetched one — the
 * map predates the sync, so the canonical case (an issue minted DURING this
 * run for an already-closed bead) is above that line; an absent number below
 * it means the issue was deleted or transferred and must not be gh-closed.
 */
export const planClosePushes = (beads, issueByNumber, maxKnownIssueNumber) =>
  beads
    .filter(b => b.status === 'closed')
    .map(b => ({ id: b.id, number: issueNumberFromRef(b.external_ref) }))
    .filter(({ number }) => {
      if (number === null) return false
      const known = issueByNumber.get(number)
      return known ? known.state === 'OPEN' : number > maxKnownIssueNumber
    })

/**
 * Beads to un-flatten after a sync. A bead that WAS ≠2 before this run and is
 * 2 after was flattened by this run's pull → restore its pre-sync value. A
 * bead new this run at 2 takes the label-derived value if one exists. A bead
 * already at 2 before the run is untouched — 2 may be deliberate.
 */
// Beads whose FIRST issue this run minted: external_ref appearing between two
// listings. A row ABSENT from the pre listing counts too: no pull runs
// between the two listings at either call site, so a fresh-only row is a
// concurrent local creation (worktrees share the DB) whose issue this push
// may still have minted — excluding it loses the mapping forever, while
// including it costs at most a redundant line or snapshot suspect.
export const planMintedRefs = (preBeads, postBeads) => {
  const preRefs = new Map(preBeads.map(b => [b.id, b.external_ref ?? null]))
  return postBeads.flatMap(b => {
    const number = issueNumberFromRef(b.external_ref)
    return number !== null && (preRefs.get(b.id) ?? null) === null ? [{ id: b.id, number }] : []
  })
}

// Beads in any non-open status whose FIRST issue the pre-pull push just
// minted: the mint creates the issue OPEN with a fresh timestamp, so the
// timestamp-based suspect test above can never flag them, yet the pull can
// apply that OPEN copy over the local lifecycle state — closes (trap 3's
// population, re-exposed by pushing before the pull), claims, blocks and
// deferrals alike.
export const planMintedNonOpen = (preBeads, freshBeads) => {
  const nonOpen = new Set(freshBeads.filter(b => b.status !== 'open').map(b => b.id))
  return planMintedRefs(preBeads, freshBeads).filter(m => nonOpen.has(m.id))
}

// Closed beads whose linked issue is OPEN after close-adoption ran: that is a
// GitHub-side REOPEN, which per the documented asymmetry must not stick —
// beads is the source of truth; reopen the bead instead. The reopen bumps the
// issue timestamp, so the newer-local test below structurally cannot flag
// these; snapshotting them lets the restore + push-back undo the reopen on
// both sides.
export const planReopenedClosed = (beads, issueByNumber) =>
  beads.flatMap(b => {
    const number = issueNumberFromRef(b.external_ref)
    const issue = number === null ? undefined : issueByNumber.get(number)
    return b.status === 'closed' && issue?.state === 'OPEN' ? [{ id: b.id, number }] : []
  })

// Beads whose local row is strictly newer than their GitHub copy. bd's pull
// applies GitHub state over these despite the documented prefer-newer default
// (#647), so they are exactly the rows a pull can revert. Missing timestamps
// on either side mean "cannot claim local is newer" — not a suspect.
export const planLocalWins = (beads, issueByNumber) =>
  beads.flatMap(b => {
    const number = issueNumberFromRef(b.external_ref)
    const issue = number === null ? undefined : issueByNumber.get(number)
    if (!issue?.updatedAt || !b.updated_at) return []
    return Date.parse(b.updated_at) > Date.parse(issue.updatedAt) ? [{ id: b.id, number }] : []
  })

// Both sides of the comparison are `bd show` rows (list rows lack assignee),
// so assignment-only reverts are visible too; the restore replays the full
// snapshot, close reason included. Together with the set-compared labels,
// this covers every field the pull writes (the issue-backed set) — fields
// GitHub issues don't carry (notes, design, estimates, deps) cannot be
// pull-reverted and are deliberately absent.
const REVERT_FIELDS = ['title', 'description', 'status', 'priority', 'issue_type', 'assignee']
const labelKey = row => [...(row.labels ?? [])].sort().join('\n')
export const detectReverts = (snapshotRows, postById) =>
  snapshotRows.filter(s => {
    const post = postById.get(s.id)
    return post && (REVERT_FIELDS.some(f => (s[f] ?? null) !== (post[f] ?? null)) || labelKey(s) !== labelKey(post))
  })

// A closed bead cannot be restored by `bd update -s closed` alone: close is
// its own verb and carries the reason. Everything else is one update.
// `post` is the row's post-pull state, used only to compute the label delta;
// without it (the conservative path) every snapshot label is re-added —
// duplicate adds are idempotent — and none removed.
export const planRestoreArgs = (row, post) => {
  const update = ['update', row.id, '--title', row.title ?? '', '-d', row.description ?? '', '-p', String(row.priority)]
  if (row.issue_type) update.push('-t', row.issue_type)
  // Always passed: `-a ''` CLEARS the assignee (verified against bd 1.2.2),
  // so an unassigned snapshot can undo a pulled stale assignment.
  update.push('-a', row.assignee ?? '')
  const snapLabels = new Set(row.labels ?? [])
  const postLabels = new Set(post?.labels ?? [])
  for (const l of snapLabels) if (!postLabels.has(l)) update.push('--add-label', l)
  for (const l of postLabels) if (!snapLabels.has(l)) update.push('--remove-label', l)
  if (row.status === 'closed')
    return [update, ['close', row.id, '-r', row.close_reason || 'restored by bd-github-sync after a pull revert (#647)']]
  return [[...update, '-s', row.status]]
}

export const planPriorityFixes = (preById, postBeads, issueByNumber) =>
  postBeads
    .filter(b => b.status !== 'closed' && b.priority === 2)
    .map(b => {
      const pre = preById.get(b.id)
      if (pre) return { id: b.id, to: pre.priority !== 2 ? pre.priority : null }
      const issue = issueByNumber.get(issueNumberFromRef(b.external_ref))
      return { id: b.id, to: issue ? deriveLabelPriority(issue.labels) : null }
    })
    .filter(({ to }) => to !== null && to !== 2)

export const buildDenyMessage = (mapped, unmapped) => {
  const lines = [
    'BLOCKED: this text references bead ids (km-…), which GitHub readers cannot resolve.',
    'Reference the GitHub issue numbers instead:',
    ...mapped.map(({ id, number }) => `  ${id} → #${number} (https://github.com/${REPO}/issues/${number})`),
    ...(unmapped.length
      ? [
          `No GitHub issue found for: ${unmapped.join(', ')} — check \`bd show <id>\`. A real bead may have been skipped by the sync watermark (edit it to bump updated_at, then retry); if the sync could not run here, find the issue via \`gh issue list --search\`.`,
        ]
      : []),
    'Rewrite the references as #N and re-run with KM_ISSUE_REFS_OK=1 prefixed — these numbers come from the tracker, so the issue-reference check needs no separate confirmation.',
    'Close keywords ("Fixes #N") are the right pattern: when the PR merges and GitHub closes #N, the next sync\'s reconcile step closes the bead to match. Do not hand-close either side before the merge.',
    'If the bead id mention is deliberate (not an issue reference), re-run with KM_ALLOW_BEAD_IDS=1 prefixed.',
  ]
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Process plumbing
// ---------------------------------------------------------------------------

const run = (file, args, opts = {}) => {
  const r = spawnSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  if (r.error) throw r.error
  const combined = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  if (r.status !== 0) throw new Error(`${file} ${args[0]} exited ${r.status}: ${combined.trim().slice(0, 500)}`)
  // bd reports failures as `Error…` with exit 0 — on either stream.
  if (file === 'bd' && /^Error/m.test(combined)) throw new Error(`bd ${args[0]}: ${combined.trim().slice(0, 500)}`)
  return r.stdout ?? ''
}

export const tryRun = (file, args, opts) => {
  try {
    return run(file, args, opts)
  } catch {
    return null
  }
}

/**
 * Multi-id `bd show`, parsed from stdout DIRECTLY: unknown ids go to stderr
 * as `Error fetching …` while found rows still print as JSON, exit 0 — a
 * PARTIAL result run()'s error-text check would read as total failure.
 * Returns the rows, or null when stdout is not a JSON array. Callers must
 * hold the DB-exists gate (initializedDbRoot) first — see header.
 */
export const bdShowRows = (ids, opts = {}) => {
  const r = spawnSync('bd', ['show', ...ids, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
    ...opts,
  })
  try {
    const rows = JSON.parse(r.stdout ?? '')
    return Array.isArray(rows) ? rows : null
  } catch {
    return null
  }
}

/** km-id → issue number for each bead that has an External link. */
export const beadIssueLookup = ids => new Map((bdShowRows(ids) ?? []).map(b => [b.id, issueNumberFromRef(b.external_ref)]))

/**
 * beadIssueLookup, minting issues first for beads that have none (selective
 * --issues push, seconds). The shared write path of the pre-gate and the
 * post-publish verifier. `dry` (the BD_GITHUB_SYNC_DRY valve) suppresses the
 * mint; a missing DB or gh token yields the plain (possibly empty) lookup.
 */
export const beadIssueLookupWithMint = (ids, { dry = process.env.BD_GITHUB_SYNC_DRY === '1' } = {}) => {
  // No bd call of any kind before the DB-exists gate — see header.
  const dbRoot = initializedDbRoot()
  if (!dbRoot) return new Map()
  let byId = beadIssueLookup(ids)
  const missing = ids.filter(id => !byId.get(id))
  if (missing.length && !dry) {
    const pre = preconditions(dbRoot)
    if (pre.ok) {
      tryRun('bd', ['github', 'sync', '--push-only', '--issues', missing.join(',')], { env: pre.env, timeout: 45_000 })
      byId = beadIssueLookup(ids)
    }
  }
  return byId
}

// Both probes are bounded: these run inside hooks, where a stalled `git` or
// `bd` (a blocked filesystem, a hung binary) would hang the gate in front of
// the user's command, or burn the verifier's budget before it reports.
const PROBE_TIMEOUT = 5_000

const mainRepoRoot = () => {
  const commonDir = tryRun('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: PROBE_TIMEOUT })
  return commonDir ? dirname(commonDir.trim()) : null
}

// The DB's PRIOR existence gates every bd invocation — see header.
// Exported for bd-prime-hook.mjs, which shares the same fresh-clone invariant.
export const initializedDbRoot = () => {
  const root = mainRepoRoot()
  return root && existsSync(join(root, '.beads', 'embeddeddolt')) && tryRun('bd', ['--version'], { timeout: PROBE_TIMEOUT })
    ? root
    : null
}

export const preconditions = (root = initializedDbRoot()) => {
  if (!root) return { ok: false, reason: 'no initialized beads DB (or bd not on PATH)' }
  const token = tryRun('gh', ['auth', 'token'])?.trim()
  if (!token) return { ok: false, reason: 'no gh token' }
  return { ok: true, root, env: { ...process.env, GITHUB_TOKEN: token, BD_NO_REMOTE_ADOPT: '1' } }
}

const processAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/**
 * One sync at a time across sessions/worktrees (they share the one DB). The
 * lock only serializes THIS script; bd itself may still run concurrently
 * elsewhere — which is why listBeads failures abort instead of soft-failing.
 * The lock file holds the holder's pid, so the common leak — a holder killed
 * before its cleanup ran — self-heals on the next attempt via a dead-pid
 * check instead of waiting out a staleness window. A narrow TOCTOU remains
 * (two stealers can both unlink between one's read and the other's create,
 * sweeping a just-created live lock): accepted — the worst case is two
 * concurrent runs of converging operations, and closing it fully needs
 * primitives the filesystem doesn't offer.
 */
const withLock = (root, fn) => {
  const lock = join(root, '.beads', 'github-sync.lock')
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' })
      break
    } catch {
      // The deadline bounds EVERY loop path — an unremovable lock path (e.g.
      // a stray directory unlink can't clear) must skip, not spin forever.
      if (Date.now() > deadline) return { skipped: `lock at ${lock} could not be acquired in 20s` }
      const holder = Number(tryRead(lock))
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now())
      if ((holder && !processAlive(holder)) || age > 10 * 60_000) {
        try {
          unlinkSync(lock)
        } catch {}
        continue
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
  const unlock = () => {
    try {
      unlinkSync(lock)
    } catch {}
  }
  // Covers a kill landing while this process is between children. While a
  // spawnSync child runs, the event loop is blocked and no handler fires —
  // that leak is what the dead-pid steal above then heals.
  const onSignal = sig => {
    unlock()
    process.exit(sig === 'SIGINT' ? 130 : 143)
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  try {
    return fn()
  } finally {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    unlock()
  }
}

const tryRead = p => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

// All five statuses in one call; throws on failure. Callers slice by status —
// the plan functions own status selection, so nothing here pre-filters.
// --limit 0 is explicit: the documented default is 50, and a truncated bead
// list would put every unlisted open bead back on the re-open-the-issue path.
const listAllBeads = () =>
  JSON.parse(run('bd', ['list', '--status', 'open,in_progress,blocked,deferred,closed', '--limit', '0', '--json']))

const FETCH_LIMIT = 5000
const fetchIssues = () => {
  const rows = JSON.parse(
    run('gh', ['issue', 'list', '--repo', REPO, '--state', 'all', '--json', 'number,state,labels,updatedAt', '--limit', String(FETCH_LIMIT)]),
  )
  if (rows.length >= FETCH_LIMIT)
    throw new Error(`issue list hit the ${FETCH_LIMIT} fetch limit — raise it before trusting absence-based decisions`)
  // This repo can never legitimately have zero issues — an empty 200 is an
  // API blip or token-scope problem, and absence-based decisions downstream
  // (close-adoption finding nothing, close-pushes seeing everything absent)
  // would all be wrong at once.
  if (rows.length === 0) throw new Error('issue list came back empty — refusing absence-based decisions')
  return {
    issueByNumber: new Map(rows.map(i => [i.number, { state: i.state, labels: i.labels.map(l => l.name), updatedAt: i.updatedAt }])),
    maxKnownIssueNumber: rows.reduce((max, i) => Math.max(max, i.number), 0),
  }
}

// ---------------------------------------------------------------------------
// The sync sequence
// ---------------------------------------------------------------------------

const runSync = ({ quiet = false, dryRun = false } = {}) => {
  const pre = preconditions()
  if (!pre.ok) {
    if (!quiet) console.log(`bd-github-sync: skipped (${pre.reason})`)
    return { skipped: pre.reason }
  }
  const { env } = pre

  const result = withLock(pre.root, () => {
    const { issueByNumber, maxKnownIssueNumber } = fetchIssues()
    const preBeads = listAllBeads()
    const report = []

    // 1. Adopt GitHub-side closes BEFORE pushing (see header). A failed close
    // leaves an open bead that the push would use to re-open the issue, so
    // any failure here aborts the whole run.
    const closes = planCloseReconciliation(preBeads, issueByNumber)
    const closeFailures = []
    for (const { id, number } of closes) {
      if (dryRun) {
        report.push(`[dry-run] would close ${id} (issue #${number} was closed on GitHub)`)
      } else if (tryRun('bd', ['close', id, '--reason', `Closed on GitHub (issue #${number}); reconciled by bd-github-sync.`], { env }) !== null) {
        report.push(`closed ${id} (issue #${number} was closed on GitHub)`)
      } else {
        closeFailures.push(id)
      }
    }
    if (closeFailures.length)
      throw new Error(
        `aborting before push: could not adopt GitHub closes for ${closeFailures.join(', ')}` +
          (report.length ? ` (already applied: ${report.join('; ')})` : ''),
      )

    // 1.5 Push local state out BEFORE anything pulls. bd's pull applies a
    // strictly OLDER GitHub copy over newer local rows (#647) — closes and
    // edits included — so the pull must never see a GitHub copy that lags
    // local. Runs after close-adoption (an un-adopted open bead would
    // re-open its GitHub-closed issue) and skips content-identical beads,
    // which cannot revert anything.
    if (dryRun) {
      report.push('[dry-run] would push local state out before the pull')
    } else {
      const pushOut = run('bd', ['github', 'sync', '--push-only'], { env })
      // Zero-count lines stay out of the report: they would flip `changed`
      // below and un-quiet every converged SessionEnd run.
      report.push(...pushOut.split('\n').filter(l => /Pushed|Created|Updated/.test(l) && /[1-9]/.test(l)).map(l => `pre-pull: ${l.trim()}`))
    }

    // 1.6 The push's watermark silently skips older local edits, so snapshot
    // every bead whose local row is STILL newer than its GitHub copy — the
    // pull may revert exactly those; step 2.5 restores any it does. Fresh
    // list: close-adoption just changed local rows. Snapshot via a direct
    // spawn, not run(): `bd show` output is pretty-printed JSON, and a
    // description line starting with "Error" would trip run()'s bd check.
    const freshBeads = dryRun ? preBeads : listAllBeads()
    // Print the km→#N mapping for every issue the pre-pull push just minted —
    // IMMEDIATELY, not via the end-of-run report: any later step failing
    // (snapshot abort, the pull itself) would swallow the report, and by the
    // next run the bead already carries its ref, so the mapping would never
    // be printed at all.
    for (const { id, number } of planMintedRefs(preBeads, freshBeads))
      console.log(`bd-github-sync: minted: ${id} → #${number}`)
    const suspects = [
      ...new Map(
        [
          ...planLocalWins(freshBeads, issueByNumber),
          ...planMintedNonOpen(preBeads, freshBeads),
          ...planReopenedClosed(freshBeads, issueByNumber),
        ].map(s => [s.id, s]),
      ).values(),
    ]
    // The length check catches bd's partial-output shape (see bdShowRows):
    // a snapshot missing any suspect is no snapshot at all.
    const showSuspects = () => {
      const rows = bdShowRows(suspects.map(s => s.id), { env })
      return rows && rows.length === suspects.length ? rows : null
    }
    let snapshot = []
    if (suspects.length && !dryRun) {
      snapshot = showSuspects()
      // Abort rather than pull unprotected — same reasoning as the
      // close-adoption abort: proceeding is the exact loss this guard
      // prevents.
      if (!snapshot)
        throw new Error(
          `aborting before pull: could not snapshot ${suspects.map(s => s.id).join(', ')} — the pull could revert these newer local rows undetected (#647)`,
        )
    }

    // 2. The sync itself.
    const syncOut = run('bd', ['github', 'sync', ...(dryRun ? ['--dry-run'] : [])], { env })
    const syncSummary = syncOut
      .split('\n')
      .filter(l => /Pulled|Pushed|Created|Updated|dry-run/.test(l))
      .map(l => l.trim())
    report.push(...syncSummary)

    // 2.5 Restore local rows the pull reverted anyway (#647 — the watermark
    // kept them out of 1.5's push). The restore bumps updated_at, so the
    // push-back below carries them out and the next pull leaves them alone.
    //
    // ACCEPTED residuals (reviewed 2026-08-20; each is a failure INSIDE this
    // fallback, needs a mid-run bd failure or a seconds-wide race, and ends
    // in a report line naming the bead for hand-recovery — do not add
    // machinery for them here, it recreates transactions over a store that
    // has none; the class ends upstream when bd's pull honors prefer-newer):
    // a close restore whose second step fails leaves the row open with the
    // reason only in the FAILED line; a concurrent edit from another
    // worktree during the pull window can be read as a revert and lose the
    // seconds-wide delta between two local edits (no compare-and-swap verb
    // exists to close this); the conservative no-post path cannot compute
    // label REMOVALS, so a pulled-back stale label survives until edited.
    const postBeads = dryRun ? preBeads : listAllBeads()
    // Post-pull state for the suspects comes from `bd show`, not the list:
    // list rows lack assignee, so a list-based comparison would miss
    // assignment-only reverts (and false-positive every assigned suspect).
    const postSuspects = snapshot.length ? showSuspects() : []
    const postById = new Map((postSuspects ?? []).map(b => [b.id, b]))
    // A failed post-read must not discard the snapshot: the DB may already
    // hold the reverted row, and the next sync's snapshot would capture THAT
    // — the newer local edit would be gone for good. Conservatively restore
    // every snapshotted suspect instead; for an untouched row that rewrites
    // identical content, which the push-back then skips.
    const reverted = dryRun ? [] : postSuspects ? detectReverts(snapshot, postById) : snapshot
    if (!postSuspects)
      report.push(`FAILED to re-read ${suspects.map(s => s.id).join(', ')} after the pull — conservatively restoring every snapshotted suspect`)
    const restoredOk = []
    const restoreFailures = []
    for (const row of reverted) {
      const ok = planRestoreArgs(row, postById.get(row.id)).every(args => tryRun('bd', args, { env }) !== null)
      if (ok) {
        restoredOk.push(row.id)
        report.push(`restored ${row.id} — the pull reverted a newer local row (#647)`)
      } else {
        restoreFailures.push(row.id)
      }
    }
    // Failed restores stay OUT of the push-back: pushing a half-restored row
    // would stamp GitHub newer and bury the loss, while leaving GitHub older
    // keeps the row a suspect so the next sync retries the restore.
    if (restoreFailures.length)
      report.push(`FAILED to restore after a pull revert: ${restoreFailures.join(', ')} — left un-pushed so the next sync retries; check them by hand (bd show)`)

    // 3. Un-flatten priorities (pre/post comparison — see header), push back
    // together with the restored rows.
    const preById = new Map(preBeads.map(b => [b.id, b]))
    if (dryRun) report.push('[dry-run] priority un-flattening not simulated — it needs the post-sync state')
    const fixes = planPriorityFixes(preById, postBeads, issueByNumber)
    for (const { id, to } of fixes) {
      if (!dryRun) run('bd', ['update', id, '-p', String(to)], { env })
      report.push(`priority ${id} → ${to} (re-derived after pull-flattening)`)
    }
    // restoreFailures subtracted from the WHOLE union: a half-restored row
    // can also enter through the priority-fix leg, and pushing it would
    // stamp GitHub newer and bury the loss (see the restore loop above).
    const failedRestoreIds = new Set(restoreFailures)
    const pushBack = [...new Set([...fixes.map(f => f.id), ...restoredOk])].filter(id => !failedRestoreIds.has(id))
    if (pushBack.length && !dryRun) run('bd', ['github', 'sync', '--push-only', '--issues', pushBack.join(',')], { env })

    // 4. Carry bead closes out to issues still open (see header: via gh, not
    // a selective bd push, whose watermark silently skips older closes).
    const closePushes = planClosePushes(postBeads, issueByNumber, maxKnownIssueNumber)
    for (const { id, number } of closePushes) {
      if (dryRun) {
        report.push(`[dry-run] would close issue #${number} to match closed bead ${id}`)
        continue
      }
      // Verify the target just before acting: issues and PRs share one number
      // sequence and `gh issue close` happily closes a PR, so a mis-pointed
      // ref (or the beyond-max inference) must never act blind. Also skips
      // targets that converged since the fetch.
      let target = null
      try {
        target = JSON.parse(tryRun('gh', ['api', `repos/${REPO}/issues/${number}`], { env }) ?? 'null')
      } catch {}
      if (!target) {
        report.push(`FAILED to inspect #${number} (bead ${id}) — leaving it alone`)
        continue
      }
      if (target.pull_request) {
        report.push(`SKIPPED #${number}: it is a pull request — bead ${id} carries a mis-pointed external_ref`)
        continue
      }
      if (target.state === 'closed') continue
      const ok = tryRun('gh', ['issue', 'close', String(number), '--repo', REPO, '--reason', 'completed'], { env }) !== null
      report.push(ok ? `closed issue #${number} to match closed bead ${id}` : `FAILED to close issue #${number} (bead ${id}) — close it by hand or re-run`)
    }

    // "Changed" means an action was reported — a close-push candidate that
    // turned out converged (silent continue above) must not un-quiet a run.
    const actionReported = report.some(l => !syncSummary.includes(l))
    const changed = actionReported || syncSummary.some(l => /[1-9]/.test(l))
    if (!quiet || changed) console.log(['bd-github-sync:', ...report].join('\n  '))
    return { closes, fixes, closePushes }
  })

  if (result?.skipped && !quiet) console.log(`bd-github-sync: skipped (${result.skipped})`)
  return result
}

// ---------------------------------------------------------------------------
// PreToolUse(Bash) hook mode
// ---------------------------------------------------------------------------

const allow = () => process.exit(0)

/**
 * One issue/PR's ground truth, memoized per process — tolerant, and
 * distinguishing 'not-found' from null (gh itself broke). The memo matters
 * to the post-publish verifier, which may look the same numbers up for
 * mapping validation and again for the echo table, across several targets,
 * inside a killable hook timeout. Only definite answers are cached.
 */
const issueInfoCache = new Map()
export const fetchIssueInfo = number => {
  if (issueInfoCache.has(number)) return issueInfoCache.get(number)
  const r = spawnSync('gh', ['api', `repos/${REPO}/issues/${number}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  })
  let info = null
  try {
    const j = JSON.parse(r.stdout)
    info =
      r.status !== 0
        ? /not found/i.test(j?.message ?? '')
          ? 'not-found'
          : null
        : { title: j.title ?? '', state: j.state ?? '', isPr: Boolean(j.pull_request) }
  } catch {
    info = null
  }
  if (info !== null) issueInfoCache.set(number, info)
  return info
}

// The #N leg of the gate: echo every referenced number's ground truth;
// KM_ISSUE_REFS_OK=1 on the re-run confirms. Also used by
// bd-publish-verify.mjs (mode 'post', where the text already published).
export const issueRefsTable = (text, refs, mode = 'pre') =>
  buildIssueRefsMessage(refs.map(number => ({ number, info: fetchIssueInfo(number) })), new Set(closeKeywordRefs(text)), mode)

const echoIssueRefs = (text, refs) => {
  console.error(issueRefsTable(text, refs))
  process.exit(2)
}

const hookPrePr = () => {
  let payload = {}
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    allow()
  }
  const cmd = payload?.tool_input?.command ?? ''
  if (!cmd) allow()
  const cwd = payload?.cwd ?? process.cwd()

  // Message/body files, read at most once, failing CLOSED on text this gate
  // cannot see: a stdin-fed body would need pipeline simulation (heredoc
  // stdin passes — its content sits in the raw command), and an unreadable
  // file would carry its references unverified. Called ONLY by the legs
  // whose text never reaches the post-publish verifier.
  let bodiesCache = null
  const guardedBodies = () => {
    if (bodiesCache) return bodiesCache
    if (hasStdinBody(cmd) && !cmd.includes('<<')) {
      console.error(
        'This command feeds commit or merge/review text from stdin, which this gate cannot inspect. Use a heredoc (scanned), a file, or an inline flag — or, after verifying the references yourself, re-run with KM_ISSUE_REFS_OK=1 prefixed.',
      )
      process.exit(2)
    }
    const paths = bodyFilePaths(cmd).map(p => resolveBodyPath(p, cwd, homedir()))
    const missing = paths.filter(p => !existsSync(p))
    if (missing.length) {
      console.error(
        `Cannot read message file(s) referenced by this command: ${missing.join(', ')} (resolved from ${cwd}; cd chains inside the command are not followed).\n` +
          'Run from the directory the paths are relative to, inline the text, or — after verifying the references yourself — re-run with KM_ISSUE_REFS_OK=1 prefixed.',
      )
      process.exit(2)
    }
    return (bodiesCache = paths.map(p => readFileSync(p, 'utf8')))
  }

  // A --silent api mutation is invisible to the post-publish verifier too —
  // the one shape with NO checkpoint anywhere; fail closed on the flag.
  const silentApi = matchesApiPublish(cmd) && /(?<![\w-])--silent\b/.test(commandSkeleton(cmd))
  if (silentApi && !allowsIssueRefs(cmd)) {
    console.error(
      'This gh api mutation is --silent: neither this gate nor the post-publish verifier can see what it publishes. Drop --silent (the printed response is how published text gets verified) — or, after verifying the references yourself, re-run with KM_ISSUE_REFS_OK=1 prefixed.',
    )
    process.exit(2)
  }

  // Unrepairable-verb text built by shell expansion has no readable form
  // ANYWHERE — not here, and never post-publication — so it fails closed.
  // Both escapes are required: an expanded body can hide refs and bead ids
  // alike.
  if (matchesUnrepairableCommand(cmd) && hasDynamicBody(cmd) && !(allowsIssueRefs(cmd) && allowsBeadIds(cmd))) {
    console.error(
      'This merge/review/close text is built by shell expansion ($(…), `…` or a variable), which no gate can inspect — and it lands where the post-publish verifier cannot repair. Publish literal text or a file — or, after verifying references AND bead ids yourself, re-run with KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 prefixed.',
    )
    process.exit(2)
  }

  // The legs below are INDEPENDENT — one invocation can both commit and
  // publish (`git commit -m "Fixes #N" && gh pr comment …`), and a publish
  // match must not swallow the commit check.

  // Close keywords in commit messages act when the commit reaches the
  // default branch, and commit text never becomes a GitHub object.
  const commitText = matchesCommitCommand(cmd) && !allowsIssueRefs(cmd) ? [cmd, ...guardedBodies()].join('\n') : ''
  const commitRefs = commitText ? closeKeywordRefs(commitText) : []

  // A refs-approved (--silent) api mutation still owes the bead-id leg its
  // raw-command scan — the verifier will never see this publish.
  const isPublish = matchesPrCommand(cmd)
  const graphqlMutation = matchesGraphqlMutation(cmd)
  if (!isPublish && !graphqlMutation && !silentApi) {
    if (commitRefs.length === 0) allow()
    return echoIssueRefs(commitText, commitRefs)
  }

  // The publish legs inspect the raw command string (plus, for the
  // unrepairable verbs, their body files). Everything else about published
  // text is verified AFTER publication by bd-publish-verify.mjs — see the
  // --hook-pre-pr section of the header; the parsing surface here is FROZEN.
  //
  // A positional target URL (`gh pr comment <url> --body …`) is the command's
  // addressee, not published text — stripped so it does not cost a
  // title-confirmation round. Two guards keep the strip away from published
  // text: the pattern is anchored on `gh` itself, and it only applies at all
  // when the SKELETON confirms an unquoted positional target exists — quoted
  // prose that merely resembles one must keep its refs verified. Residual:
  // prose spelling out a full `gh … <url>` alongside a real positional
  // target also gets stripped — accepted over parsing argument positions.
  const targetUrl = () => /((?:\S*\/)?gh\s+(?:-\S+\s+(?:[^-\s]\S*\s+)?)*(?:pr|issue)\s+\w+\s+)https?:\/\/\S+/g
  const text = targetUrl().test(commandSkeleton(cmd)) ? cmd.replace(targetUrl(), '$1') : cmd

  // #N refs pre-publish ONLY where post-publication repair cannot reach:
  // merge text lands in the merge commit, review/close/reopen output names
  // no URL for the verifier to find, and graphql responses hide the mutated
  // object in an envelope this hook cannot safely resolve.
  //
  // Body files feed TWO independent checks — #N refs (KM_ISSUE_REFS_OK) and
  // bead ids (KM_ALLOW_BEAD_IDS) — so they are read unless BOTH escapes are
  // given; each check then consumes them only under its own escape.
  const publishBodies =
    matchesUnrepairableCommand(cmd) && !(allowsIssueRefs(cmd) && allowsBeadIds(cmd)) ? guardedBodies() : []
  const publishText = allowsIssueRefs(cmd)
    ? ''
    : matchesUnrepairableCommand(cmd)
      ? [text, ...publishBodies].join('\n')
      : graphqlMutation
        ? cmd
        : ''
  const refs = [...new Set([...commitRefs, ...(publishText ? extractIssueRefs(publishText) : [])])]

  // The two escapes are independent: a command allowed to mention bead ids
  // can still carry a hallucinated issue number, and vice versa. Bead ids in
  // graphql mutations are scanned here because the verifier yields no
  // targets for them; unrepairable-verb body files ride along when already
  // read for refs.
  const ids = allowsBeadIds(cmd)
    ? []
    : extractBeadIds([isPublish ? text : cmd, ...publishBodies].join('\n'))
  if (ids.length === 0 && refs.length === 0) allow()
  const refsText = [publishText, commitText].filter(Boolean).join('\n') || text
  if (ids.length === 0) return echoIssueRefs(refsText, refs)

  const byId = beadIssueLookupWithMint(ids)
  const mapped = ids.filter(id => byId.get(id)).map(id => ({ id, number: byId.get(id) }))
  const unmapped = ids.filter(id => !byId.get(id))
  // The deny message licenses a KM_ISSUE_REFS_OK=1 re-run, so any #N already
  // present in the text must have its ground truth shown in THIS round —
  // otherwise the mixed case would publish unverified numbers under that
  // licence.
  const refsSection = refs.length ? `\n\n${issueRefsTable(refsText, refs)}` : ''
  console.error(buildDenyMessage(mapped, unmapped) + refsSection)
  process.exit(2)
}

// ---------------------------------------------------------------------------

/**
 * Exact-path comparison: a suffix match would run a live sync at import time
 * from any future sibling whose name this file's happens to end with. Both
 * sides realpathed: node resolves the ESM entry through symlinks while argv
 * keeps the literal path, and a mismatch silently disables the hook. Shared
 * by every hook script in scripts/.
 */
export const isMainModule = metaUrl => {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(process.argv[1]))
  } catch {
    return fileURLToPath(metaUrl) === resolve(process.argv[1])
  }
}

if (isMainModule(import.meta.url)) {
  const args = new Set(process.argv.slice(2))
  if (args.has('--hook-pre-pr')) {
    hookPrePr()
  } else {
    try {
      runSync({ quiet: args.has('--quiet'), dryRun: args.has('--dry-run') })
    } catch (e) {
      console.error(`bd-github-sync: failed — ${e.message ?? e}`)
      process.exit(1)
    }
  }
}
