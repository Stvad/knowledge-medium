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
 *    issue closed via gh — NOT via a selective bd push: bd PATCHes a linked
 *    bead only when the local row is strictly newer than the issue's
 *    updated_at, so anything that touched the issue after the close (a
 *    comment, a label, a cross-reference) makes bd skip it for good
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
 *    newer than their GitHub copy — a failed push or a mid-run touch of the
 *    issue can leave such a row unpushed — are snapshotted before the pull
 *    and restored + re-pushed if it reverted them. That push is SELECTIVE and the pull runs alone (see step 1.5):
 *    bd 1.2.2 GETs every linked bead it is handed and PATCHes only the
 *    local-newer ones, so the listing already names the beads it could
 *    touch, and a converged run costs seconds rather than one GET per bead
 *    per leg (measured: 387 beads, 90s per leg, two legs).
 *
 * 5. The pull re-applies a GitHub copy onto a bead and drops what GitHub does
 *    not carry back: the assignee (bd's push never sets one), the close date
 *    (the status write restamps it, and no bd verb can put it back), and a
 *    type the labels do not spell uniquely (#955). So the pull is never given
 *    such a bead. It runs BY IDENTIFIER (planPullSet + pullIssues) over the
 *    issues with no bead and the beads it would carry faithfully, which takes
 *    doPull's other branch: it fetches each issue by number, ignores
 *    `last_sync`, and never hydrates. Both of a bulk pull's routes to a bead —
 *    the incremental window, and fetchPrelinkedIssues bypassing the
 *    skip-locally-modified guard for a row edited since the stamp — are
 *    therefore out of reach, and a withheld bead simply cannot be written.
 *
 *    That is what keeps the mirror BIDIRECTIONAL. A bulk pull cannot: bd
 *    stamps `last_sync` a second into the future at the end of every
 *    non-dry-run sync, a `--push-only` one included, so any pre-pull push
 *    leaves the following bulk pull an empty window — it would import nothing
 *    at all, new GitHub-filed issues included. Protecting a bead and importing
 *    an edit are the same window, and only a pull by identifier has neither.
 *
 *    A withheld bead is REPORTED, with the fields that also differ on GitHub:
 *    the next push sends the local value over them, and nothing here can say
 *    which side was edited last.
 * Accepted race: an issue closed on GitHub DURING the sync window can be
 * re-opened by the in-flight push, and because the reopen is then the state
 * every later fetch sees, no later run re-adopts the close. Inherent to a
 * push-based mirror; close the bead instead if it happens.
 *
 * Beyond the guards, the wrapper carries what bd's sync does not: bead
 * COMMENTS are mirrored onto their issues, one way and append-only
 * (mirrorComments), after the push and after the pull. GitHub-side comments
 * are never pulled into beads.
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
 *       not trip it). Published text is read back after publication by
 *       bd-publish-verify.mjs (PostToolUse), which echoes the real title of
 *       every #N it published — so this gate scans the raw command string
 *       and deliberately does NOT chase stdin/expansion/--recover bodies;
 *       its parsing surface is FROZEN (#672 — decline coverage findings
 *       here). Bead ids (km-…) BLOCK (exit 2) with the km→#N substitution
 *       table, looked up but never MINTED — the detectors deliberately
 *       over-match, so a verb sitting in ordinary argv reads as a publish,
 *       and a mint there would create a public issue for a command that is
 *       about to be blocked and never runs. The block names `pnpm bd:sync`
 *       for an id with no issue yet. The #N echo-gate stays
 *       pre-publish for publishes the read-back does NOT cover, decided by
 *       a WHITELIST: one gh command with no shell operator in its skeleton,
 *       aimed at this repo, whose verb and flags leave a fetchable URL in
 *       the output. Everything else is uncovered — so a spelling this gate
 *       fails to recognize costs an attested re-run instead of a silent
 *       gap, which is the whole reason for the direction. Uncovered
 *       publishes take ONE coarse rule (#683: B): readable command text
 *       gets the tables; text living OUTSIDE the command (file/payload
 *       flags, api @-references, expansion) blocks outright and the escapes
 *       attest — no file reading, no per-channel detection (which does not
 *       converge; decision record: #683). Plus git commit close keywords
 *       (commit text never becomes a GitHub object; the commit leg runs
 *       INDEPENDENTLY of the publish legs), and the merge COMMIT of a
 *       merged PR, read back post-merge by bd-publish-verify.
 *       Escape hatches: KM_ALLOW_BEAD_IDS=1 / KM_ISSUE_REFS_OK=1 prefixes.
 *       The FULL sync does not run here: even converged it costs several
 *       seconds (an issue listing, bead listings, a pull) plus the lock,
 *       which is too slow to sit in front of every PR. SessionEnd and manual
 *       runs carry it. This mode writes NOTHING, so
 *       it needs no dry-run valve: it reads, and it blocks or allows.
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
import { accessSync, constants, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isMainModule } from './is-main-module.mjs'
import { shellSegmentsWithDepth } from './shell-segments.mjs'

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
  // Comments are part of the SAME pass as quotes and substitutions, not a
  // sweep after it. `\\.` consumes an escaped character as one atom, so the
  // space in `printf x \\ #literal` is spoken for and the `#` after it is an
  // argument rather than a comment — a following `; gh …` then survives. A
  // second pass cannot see that, which is how the sweep this replaces
  // deleted a real publish.
  const skeleton = cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\$\(([^)]*)\)|`([^`]*)`|\\.|(?:^|\s)#[^\n]*/g, (m, dollarBody, tickBody) => {
    if (m.startsWith('\\')) return m
    // Only the comment alternative can start with `#` or whitespace — every
    // other one starts with its own delimiter — so the first character is an
    // exact dispatch. A leading space belongs to the argument before it.
    if (m.startsWith('#')) return ''
    if (/^\s/.test(m)) return m[0]
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

// The DETECTORS below scan the skeleton for their verb wherever it occurs.
// They deliberately do NOT require it to sit at a recognized command
// position, because that test could only be written as a list — of
// separators, of control keywords, of wrapper commands (env, xargs, timeout,
// sudo, …) — and the failure mode of an incomplete list here is the worst one
// available: an indented, `\`-continued or unlisted-wrapper `gh` matched
// nothing, so the gate fast-exited AND the read-back skipped it, leaving the
// publish examined by neither. Over-matching a detector costs one echo round.
//
// What kept prose out was never the position test but commandSkeleton, which
// blanks quoted spans: `git commit -m "gh pr merge was the fix"` has no verb
// left to find. Heredoc bodies do survive into the skeleton, so a heredoc
// line CAN trip a detector — an accepted false positive (see
// commandSkeleton), and the reason the ESCAPES anchor differently below.
// Global options (-R/--repo, --hostname) may sit between `gh` and the
// subcommand, same shape as git's (the value-optional branch over-matches
// harmlessly).
const GLOBAL_OPTS = String.raw`(?:-\S+\s+(?:[^-\s]\S*\s+)?)*`
// The prefix every gh matcher shares, spelled once: a fix to it cannot land
// on one matcher and miss the others.
const GH = String.raw`(?:\S*\/)?\bgh\s+` + GLOBAL_OPTS
const GH_PUBLISH = new RegExp(
  GH +
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
const GH_API = new RegExp(GH + String.raw`api\s`, 'm')
const isGhApiCall = cmd => GH_API.test(commandSkeleton(cmd))
// An explicit read verb: `gh api -X GET … -f key=value` sends its fields as
// query parameters and publishes nothing, so the text it carries is never
// text it PUBLISHED. Read off the skeleton alone, unlike the membership words
// of isPostVerifiable: this SUPPRESSES a warning, so it must under-match.
//
// The EFFECTIVE method decides it, not any read token present. gh keeps the
// LAST -X/--method — measured against the installed gh: `-X POST -X GET
// /rate_limit` answers as a GET, and the reverse order 404s as a POST — so
// suppressing on the first `GET` seen would silence the warning for a
// mutation that merely mentions one earlier in its argv.
const METHOD_FLAG = /(?<![\w-])(?:-X|--method)(?:=|\s+)?([A-Za-z]+)/g
const effectiveMethod = sk => [...sk.matchAll(METHOD_FLAG)].pop()?.[1]?.toUpperCase()
const isExplicitRead = sk => effectiveMethod(sk) === 'GET' || effectiveMethod(sk) === 'HEAD'
// A LONE explicit read publishes nothing: gh sends its fields as a query
// string, so the object its response names was READ, and reporting that as
// published sends the agent to edit text it never wrote. Restricted to a
// single segment because the effective method is resolved across the whole
// skeleton — in a mutate-then-read compound this would otherwise exempt the
// mutation too. Multi-segment keeps the old behaviour, so the compound needs
// no vocabulary of its own.
const isSoleExplicitRead = (cmd, sk) =>
  isExplicitRead(sk) && shellSegmentsWithDepth(cmd).filter(s => !s.heredoc).length === 1

export const matchesApiPublish = cmd => {
  if (!isGhApiCall(cmd)) return false
  const sk = commandSkeleton(cmd)
  if (isSoleExplicitRead(cmd, sk)) return false
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
const GIT_COMMIT = new RegExp(String.raw`(?:\S*\/)?\bgit\s+` + GLOBAL_OPTS + String.raw`commit\b`, 'm')
export const matchesCommitCommand = cmd => GIT_COMMIT.test(commandSkeleton(cmd))

// Wrappers and assignments that can precede the real verb. BARE words only —
// a wrapper carrying options is not skipped past, because its options decide
// whether it execs at all: `command -v git commit -F x` PRINTS a description
// and runs nothing, while `env -u FOO git commit -F x` does run. Telling
// those apart needs a per-flag arity and mode table for every wrapper, which
// would have to be complete to be correct. Stopping at the first option
// instead fails the safe way for a check that authorizes a FILE READ: the
// `-v` form is refused, and the `env` form is an accepted under-match whose
// only cost is that one message file goes unscanned (the raw command is
// checked either way).
const VERB_PREFIX = new Set(['command', 'env', 'nohup', 'time', 'xargs'])
// git's global options that take a separate value, which would otherwise be
// mistaken for the subcommand.
const GIT_OPT_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const isGitCommitSegment = tokens => {
  let i = 0
  while (i < tokens.length && (/^[A-Za-z_]\w*=/.test(tokens[i]) || VERB_PREFIX.has(tokens[i]))) i++
  if (!/(?:^|\/)git$/.test(tokens[i] ?? '')) return false
  for (let j = i + 1; j < tokens.length; j++) {
    if (tokens[j] === 'commit') return true
    if (!tokens[j].startsWith('-')) return false
    if (GIT_OPT_WITH_VALUE.has(tokens[j])) j++
  }
  return false
}

/**
 * Is `git commit` in an actual command position? The detectors above
 * deliberately over-match, because over-matching a DETECTOR costs one echo
 * round — but the commit leg is the one place a match opens a FILE named in
 * argv, and `printf '%s\n' git commit -F .env` is not a commit. So the file
 * read gets evidence the scan does not need: real segmentation, which also
 * keeps a heredoc body from passing for a command position.
 *
 * Under-matching here costs only the file scan — the raw command is scanned
 * for close keywords either way — so this stays a plain verb check rather
 * than growing a vocabulary of every way a shell can reach git.
 *
 * ACCEPTED, not overlooked: a wrapper carrying ANY option — `env -u FOO git
 * commit -F msg.txt`, `xargs -n1 git commit -F msg.txt` — leaves that message
 * file unscanned, because the skip stops at the first option (see
 * VERB_PREFIX for why it must). Declined 2026-08-21; the command's own text
 * is still checked, and the alternative is a per-wrapper flag table that
 * would have to be COMPLETE to be correct.
 */
export const commitsInCommandPosition = cmd =>
  shellSegmentsWithDepth(cmd).some(s => !s.heredoc && isGitCommitSegment(s.tokens))

// There is deliberately NO foreign-repo (-R/--repo) shortcut: three review
// rounds each found a way to make its target parse lie (quoted values,
// expansions, multi-segment payloads), and every miss switched the gate OFF.
// A publish aimed at another repo simply runs the gate against this repo's
// issue space — its refs come back not-found and the escape hatch covers the
// (essentially unused) case. A never-exercised convenience is not worth a
// recurring bypass surface.

// The verbs whose output names no URL the read-back could fetch: `gh pr
// merge` text lands in the merge commit, and review/close/reopen print
// `repo#N`, never a link to the review or the -c comment. gh's verb table
// is closed and documented, which is what makes listing it sound where
// listing shell syntax is not. Their file-fed bodies are NOT read — the
// coarse rule blocks those until both escapes attest.
// Comment-less closes pass for free — no refs in the text, nothing to echo.
const GH_UNVERIFIABLE = new RegExp(
  GH + String.raw`(?:pr\s+(?:merge|review|close|reopen)|issue\s+(?:close|reopen))\b`,
  'm',
)
export const matchesUnverifiableCommand = cmd => GH_UNVERIFIABLE.test(commandSkeleton(cmd))

// Expansion is checked against the command with only SINGLE-quoted spans
// blanked, which is the exact set the shell never expands. The full skeleton
// is the wrong string here — it blanks double-quoted spans too, so a real
// `--body "$(cat notes.md)"` would read as operator-free — and the raw
// command is equally wrong in the other direction, since a literal `$5` or a
// markdown code span in a single-quoted body is text, not an argument.
const EXPANSION = /[$`]/
// ONE left-to-right pass, like commandSkeleton and for the same reason: a
// naive single-quote sweep lets an apostrophe inside one double-quoted
// argument pair with one in a later argument and swallow everything between
// them — including a real expansion. Double-quoted spans are matched so they
// claim their own apostrophes, and returned verbatim, since the shell DOES
// expand inside them.
const expandable = cmd => cmd.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, m => (m.startsWith("'") ? "''" : m))
// The two above are only ever correct together, so only the pair has a name.
// Testing EXPANSION against the raw command or against the full skeleton are
// both wrong (see above), and both spellings have had to be corrected by hand
// at a call site; there is now no call site to get wrong.
const hasExpansion = cmd => EXPANSION.test(expandable(cmd))
// Every shell operator in one character class — pipes, redirects,
// substitutions, separators, multi-line — so there is no per-operator
// spelling to keep complete and no positional heuristic to defeat.
// `!` is bash's status-negating reserved word, not punctuation: under it the
// tool's success/failure — and so which post-hook event fires — is INVERTED,
// which is the one thing the read-back reasons from that it cannot check.
// Tested on the skeleton, so an exclamation mark in a quoted body is blanked
// and costs nothing.
const SHELL_OPERATOR = /[|;&<>$`\n!]/
// Repository selection away from this one, by flag or by environment. The
// read-back's URL pattern is pinned to this repo, so a foreign publish has
// no post-check at all. No separator required: gh takes -Rowner/repo.
const FOREIGN_TARGET = /(?<![\w-])(?:-R|--repo)|\bGH_REPO=/
// Flags that leave no fetchable object in the output. `-t` is --template's
// short form; consulted only for `gh api`, where it formats the response,
// never for `gh pr create -t <title>`.
const OPAQUE_OUTPUT = /(?<![\w-])(?:--(?:silent|jq|template)\b|-t)/
// The api's graphql endpoint answers with no object URL to read back.
const GRAPHQL = /\bgraphql\b/

/**
 * Any command that may publish text on GitHub — including one whose mutation
 * flags arrive by expansion, where no literal flag is left to match and a
 * narrower test would leave the command inspected by NEITHER hook.
 */
// Modes that print or hand off instead of creating anything: --dry-run shows
// what would be sent, --web opens the browser. They make a command UNCOVERED
// rather than not-a-publish, and the difference is the whole point. Exempting
// the command from publishing entirely fails OPEN — the token is found
// anywhere in the skeleton, so a dry-run beside a real publish in one
// invocation ("gh pr create --dry-run; gh issue comment …") would exempt the
// real one too, and `--dry-run=false` would exempt itself. Uncovered fails
// CLOSED in every one of those cases: the text is checked before it ships,
// and the read-back stays quiet because nothing claimed it was covered.
// Scoping the token to its own segment instead would be shell parsing.
const NON_PUBLISHING_MODE = /(?<![\w-])--(?:dry-run|web)\b/

export const matchesAnyPublish = cmd =>
  matchesPrCommand(cmd) || matchesApiPublish(cmd) || (isGhApiCall(cmd) && hasExpansion(cmd))

// Text-bearing flags and api fields. A publish with none of them — a label
// change, a reaction, a comment DELETION, a merge-method call — has no
// reference to check, so a read-back that finds nothing there is not a broken
// promise and must not be reported as one.
//
// This is the same shape as the flag allowlist that once vetoed the deleted
// repair path, and it is safe HERE for the reason it was not there: it
// decides only whether to WARN. Being wrong costs a missing or an extra note,
// never a wrong write. Missing a spelling is therefore the cheap direction,
// which is why it is written as a small list rather than defended as one.
const TEXT_FLAG = /(?<![\w-])(?:--(?:body|title|notes|message)(?:-file)?\b|--input\b|-[btm](?=[\s=]|$))/
// A CREATE always publishes text, so the VERB answers the question and no
// flag has to. A PR, issue or release cannot exist without a title, and its
// body may arrive with no flag naming it at all: --fill from the branch's
// commits, --recover from a failed run, a repository template, $EDITOR, or an
// interactive prompt. Enumerating those cost one round of review each and the
// list grows once per gh release; the verb does not. EDIT keeps the flag list
// — an edit really can carry no text (a label change, a reviewer).
const GH_CREATE = new RegExp(GH + String.raw`(?:pr|issue|release)\s+(?:create|new)\b`, 'm')
// Every payload-field spelling gh accepts, so a field is never missed and
// then read as "carries no text" — which would suppress the warning rather
// than add one, the direction that actually hurts. What the field CARRIES is
// decided by its name.
const FIELD_ANY = /(?<![\w-])(?:-[fF]|--(?:raw-)?field)(?:=|\s+)?['"]?([A-Za-z_][\w.[\]-]*)=/g
// Matched as a SUBSTRING, not an exact name: the api's compound fields
// (commit_title, commit_message on the merge endpoint) carry text every bit
// as much as `body` does, and an exact list would have to grow once per
// endpoint. Over-matching a field name adds a warning; missing one suppresses
// the warning entirely, which is how an unchecked close keyword reaches a
// merge commit that acts on it immediately.
// `content` covers the nested-field forms gh documents (files[a.md][content]
// on gists, the contents API) — FIELD_ANY already captures the bracketed name
// whole, so only this list had to learn the word.
const TEXT_FIELD_NAME = /body|title|message|name|description|text|note|comment|content/i

/** Whether this command publishes text that could contain a reference at all. */
export const carriesPublishableText = cmd => {
  const sk = commandSkeleton(cmd)
  if (isExplicitRead(sk)) return false
  if (GH_CREATE.test(sk) || TEXT_FLAG.test(sk)) return true
  // Field names come off the raw command as well as the skeleton: `-f
  // 'commit_title=…'` quotes the WHOLE argument, which the skeleton blanks,
  // and a field that vanishes reads as "no text published" — suppressing the
  // warning rather than adding one.
  const fields = [...sk.matchAll(FIELD_ANY), ...cmd.matchAll(FIELD_ANY)].map(m => m[1])
  if (fields.length) return fields.some(name => TEXT_FIELD_NAME.test(name))
  // No payload field at all: a bare `-F` is then a body FILE, which only the
  // CLI has — on the api every `-F` carries a name and was handled above.
  return !matchesApiPublish(cmd) && /(?<![\w-])-F(?=[\s=]|$)/.test(sk)
}

/**
 * Whether the post-publication read-back covers this publish. A WHITELIST:
 * recognize the covered shape and treat everything else as uncovered, so a
 * command this gate fails to recognize costs an attested re-run instead of
 * passing unchecked. Enumerating the ways output escapes the hook would have
 * to be COMPLETE over shell syntax to be correct, and cannot be.
 *
 * Two layers, different in kind on purpose:
 *  - SHELL: the skeleton must hold no operator at all, and the raw text no
 *    expansion.
 *  - GH: a closed, documented vocabulary — the verbs whose output names no
 *    URL, foreign targets, graphql, response-hiding flags. A gap here is
 *    bounded by one tool's manual rather than by the shell's grammar, and
 *    bd-publish-verify reports a coverage claim it could not honour, so a
 *    gap surfaces instead of passing silently.
 *
 * Membership words are tested on the raw text too: a quoted "--silent" or
 * "graphql" still reaches gh unquoted. Prose hits cost one echo round.
 *
 * A heredoc carries `<` and so attests. That is the deliberate cost of not
 * parsing heredocs (see commandSkeleton): write the body to a file and
 * publish it with --body-file, which is a single covered command.
 */
export const isPostVerifiable = cmd => {
  if (!matchesAnyPublish(cmd)) return false
  const sk = commandSkeleton(cmd)
  // The "raw text too" rule of the docstring, named once instead of spelled
  // out per membership word.
  const anywhere = re => re.test(sk) || re.test(cmd)
  if (SHELL_OPERATOR.test(sk) || hasExpansion(cmd)) return false
  if (anywhere(NON_PUBLISHING_MODE) || anywhere(FOREIGN_TARGET)) return false
  const api = matchesApiPublish(cmd)
  if (api && (anywhere(GRAPHQL) || anywhere(OPAQUE_OUTPUT))) return false
  return api || !matchesUnverifiableCommand(cmd)
}


// The escape hatch must also be in command-prefix position of the SKELETON —
// honored from quoted prose, a PR body QUOTING it would both bypass the gate
// and publish the marker.
// Anchored at the invocation start or after an explicit separator — never
// after a bare NEWLINE, which is exactly what separates heredoc DATA lines.
// Heredoc bodies survive into the skeleton (see commandSkeleton), so a line
// of data would otherwise sit at a command position and attest for a real
// publish later in the same invocation. No `m` flag, so `^` is the string
// start rather than every line start. Over-matching a detector is cheap;
// over-matching a bypass is not.
const ESCAPE_START = String.raw`(?:^|[;&|]\s*)(?:[A-Za-z_]\w*=\S*\s+)*`
const ALLOW_MARKER = new RegExp(ESCAPE_START + String.raw`KM_ALLOW_BEAD_IDS=1\s`)
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

const ISSUE_REFS_OK = new RegExp(ESCAPE_START + String.raw`KM_ISSUE_REFS_OK=1\s`)
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
 * Message/body-file values for the ONE leg that still reads files
 * pre-publish: solo `git commit -F/--file` (commit text never becomes a
 * GitHub object). Blind publishes never read files — the coarse rule blocks
 * them until both escapes attest. A real flag sits OUTSIDE quotes,
 * so it must survive into the skeleton — a quoted mention ("use -F x next
 * time") is prose, and with the fail-closed missing-file check a prose
 * mention would block the command outright. Values are still extracted from
 * the raw text (quoted paths are blanked in the skeleton). Not full shell
 * parsing.
 */
const messageFileValues = cmd => {
  // Deliberately BROAD, and paired with the caller standing down whenever the
  // invocation also publishes (see the commit leg). Narrowing this instead —
  // git's own flags only, minus values holding an `=` — was tried and made
  // things worse: a filename containing `=` and a process substitution both
  // stopped being SEEN, turning two fail-closed cases into fail-open ones.
  // Anything unrecognized here must still resolve to a path that fails to
  // read, which blocks; a value that silently disappears does not. Only true
  // separators are kept out of the value, so a trailing `; …` is not glued
  // onto the filename — `<` is deliberately NOT excluded, so a process
  // substitution still resolves to an unreadable path and blocks instead of
  // vanishing.
  if (!/(?<![\w-])(?:--body-file|--file|-F)/.test(commandSkeleton(cmd))) return []
  return [...cmd.matchAll(/(?<![\w-])(?:--body-file|--file|-F)(?:=|\s+)?("[^"]*"|'[^']*'|[^\s'";&|]+)/g)].map(m =>
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
// A Map, not an object: a label may be named anything a human can type, and a
// plain object answers `constructor`, `__proto__` or `toString` with an
// inherited member rather than undefined — so `priority::constructor` would
// read as a real priority, and a bare `constructor` as a real type.
const PRIORITY_WORDS = ['critical', 'high', 'medium', 'low', 'none'] // index === bd priority
const PRIORITY_BY_WORD = new Map(PRIORITY_WORDS.map((word, priority) => [word, priority]))
export const deriveLabelPriority = labels => {
  for (const name of labels) {
    const m = name.match(/^priority::(\w+)$/i)
    if (m && PRIORITY_BY_WORD.has(m[1].toLowerCase())) return PRIORITY_BY_WORD.get(m[1].toLowerCase())
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

// ---- what bd's pull would write ----
// The pull overwrites a bead from its GitHub copy, and the decision to let it
// happen has to be made BEFORE it runs — so these replicate bd 1.2.2's
// GitHub→beads mapping (internal/github/mapping.go, unchanged in 1.3.0-rc.2).
// Both ways of being wrong are bounded: reading a divergence bd would not see
// costs one needless touch and push, and missing one leaves today's behaviour.
// bd splits a label on the FIRST `::`, compares the prefix case-sensitively
// and the value case-insensitively.
// A Map for the same reason as PRIORITY_WORDS above.
const TYPE_LABELS = new Map([
  ['bug', 'bug'],
  ['feature', 'feature'],
  ['enhancement', 'feature'],
  ['task', 'task'],
  ['epic', 'epic'],
  ['chore', 'chore'],
  ['decision', 'decision'],
  ['spike', 'spike'],
  ['story', 'story'],
  ['milestone', 'milestone'],
])
const SCOPED_PREFIXES = ['priority', 'status', 'type']
const splitLabel = name => {
  const i = name.indexOf('::')
  return i < 0 ? ['', name] : [name.slice(0, i), name.slice(i + 2)]
}
// Every label-derived field yields the SET of values the labels could produce,
// never one value: bd takes the FIRST match in GitHub's own label order, and
// the order this listing reports is not the order bd fetches. Two labels that
// map to different values therefore have no answer to rely on — which is not a
// corner case but the shape of the bug, since a bare `enhancement` is weighed
// exactly like a scoped `type::chore`.
const mappedValues = (labels, map) => {
  const values = new Set()
  for (const name of labels) {
    const [prefix, value] = splitLabel(name)
    const mapped = map(prefix, value.toLowerCase())
    if (mapped !== undefined) values.add(mapped)
  }
  return values
}
const pullTypes = labels => mappedValues(labels, (prefix, value) => (prefix === 'type' || prefix === '' ? TYPE_LABELS.get(value) : undefined))
const pullPriorities = labels => mappedValues(labels, (prefix, value) => (prefix === 'priority' ? PRIORITY_BY_WORD.get(value) : undefined))
const LABEL_STATUSES = ['in_progress', 'blocked', 'deferred']
const pullStatuses = (labels, state) =>
  state === 'CLOSED'
    ? new Set(['closed'])
    : mappedValues(labels, (prefix, value) => (prefix === 'status' && LABEL_STATUSES.includes(value) ? value : undefined))
const pullLabels = labels => labels.filter(name => !SCOPED_PREFIXES.includes(splitLabel(name)[0]))
// bd's label comparison: trimmed, empties dropped, deduplicated, sorted.
const normalizedLabels = labels => [...new Set((labels ?? []).map(l => l.trim()).filter(Boolean))].sort().join('\n')

/**
 * The label-derived fields: what the issue's labels could make of each, bd's
 * default when they make nothing of it, and the bead's own value. One owner
 * for all three — the rule below is the same rule everywhere, and the version
 * that had it only for the type let an ambiguous priority label read as
 * converged and let a claim be reverted to `open` unnoticed.
 */
const LABEL_FIELDS = [
  ['issue_type', (bead, issue) => [pullTypes(issue.labels), 'task', bead.issue_type]],
  ['priority', (bead, issue) => [pullPriorities(issue.labels), 2, bead.priority]],
  ['status', (bead, issue) => [pullStatuses(issue.labels, issue.state), 'open', bead.status]],
]

/**
 * What the pull would do to one label-derived field. Three ways to disagree,
 * and only two of them are losses:
 *   - `ambiguous`: two labels map to different values and bd takes whichever
 *     it reaches FIRST in GitHub's own order, which this listing's order does
 *     not predict. Unrestorable, because nothing here knows what got written.
 *   - `default`: no label states the value, so bd writes its own default over
 *     the bead's — the flattening guard (2) exists for, two fields wider.
 *   - `imports`: exactly one label, disagreeing with the bead. That is GitHub
 *     deliberately saying something, and carrying it over is what the pull is
 *     FOR. Defusing it would overwrite the edit with the stale local value, so
 *     a taxonomy edit could never reach beads at all.
 */
const labelVerdict = (bead, issue, read) => {
  const [values, fallback, mine] = read(bead, issue)
  if (values.size > 1) return 'ambiguous'
  if (values.size === 0) return mine === fallback ? 'agrees' : 'default'
  return values.has(mine) ? 'agrees' : 'imports'
}
const LOSING_VERDICTS = ['ambiguous', 'default']
const labelFieldsWhere = (bead, issue, keep) =>
  LABEL_FIELDS.filter(([, read]) => keep(labelVerdict(bead, issue, read))).map(([field]) => field)

/**
 * Whether a push would CHANGE the issue — bd 1.2.2 does not ask (it PATCHes on
 * the timestamp alone), so the wrapper asks on its behalf and spares the
 * tracker a PATCH that ships nothing. Only ever a THRIFT: a push that ships
 * nothing still moves the issue, which planPrePullPush needs whenever the pull
 * would write the bead, so this never decides that case on its own.
 * Mirrors bd's BeadsIssueToGitHubFields — title, body, open/closed, and the
 * whole label set, scoped labels derived from the bead plus its own.
 */
const pushedLabels = bead => [
  ...(bead.issue_type ? [`type::${bead.issue_type}`] : []),
  `priority::${PRIORITY_WORDS[bead.priority] ?? 'medium'}`,
  ...(LABEL_STATUSES.includes(bead.status) ? [`status::${bead.status}`] : []),
  ...(bead.labels ?? []),
]
const pushWouldChange = (bead, issue) =>
  bead.title !== issue.title ||
  (bead.description ?? '') !== (issue.body ?? '') ||
  (bead.status === 'closed') !== (issue.state === 'CLOSED') ||
  normalizedLabels(pushedLabels(bead)) !== normalizedLabels(issue.labels)

/** Whether bd's pull would write this bead at all (its pullIssueEqual, negated). */
export const pullWouldWrite = (bead, issue) =>
  bead.title !== issue.title ||
  (bead.description ?? '') !== (issue.body ?? '') ||
  (bead.assignee ?? '').trim() !== (issue.assignee ?? '').trim() ||
  normalizedLabels(bead.labels) !== normalizedLabels(pullLabels(issue.labels)) ||
  labelFieldsWhere(bead, issue, verdict => verdict !== 'agrees').length > 0

/**
 * Splits the linked beads into the ones the pull may be handed and the ones it
 * may not. A re-apply LOSES what GitHub does not carry back:
 *   - `closed_at`, restamped by the status write, with no bd verb to put it back
 *   - `assignee`, cleared because bd's push never sets a GitHub assignee
 *   - a label-derived field the labels do not uniquely spell (labelVerdict)
 * A bead with none of those is carried FAITHFULLY, and is exactly what the
 * bidirectional mirror is for, so it goes in the pull's id list.
 *
 * `overwrites` names the faithfully-carried fields that also diverge on a
 * bead being withheld — the push sends the local value over them. Nothing here
 * knows which side was edited last (no per-field history on either side, and
 * an issue timestamp moves for a comment as readily as an edit), so the report
 * names the divergence and a human decides; beads is the source of truth, so
 * the local value is what ships.
 */
export const planLossyReapplies = (beads, issueByNumber) =>
  beads.flatMap(b => {
    const number = issueNumberFromRef(b.external_ref)
    const issue = number === null ? undefined : issueByNumber.get(number)
    if (!issue || !pullWouldWrite(b, issue)) return []
    const losses = [
      ...(b.status === 'closed' && b.closed_at ? ['closed_at'] : []),
      ...((b.assignee ?? '').trim() && (b.assignee ?? '').trim() !== (issue.assignee ?? '').trim() ? ['assignee'] : []),
      ...labelFieldsWhere(b, issue, verdict => LOSING_VERDICTS.includes(verdict)),
    ]
    const overwrites = [
      ...(b.title !== issue.title ? ['title'] : []),
      ...((b.description ?? '') !== (issue.body ?? '') ? ['description'] : []),
      ...(normalizedLabels(b.labels) !== normalizedLabels(pullLabels(issue.labels)) ? ['labels'] : []),
      ...labelFieldsWhere(b, issue, verdict => verdict === 'imports'),
    ]
    return losses.length ? [{ id: b.id, number, losses, overwrites }] : []
  })

// Beads to hand the pre-pull push, skipping the two kinds bd would waste a
// GET on. bd 1.2.2 wires no content hook — its GitHub command sets PullHooks
// and never PushHooks, so doPush's ContentEqual is nil and it falls back to
// the timestamp rule: it GETs every linked bead and PATCHes whenever the local
// row is STRICTLY newer, content identical or not.
//   - GitHub is same-or-newer: bd would skip it anyway.
//   - the push would change nothing AND the pull would write nothing
//     (pullIssueEqual): bd would PATCH for no reason, re-stamping the issue.
// A content-identical push is NOT skippable when the pull would write, even
// though it ships no content — because of HYDRATION. bd's pull explicitly
// fetches every bead modified since last_sync whose issue the incremental
// query did not already return, and those bypass the "skip locally modified"
// guard (fetchPrelinkedIssues + prelinkedHydrateIDs; the ref-changed test
// falls back to `UpdatedAt.After(lastSync)` because the embedded Dolt store
// exposes no pooled *sql.DB). So the pull writes a bead exactly when ONE of
// the two sides moved since last_sync, and the push is what moves the issue
// so that BOTH did. That is #647's mechanism, and why this push cannot be
// optimized away on content alone.
// Everything the listing cannot prove bd would skip (no ref, a foreign ref, an
// issue missing from the listing, a missing timestamp) still goes to bd, which
// decides with a fresh GET as the full push did.
export const planPrePullPush = (beads, issueByNumber) =>
  beads
    .filter(b => {
      const issue = issueByNumber.get(issueNumberFromRef(b.external_ref))
      if (!issue) return true
      if (issue.updatedAt && b.updated_at && Date.parse(issue.updatedAt) >= Date.parse(b.updated_at)) return false
      return pushWouldChange(b, issue) || pullWouldWrite(b, issue)
    })
    .map(b => b.id)

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
      const issue = issueByNumber.get(issueNumberFromRef(b.external_ref))
      // A sole `priority::medium` MEANS 2. Restoring over it would revert a
      // deliberate GitHub-side edit — the mirror image of the flattening this
      // repairs, and indistinguishable from it by the post-pull value alone.
      const spelled = issue ? pullPriorities(issue.labels) : null
      if (spelled?.size === 1 && spelled.has(2)) return { id: b.id, to: null }
      const pre = preById.get(b.id)
      if (pre) return { id: b.id, to: pre.priority !== 2 ? pre.priority : null }
      return { id: b.id, to: issue ? deriveLabelPriority(issue.labels) : null }
    })
    .filter(({ to }) => to !== null && to !== 2)

// ---- comment mirror ----
// A mirrored comment opens with an HTML comment naming its bead comment id:
// invisible when rendered, and the only link between the two — bd keeps no
// per-comment external ref, so the issue's own bodies are the ledger of what
// has been mirrored, and re-running never duplicates. Only the OPENING
// position counts: a marker quoted mid-body (a human reply pasting raw
// markdown, a bead comment discussing one) is text.
const MIRROR_MARKER = /^<!--\s*bd-comment\s+([0-9a-f-]{36})\s*-->/
export const mirroredCommentIds = bodies => new Set(bodies.map(b => b.match(MIRROR_MARKER)?.[1]).filter(Boolean))

// Bead ids are opaque to a GitHub reader (AGENTS.md: public text carries issue
// numbers), so a mapped id is rewritten — code included, deliberately:
// nothing inside code links on GitHub either way, and sparing it needs a
// Markdown tokenizer whose edge cases (fences, spans, indented blocks, HTML)
// never end. What cannot be rewritten splits by whether waiting fixes it: an
// id in `holdIds` (a bead whose issue is still to be minted) resolves by
// itself, so the comment is held (`unmapped`); one matching no bead at all
// (a fixture in a quoted test line, a typo) or whose ref points at no issue
// never will, and a bead comment cannot be edited — so those go out and are
// reported (`leftover`), since the GitHub copy is the one a human can fix.
// Holding them would hide the whole comment for good.
export const rewriteBeadIds = (text, numberByBeadId, holdIds) => {
  const unmapped = new Set()
  const rewritten = text.replace(BEAD_ID, id => {
    if (numberByBeadId.has(id)) return `#${numberByBeadId.get(id)}`
    if (holdIds.has(id)) unmapped.add(id)
    return id
  })
  const leftover = [...new Set(rewritten.match(BEAD_ID) ?? [])].filter(id => !unmapped.has(id))
  return { text: rewritten, unmapped: [...unmapped], leftover }
}

// GitHub caps an issue comment at this many characters, and a bead comment
// can be as long. Cut deterministically and say so: an oversized body would
// fail its POST on every run and stall every later comment of the bead.
const GITHUB_COMMENT_MAX = 65_536
export const mirrorCommentBody = (comment, numberByBeadId, holdIds) => {
  const when = comment.created_at.replace(/^(\d{4}-\d\d-\d\d)T(\d\d:\d\d).*$/, '$1 $2 UTC')
  const { text, unmapped, leftover } = rewriteBeadIds(comment.text, numberByBeadId, holdIds)
  const head = `<!-- bd-comment ${comment.id} -->\n_Mirrored from a beads tracker comment of ${when}._\n\n`
  let body = head + text
  if (body.length > GITHUB_COMMENT_MAX) {
    const note = `\n\n_[cut by the mirror: the bead comment is ${text.length} characters, GitHub caps a comment at ${GITHUB_COMMENT_MAX}]_`
    body = head + text.slice(0, GITHUB_COMMENT_MAX - head.length - note.length) + note
  }
  return { body, unmapped, leftover }
}

export const planCommentMirror = (comments, mirrored) =>
  comments.filter(c => !mirrored.has(c.id)).sort((a, b) => a.created_at.localeCompare(b.created_at))

export const buildDenyMessage = (mapped, unmapped) => {
  const lines = [
    'BLOCKED: this text references bead ids (km-…), which GitHub readers cannot resolve.',
    'Reference the GitHub issue numbers instead:',
    ...mapped.map(({ id, number }) => `  ${id} → #${number} (https://github.com/${REPO}/issues/${number})`),
    ...(unmapped.length
      ? [
          `No GitHub issue found for: ${unmapped.join(', ')} — run \`pnpm bd:sync\` to mint one (it prints the km→#N mapping), or check \`bd show <id>\`. A real bead with no issue gets one on the next sync (every unlinked bead is pushed), so one that stays unlinked is failing to push — read the sync output; if the sync cannot run here, find the issue via \`gh issue list --search\`.`,
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

/** Bulk `bd` output grows with the tracker, so spawnSync's 1 MiB default is a
 *  ceiling every reader here crosses eventually — and crossing it aborts the
 *  whole sync with a bare `ENOBUFS` that names no command. Hence one ceiling on
 *  the shared helper, not on whichever call site crosses first. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024

const run = (file, args, opts = {}) => {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_OUTPUT_BYTES,
    ...opts,
  })
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
    // Scales with the request: `bd show` costs ~0.3s per id, and a failed
    // pre-pull snapshot ABORTS the whole sync — a fixed ceiling turns a
    // growing suspect set into a sync that stops working and stays stopped.
    timeout: Math.max(15_000, ids.length * 2_000),
    maxBuffer: MAX_OUTPUT_BYTES,
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
  const token = tryRun('gh', ['auth', 'token'], { timeout: PROBE_TIMEOUT })?.trim()
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
// One `bd export` carries every bead with its comments (id, text, time) in
// about a second, where `bd comments` costs a spawn per bead — and it lets
// the mirrored/pending split be exact, comment id by comment id.
const exportBeads = env =>
  run('bd', ['export'], { env: { ...env, BD_IGNORE_SCHEMA_SKEW: '1' } })
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .filter(r => r._type === 'issue')

// Every guard in this file is calibrated to ONE bd version's MEASURED
// behaviour: what the pull reaches and how, the push's timestamp rule, the
// close that only gh can carry. An upgrade moves them together and silently,
// and a wrong guess loses an assignee and a close date without reporting it.
// So an unverified bd REFUSES to sync rather than syncing on stale reasoning.
const VERIFIED_BD_VERSIONS = ['1.2.2']
// The WHOLE token, prerelease and build metadata included: `1.2.2-rc.1` is a
// different engine from `1.2.2` (the retracted 1.2.1 was one such), and
// truncating it would let an unmeasured build through the allowlist.
export const bdVersion = out => out?.match(/\bversion\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?)/i)?.[1] ?? null

const listAllBeads = () =>
  JSON.parse(run('bd', ['list', '--status', 'open,in_progress,blocked,deferred,closed', '--limit', '0', '--json']))

const FETCH_LIMIT = 5000
const fetchIssues = () => {
  const rows = JSON.parse(
    run('gh', [
      'issue',
      'list',
      '--repo',
      REPO,
      '--state',
      'all',
      // title/body/assignees are read only to say whether bd's pull would
      // rewrite a bead (planLossyReapplies) — the bodies triple the payload,
      // and the alternative is one GET per candidate.
      '--json',
      'number,state,labels,updatedAt,title,body,assignees',
      '--limit',
      String(FETCH_LIMIT),
    ]),
  )
  if (rows.length >= FETCH_LIMIT)
    throw new Error(`issue list hit the ${FETCH_LIMIT} fetch limit — raise it before trusting absence-based decisions`)
  // This repo can never legitimately have zero issues — an empty 200 is an
  // API blip or token-scope problem, and absence-based decisions downstream
  // (close-adoption finding nothing, close-pushes seeing everything absent)
  // would all be wrong at once.
  if (rows.length === 0) throw new Error('issue list came back empty — refusing absence-based decisions')
  return {
    issueByNumber: new Map(
      rows.map(i => [
        i.number,
        {
          state: i.state,
          labels: i.labels.map(l => l.name),
          updatedAt: i.updatedAt,
          title: i.title,
          body: i.body,
          // bd reads REST's singular `assignee`, which is the first of these.
          assignee: i.assignees?.[0]?.login ?? '',
        },
      ]),
    ),
    maxKnownIssueNumber: rows.reduce((max, i) => Math.max(max, i.number), 0),
  }
}

// One owner for "push these beads". bd takes the ids as a single --issues
// argument, which has a per-argument ceiling (128 KiB on Linux), so a large
// set is split across invocations instead of failing the spawn before bd
// starts. Returns the concatenated bd output.
// Issues to hand the pull, BY IDENTIFIER. That takes doPull's other branch:
// it fetches each issue by number, ignores `last_sync` entirely, and never
// hydrates — so a bulk pull's two ways of reaching a bead we are protecting
// (the incremental window, and fetchPrelinkedIssues bypassing the skip for a
// locally-modified row) are both out of reach, and there is no window to
// close. That is what lets the mirror stay bidirectional while a lossy
// re-apply stays impossible (#955).
//   - an issue with no bead yet: the GitHub→beads direction, where a
//     hand-filed issue becomes a bead.
//   - a bead the pull would carry faithfully: the edit import.
// A bead the pull would damage is simply never named, so it cannot be written.
export const planPullSet = (beads, issueByNumber, lossyIds) => {
  const linked = new Set()
  const faithful = []
  for (const b of beads) {
    const number = issueNumberFromRef(b.external_ref)
    if (number === null || !issueByNumber.has(number)) continue
    linked.add(number)
    if (!lossyIds.has(b.id) && pullWouldWrite(b, issueByNumber.get(number))) faithful.push(number)
  }
  const unlinked = [...issueByNumber.keys()].filter(n => !linked.has(n))
  return [...new Set([...unlinked, ...faithful])].sort((a, b) => a - b)
}

const PUSH_CHUNK = 200
// bd takes the ids as one --issues argument, so a large set is split the same
// way the push is. An EMPTY set must not fall through to a bulk pull, which is
// the whole class this avoids — it is simply not run.
const pullIssues = (numbers, env, dryRun) => {
  if (!numbers.length) return ''
  let out = ''
  for (let i = 0; i < numbers.length; i += PUSH_CHUNK)
    out +=
      run('bd', ['github', 'sync', '--pull-only', '--issues', numbers.slice(i, i + PUSH_CHUNK).join(','), ...(dryRun ? ['--dry-run'] : [])], {
        env,
      }) + '\n'
  return out
}

const pushBeads = (ids, env) => {
  let out = ''
  for (let i = 0; i < ids.length; i += PUSH_CHUNK)
    out += run('bd', ['github', 'sync', '--push-only', '--issues', ids.slice(i, i + PUSH_CHUNK).join(',')], { env }) + '\n'
  return out
}

// One GraphQL call per chunk reads the comment bodies of every commented
// bead's issue, so a converged run costs one request rather than one per
// issue; an issue past the first page costs one more query per page.
// `issue(number)` resolves a PR or a deleted issue to null — with a NOT_FOUND
// error and a non-zero gh exit that still carries the data, so the parse
// reads stdout and ignores the status. Returns number → { bodies } | null
// (not an issue).
const COMMENT_PAGE = 100
const GRAPHQL_CHUNK = 50
const [OWNER, NAME] = REPO.split('/')
const commentsField = after => `comments(first: ${COMMENT_PAGE}${after ? `, after: "${after}"` : ''}) { pageInfo { hasNextPage endCursor } nodes { body } }`
const graphqlRepository = (fields, env) => {
  const r = spawnSync('gh', ['api', 'graphql', '-f', `query=query { repository(owner: "${OWNER}", name: "${NAME}") { ${fields} } }`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_OUTPUT_BYTES,
    env,
  })
  let repo
  try {
    repo = JSON.parse(r.stdout).data.repository
  } catch {}
  if (!repo) throw new Error(`gh api graphql: ${(r.stderr || r.stdout || '').trim().slice(0, 300)}`)
  return repo
}
const fetchIssueComments = (numbers, env) => {
  const byNumber = new Map()
  for (let i = 0; i < numbers.length; i += GRAPHQL_CHUNK) {
    const chunk = numbers.slice(i, i + GRAPHQL_CHUNK)
    const repo = graphqlRepository(chunk.map(n => `i${n}: issue(number: ${n}) { ${commentsField()} }`).join(' '), env)
    for (const n of chunk) {
      const issue = repo[`i${n}`]
      if (!issue) {
        byNumber.set(n, null)
        continue
      }
      // Every page is read: a marker beyond the first would otherwise not
      // count, and a backfill that crosses the page boundary — which the
      // per-run post cap can produce — would re-post its oldest comments.
      const bodies = issue.comments.nodes.map(c => c.body)
      let page = issue.comments.pageInfo
      while (page.hasNextPage) {
        const more = graphqlRepository(`issue(number: ${n}) { ${commentsField(page.endCursor)} }`, env).issue
        if (!more) throw new Error(`issue #${n} vanished between comment pages`)
        bodies.push(...more.comments.nodes.map(c => c.body))
        page = more.comments.pageInfo
      }
      byNumber.set(n, { bodies })
    }
  }
  return byNumber
}

// Bead comments → issue comments, one way and append-only: bd 1.2.2's sync
// carries comments in neither direction (nothing in its GitHub client, mapper
// or tracker reads or writes them), so a mirrored comment never comes back as
// a new bead comment. The beads come from one `bd export` (exportBeads), so
// nothing is read per bead. Posts are paced under GitHub's
// content-creation limit (80/min), and a bead stops at its first failed post
// so the thread keeps bead order; the next run resumes where it stopped.
// Every failure is a report line, never a throw: a throw here would swallow
// the report of the steps before it.
//
// Accepted race: two clones syncing the same unmirrored comment inside one
// read-to-post window post it twice — the lock is per clone, and a duplicate
// is visible and deletable; a cross-device claim is more machinery than that
// warrants.
const POST_PAUSE_MS = 800
// Bounds one run under the SessionEnd hook's timeout (.claude/settings.json);
// the rest resumes next run. The env override exists for the process tests.
const POST_CAP = Number(process.env.KM_MIRROR_POST_CAP) || 60
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const mirrorComments = ({ beads, issueByNumber, mintedNumbers, skipIds, env, dryRun }) => {
  // A ref is trusted only where the run-start listing shows an issue, or
  // where this run's push minted it: a ref pointed at a PR or a deleted
  // issue would otherwise turn a bead id into a confidently wrong #N,
  // whether as a destination or a reference. PRs share the number sequence,
  // so a number beyond the listing's last proves nothing by itself.
  const isIssue = n => issueByNumber.has(n) || mintedNumbers.has(n)
  const numberByBeadId = new Map(beads.map(b => [b.id, issueNumberFromRef(b.external_ref)]).filter(([, n]) => n && isIssue(n)))
  const unmintedIds = new Set(beads.filter(b => !b.external_ref).map(b => b.id))
  const report = []
  const commented = []
  for (const b of beads) {
    if (!b.comments?.length) continue
    // skipIds: beads the restore left half-repaired — the touch would push
    // that row and bury the loss the push-back exclusion protects.
    if (skipIds.has(b.id)) report.push(`SKIPPED comments of ${b.id}: its restore failed this run — touching it would push the half-restored row`)
    else if (numberByBeadId.has(b.id)) commented.push(b)
    else if (b.external_ref) report.push(`SKIPPED comments of ${b.id}: its external_ref does not point at an issue of this repo (a PR, or deleted) — fix the ref`)
  }
  if (!commented.length) return { report }
  let ghComments
  try {
    ghComments = fetchIssueComments(commented.map(b => numberByBeadId.get(b.id)), env)
  } catch (e) {
    return { report: [...report, `FAILED to read GitHub comments (${e.message}) — comment mirror skipped this run`] }
  }
  let posts = 0
  for (const bead of commented) {
    if (posts >= POST_CAP) {
      report.push(`comment mirror stopped at ${POST_CAP} post(s) this run — the rest resumes next run`)
      break
    }
    const number = numberByBeadId.get(bead.id)
    const issue = ghComments.get(number)
    // Defence in depth behind isIssue: the listing is minutes old, and a
    // number minted this run is trusted unseen.
    if (!issue) {
      report.push(`SKIPPED comments of ${bead.id}: #${number} is not an issue (a PR, or deleted) — mis-pointed external_ref`)
      continue
    }
    // Exact, id by id: a marker-shaped comment that is not one of this bead's
    // comments (a pasted marker, two beads on one issue) counts for nothing.
    const pending = planCommentMirror(bead.comments, mirroredCommentIds(issue.bodies))
    if (!pending.length) continue
    // A bead stops at the first comment that cannot go (unpublishable, or a
    // failed post) so the thread keeps bead order; the rest wait for the next
    // run.
    const publishable = []
    for (const c of pending) {
      const { body, unmapped, leftover } = mirrorCommentBody(c, numberByBeadId, unmintedIds)
      if (unmapped.length) {
        report.push(`SKIPPED comment ${c.id} of ${bead.id}: it names bead(s) with no issue yet (${unmapped.join(', ')}) — ${pending.length - publishable.length} left for the next run`)
        break
      }
      publishable.push({ id: c.id, body, leftover })
    }
    if (!publishable.length) continue
    if (dryRun) {
      report.push(`[dry-run] would mirror ${publishable.length} comment(s) of ${bead.id} to #${number}`)
      continue
    }
    let posted = 0
    for (const { id, body, leftover } of publishable) {
      if (posts >= POST_CAP) break
      if (posts++) pause(POST_PAUSE_MS)
      const ok =
        tryRun('gh', ['api', '-X', 'POST', `repos/${REPO}/issues/${number}/comments`, '--input', '-'], {
          env,
          input: JSON.stringify({ body }),
          stdio: ['pipe', 'pipe', 'pipe'],
        }) !== null
      if (!ok) {
        report.push(`FAILED to mirror comment ${id} of ${bead.id} to #${number} — ${pending.length - posted} left for the next run`)
        break
      }
      posted++
      // The body is on GitHub now, which is the only copy anyone can edit —
      // so this is a report, not a refusal (see rewriteBeadIds).
      if (leftover.length)
        report.push(`posted comment ${id} of ${bead.id} to #${number} with bead id(s) it could not resolve (${leftover.join(', ')}) — in code, or unknown here; edit the GitHub comment if they should read as issue numbers`)
    }
    const capped = posted < publishable.length && posts >= POST_CAP
    if (posted) report.push(`mirrored ${posted} comment(s) of ${bead.id} to #${number}${capped ? ` — ${publishable.length - posted} left for the next run (post cap)` : ''}`)
  }
  return { report }
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

  const version = bdVersion(tryRun('bd', ['--version'], { env, timeout: PROBE_TIMEOUT }))
  // Exactly '1', like the two hook escapes, which match a literal `=1`:
  // read for truthiness, `KM_BD_VERSION_OK=0` would turn the refusal OFF.
  if (process.env.KM_BD_VERSION_OK !== '1' && !VERIFIED_BD_VERSIONS.includes(version))
    throw new Error(
      `refusing to sync: these guards were verified against bd ${VERIFIED_BD_VERSIONS.join(', ')}, and bd reports ` +
        `${version ?? 'a version this could not read'}. Re-verify them against the new engine before syncing (the bd ` +
        `upgrade issue carries the checklist), then add the version here. KM_BD_VERSION_OK=1 proceeds anyway.`,
    )

  const result = withLock(pre.root, () => {
    const { issueByNumber, maxKnownIssueNumber } = fetchIssues()
    const preBeads = listAllBeads()
    const report = []
    // The km→#N mapping for every issue this run's push minted. Printed
    // IMMEDIATELY, not via the end-of-run report: any later step failing
    // would swallow the report, and by the next run the bead already carries
    // its ref, so the mapping would never be printed at all.
    const printMinted = post => {
      for (const { id, number } of planMintedRefs(preBeads, post)) console.log(`bd-github-sync: minted: ${id} → #${number}`)
    }

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

    // 1.2 Decide what the pull may touch. A bead whose re-apply would lose
    // something is simply WITHHELD from the pull's id list (planLossyReapplies
    // names it and why); everything else — an issue with no bead, and a bead
    // the pull would carry faithfully — is handed to it by identifier, so the
    // mirror stays bidirectional. No touching, no forced push, no timestamps:
    // the pull cannot reach what it is not given.
    // `bd export` rather than the listing: only it carries assignee, labels
    // and closed_at, and it is one read for the whole tracker either way. Read
    // after close-adoption, so it already reflects the closes.
    const exported = exportBeads(env)
    const withheld = planLossyReapplies(exported, issueByNumber)
    // Reported, but never counted as news: withholding changes nothing on
    // either side and recurs for as long as the divergence does, so letting it
    // answer "did anything change" would un-quiet every SessionEnd run.
    const routine = new Set()
    const pullSet = planPullSet(exported, issueByNumber, new Set(withheld.map(w => w.id)))
    for (const { id, number, losses, overwrites } of withheld) {
      const line =
        `withheld ${id} (#${number}) from the pull: it would lose ${losses.join(', ')} (#955)` +
        (overwrites.length
          ? `; its ${overwrites.join(', ')} also differ(s) on GitHub and the next push sends the local value — compare them by hand`
          : '')
      // Only the content-identical withhold is routine. One that also names a
      // GitHub-side divergence is the warning that makes the trade visible —
      // a later push sends the local value over it — so it must survive --quiet.
      if (!overwrites.length) routine.add(line)
      report.push(line)
    }

    // 1.5 Push local state out BEFORE anything pulls. bd's pull applies a
    // strictly OLDER GitHub copy over newer local rows (#647) — closes and
    // edits included — so the pull must never see a GitHub copy that lags
    // local. Runs after close-adoption (an un-adopted open bead would
    // re-open its GitHub-closed issue). Handed only the beads bd could update
    // (planPrePullPush) — listed AFTER close-adoption, since a close bumps
    // updated_at and the pre-adoption row would look converged.
    // EXPORT rows, not a listing: `bd list` carries neither assignee nor
    // labels. `exported` was read after close-adoption, so the closes are in
    // it; a dry run makes no closes, so the rows it would have bumped are
    // added by hand.
    const dryRunBumped = dryRun ? closes.map(c => c.id) : []
    const pushSet = [...new Set([...planPrePullPush(exported, issueByNumber), ...dryRunBumped])]
    if (dryRun) {
      report.push(`[dry-run] would push ${pushSet.length} bead(s) out before the pull${pushSet.length ? `: ${pushSet.join(', ')}` : ''}`)
    } else if (pushSet.length) {
      let pushOut
      try {
        pushOut = pushBeads(pushSet, env)
      } catch (e) {
        // A failed push may still have minted issues (an earlier chunk, or bd
        // aborting midway) — print their mapping from a fresh listing before
        // the failure propagates; the listing's own failure yields to it.
        try {
          printMinted(listAllBeads())
        } catch {
          // Silence here would be a permanent loss, not a skipped nicety: any
          // mapping this push minted is unrecoverable once the next run's
          // listing shows the ref as pre-existing.
          console.error('bd-github-sync: could not re-list beads — any km→#N mapping this push minted is unprinted')
        }
        throw e
      }
      // Zero-count lines stay out of the report: they would flip `changed`
      // below and un-quiet every converged SessionEnd run.
      report.push(...pushOut.split('\n').filter(l => /Pushed|Created|Updated/.test(l) && /[1-9]/.test(l)).map(l => `pre-pull: ${l.trim()}`))
    }

    // 1.6 A push can leave a local-newer row unpushed (it failed, or bd's
    // strictly-newer test against the issue's updated_at, re-read at push
    // time, said no), so snapshot every bead whose local row is STILL newer
    // than its GitHub copy — the pull may revert exactly those; step 2.5
    // restores any it does. Fresh
    // list: the push just minted refs. Snapshot via a direct spawn, not
    // run(): `bd show` output is pretty-printed JSON, and a description line
    // starting with "Error" would trip run()'s bd check.
    const freshBeads = dryRun ? exported : listAllBeads()
    printMinted(freshBeads)
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

    // 2. The pull. Pull-only, not bidirectional: the push leg would GET every
    // linked bead again and could only PATCH rows step 1.5 just pushed (GitHub
    // is the newer side once it has), and the conflict pass keys off
    // last_sync, which that push just advanced — a second full-price no-op.
    const syncOut = pullIssues(pullSet, env, dryRun)
    const syncSummary = syncOut
      .split('\n')
      .filter(l => /Pulled|Pushed|Created|Updated|dry-run/.test(l))
      .map(l => l.trim())
    report.push(...syncSummary)

    // 2.5 Restore local rows the pull reverted anyway (#647 — 1.5's push
    // left them unpushed). The restore bumps updated_at, so the
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
    if (pushBack.length && !dryRun) pushBeads(pushBack, env)

    // 4. Carry bead closes out to issues still open (see header: via gh, not
    // a selective bd push, which skips a close once the issue was touched
    // after it).
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

    // 5. Mirror bead comments onto their issues (mirrorComments). It runs
    // after the push, because a post bumps the issue past the local row and bd
    // PATCHes only local-newer rows; and after the pull, so a GitHub-side edit
    // waiting on a bead is imported before the post.
    // The touch-push-repull dance this used to need is gone with the bulk
    // pull: a post cannot make the next run re-apply the issue onto its bead,
    // because the pull is only ever handed ids we chose (see 1.2 and guard 5).
    // Read fresh here, not from postBeads: this run's push may have minted the
    // external_refs the mirror resolves bead ids through, and postBeads is a
    // listing, which carries no comments.
    const mirror = mirrorComments({
      beads: exportBeads(env),
      issueByNumber,
      mintedNumbers: new Set(planMintedRefs(preBeads, freshBeads).map(m => m.number)),
      skipIds: failedRestoreIds,
      env,
      dryRun,
    })
    report.push(...mirror.report)

    // "Changed" means an action was reported — a close-push candidate that
    // turned out converged (silent continue above) must not un-quiet a run.
    const actionReported = report.some(l => !syncSummary.includes(l) && !routine.has(l))
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

// These stay `process.exit`: control-flow escapes from a nested call stack,
// with PreToolUse reading the code. Safe because truncation is a size
// question, not a stream one — measured on Linux node 26, one console.error
// survives to ~1200 lines, and a deny message is two orders under that. The
// sync path, which relays a whole run's mappings, is the one that converted.
const allow = () => process.exit(0)

// A path whose text this hook can actually read. A directory or an
// unreadable file must reach the caller's fail-closed branch rather than
// throwing out of the hook — see the entry point for why a throw here is
// worse than a block.
const readableFile = p => {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.R_OK)
    return true
  } catch {
    return false
  }
}

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

  // Message/body files, failing CLOSED on text this gate cannot see: a
  // stdin-fed body would need pipeline simulation (heredoc stdin passes — its
  // content sits in the raw command), and an unreadable file would carry its
  // references unverified. Called from ONE place: the commit leg, and only
  // when the invocation does not also publish.
  const guardedBodies = () => {
    if (hasStdinBody(cmd) && !cmd.includes('<<')) {
      console.error(
        'This command feeds commit text from stdin, which this gate cannot inspect. Use a heredoc (scanned), a file, or an inline flag — or, after verifying the references yourself, re-run with KM_ISSUE_REFS_OK=1 prefixed.',
      )
      process.exit(2)
    }
    const paths = bodyFilePaths(cmd).map(p => resolveBodyPath(p, cwd, homedir()))
    // Unreadable counts as missing: a directory or a permission error takes
    // the fail-closed branch below rather than throwing out of the hook.
    const missing = paths.filter(p => !readableFile(p))
    if (missing.length) {
      console.error(
        `Cannot read message file(s) referenced by this command: ${missing.join(', ')} (resolved from ${cwd}; cd chains inside the command are not followed).\n` +
          'Run from the directory the paths are relative to, inline the text, or — after verifying the references yourself — re-run with KM_ISSUE_REFS_OK=1 prefixed.',
      )
      process.exit(2)
    }
    return paths.map(p => readFileSync(p, 'utf8'))
  }

  // The legs below are INDEPENDENT — one invocation can both commit and
  // publish (`git commit -m "Fixes #N" && gh pr comment …`), and a publish
  // match must not swallow the commit check.

  // One flag, not two: every use below recombines them, and matchesPrCommand
  // is matchesAnyPublish's first disjunct — so splitting the api leg out again
  // would suggest a distinction the code does not make.
  const publishes = matchesAnyPublish(cmd)

  // Close keywords in commit messages act when the commit reaches the
  // default branch, and commit text never becomes a GitHub object — but the
  // file scan is command-wide, so when the invocation ALSO publishes, a
  // publish flag (an api field or a body-file) would be misread as a
  // commit-message path. In that case the commit leg scans the raw command
  // only; the files belong to the publish, which the verifier or the blind
  // rule owns. Residual: a commit's own -F file in such a compound goes
  // keyword-unchecked.
  const commitText =
    matchesCommitCommand(cmd) && !allowsIssueRefs(cmd)
      ? [cmd, ...(publishes || !commitsInCommandPosition(cmd) ? [] : guardedBodies())].join('\n')
      : ''
  const commitRefs = commitText ? closeKeywordRefs(commitText) : []

  if (!publishes) {
    if (commitRefs.length === 0) allow()
    return echoIssueRefs(commitText, commitRefs)
  }

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

  // Uncovered publishes keep the pre-publish checks: readable text gets the
  // refs/ids tables below, text living OUTSIDE the command blocks outright
  // (#683). The merge COMMIT of a merged PR is read back post-merge by
  // bd-publish-verify regardless. The coverage test itself is shared with
  // that hook (isPostVerifiable), which reports any claim it cannot honour.
  const blind = !isPostVerifiable(cmd)
  if (blind && !(allowsIssueRefs(cmd) && allowsBeadIds(cmd))) {
    // Any *file long flag (body-file, file, notes-file, …), --template and
    // --input carry text this gate cannot read, as do -F/-T (matched bare —
    // the CLI accepts ATTACHED values like -Fmsgfile) and an api @<path>.
    // All of them tested unconditionally: on `gh api` a -F is an inline
    // typed field rather than a file, but an inline api publish is COVERED
    // and never reaches this branch, so telling the two apart would only
    // matter for commands that are already attesting. Splitting them by
    // command kind is what let a compound mixing api with CLI read the
    // wrong signal.
    const textOutsideCommand =
      /(?<![\w-])--(?:[a-z-]*file|input|template)\b|@|(?<![\w-])-[FT]/.test(cmd) || hasExpansion(cmd)
    if (textOutsideCommand) {
      console.error(
        'This publish is not one the post-publication read-back covers (it must be a single gh command, with no shell operator, aimed at this repo, whose verb and flags leave a fetchable URL in the output) — and it carries text this gate cannot read from the command either: a file or payload flag, an @-reference, or shell expansion. Publish literal inline text so this gate can read it (a COVERED publish — a single create/edit/comment command with no shell operator — may use --body-file freely, since the read-back checks what it shipped) — or, after checking every reference and bead id in it yourself, re-run with KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 prefixed.',
      )
      process.exit(2)
    }
  }

  // Readable text of blind publishes gets the full pre-publish treatment:
  // #N refs echoed with their titles, bead ids denied with the km→#N table.
  // The two escapes stay independent: a command allowed to mention bead ids
  // can still carry a hallucinated issue number, and vice versa.
  const refs = [...new Set([...commitRefs, ...(blind && !allowsIssueRefs(cmd) ? extractIssueRefs(text) : [])])]
  const ids = allowsBeadIds(cmd) ? [] : extractBeadIds(text)
  if (ids.length === 0 && refs.length === 0) allow()
  const refsText = [blind ? text : '', commitText].filter(Boolean).join('\n') || text
  if (ids.length === 0) return echoIssueRefs(refsText, refs)

  // Looked up, never MINTED. The detectors deliberately over-match — a verb
  // in ordinary unquoted argv (`printf … gh pr create km-new`) reads as a
  // publish — and while an extra check costs a round, an extra MINT creates a
  // public issue for a command that is about to be blocked and never runs.
  // The block below already tells the agent to sync, which is how every bead
  // in this session got its number anyway.
  const byId = initializedDbRoot() ? beadIssueLookup(ids) : new Map()
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

if (isMainModule(import.meta.url)) {
  const args = new Set(process.argv.slice(2))
  if (args.has('--hook-pre-pr')) {
    try {
      hookPrePr()
    } catch {
      // The gate must never fail on its OWN bug. PreToolUse treats a non-zero
      // exit it did not ask for as a hook error: it prints the stack trace
      // into the agent's context and runs the command ANYWAY — so a throw
      // here is not a safe default, it disables every check while looking
      // like a problem with the command. Allowing explicitly reaches the same
      // outcome without the noise or the false impression that the text was
      // examined. Deliberate blocks exit(2) and never reach this.
      allow()
    }
  } else {
    try {
      runSync({ quiet: args.has('--quiet'), dryRun: args.has('--dry-run') })
    } catch (e) {
      console.error(`bd-github-sync: failed — ${e.message ?? e}`)
      // `exitCode`, never `exit()`: a failed push may still have minted issues,
      // and the km→#N mappings printed above are this run's only record of
      // them, but `exit()` drops whatever is still queued on a piped stdout.
      // Nothing holds the loop open here (spawnSync adds no handles), so the
      // process still ends promptly.
      process.exitCode = 1
    }
  }
}
