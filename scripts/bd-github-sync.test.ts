import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  allowsBeadIds,
  allowsIssueRefs,
  bodyFilePaths,
  buildDenyMessage,
  buildIssueRefsMessage,
  closeKeywordRefs,
  coveredMs,
  extractIssueRefs,
  foldRunLog,
  deriveLabelPriority,
  extractBeadIds,
  inPool,
  issueNumberFromRef,
  commitsInCommandPosition,
  matchesCommitCommand,
  matchesUnverifiableCommand,
  hasStdinBody,
  carriesPublishableText,
  isPostVerifiable,
  matchesAnyPublish,
  matchesApiPublish,
  matchesPrCommand,
  publishableKinds,
  mirrorCommentBody,
  mirroredCommentIds,
  planCommentMirror,
  planClosePushes,
  planCloseReconciliation,
  bdVersion,
  BUDGET_PER_MINT_OR_POST_MS,
  planLossyReapplies,
  pullWouldWrite,
  planPrePullPush,
  planPullSet,
  planUnlandedPushes,
  planMintedRefs,
  planPriorityFixes,
  REPO,
  resolveBodyPath,
  settleAll,
  spawnAsync,
  SYNC_RUN_LOG,
  syncAlarm,
  type BeadRow,
  type IssueInfo,
} from './bd-github-sync.mjs'
import { RESOLVE } from './hook-test-support'

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
    expect(extractBeadIds('vkm-abcd akm-defg wikm-1234')).toEqual([])
    expect(extractBeadIds('beads-github-sync-workflow km-')).toEqual([])
  })

  it('matches ids embedded in punctuation but not uppercase variants', () => {
    expect(extractBeadIds('(km-abcd), km-dt2e, km-defg.')).toEqual(['km-abcd', 'km-dt2e', 'km-defg'])
    expect(extractBeadIds('KM-ABCD')).toEqual([])
  })

  // bd sizes a hash id to the tracker (adaptive length, 4 up to 8), and
  // imports from GitHub carry a long timestamped form. Both are real ids.
  it('matches every length bd can mint, its kinds, and the long import form', () => {
    expect(extractBeadIds('km-7f3a8 km-7f3a86ab')).toEqual(['km-7f3a8', 'km-7f3a86ab'])
    expect(extractBeadIds('km-1786746045106-1-1eb9b300')).toEqual(['km-1786746045106-1-1eb9b300'])
    expect(extractBeadIds('km-wisp-abc123, km-mol-a1b2 and km-proto-9f8e7d')).toEqual(['km-wisp-abc123', 'km-mol-a1b2', 'km-proto-9f8e7d'])
  })

  it('does not read shorter or longer words as ids', () => {
    expect(extractBeadIds('km-abc km-db km-7f3a86abc')).toEqual([])
  })

  // No bd id continues with a hyphenated suffix, so a name built that way is
  // a file or a bin, not an id. Ids joined by a slash are still ids.
  it('does not read a word a hyphen continues as an id', () => {
    expect(extractBeadIds('--body-file tmp/km-a1b2-body.md; bin km-agent-dispatch; km-abcd-era')).toEqual([])
    expect(extractBeadIds('tracks km-abcd/km-efgh')).toEqual(['km-abcd', 'km-efgh'])
    expect(extractBeadIds('fixed km-abcd - and km-efgh.')).toEqual(['km-abcd', 'km-efgh'])
    expect(extractBeadIds('> /private/tmp/km-merge/threads.txt')).toEqual(['km-merge'])
  })

  it('takes a child id whole', () => {
    expect(extractBeadIds('see km-abcd.14, under km-abcd.')).toEqual(['km-abcd.14', 'km-abcd'])
    expect(extractBeadIds('and km-1786746045106-1-1eb9b300.2')).toEqual(['km-1786746045106-1-1eb9b300.2'])
    expect(extractBeadIds('km-abcd.14-notes.md')).toEqual([])
  })

  // A branch under an agent prefix names the branch, not a bead.
  it('does not match a branch under an agent prefix', () => {
    expect(extractBeadIds('--head claude/km-avrg-retain-measure')).toEqual([])
    expect(extractBeadIds('origin codex/km-abcd')).toEqual([])
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
    // shell control keywords open command positions too
    'if gh pr create --body "text"; then echo ok; fi',
    'if true; then gh pr create --body "text"; fi',
    'while true; do gh pr comment 1 -b x; done',
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

  // Heredoc bodies survive into the skeleton, so a line of DATA sits where a
  // command would. A detector may over-match there; a BYPASS may not.
  it('ignores a marker forged from heredoc data', () => {
    const forged = 'cat > n.md <<EOF\nKM_ALLOW_BEAD_IDS=1 is the prefix\nEOF\ngh pr merge 1 --body "km-abc"'
    expect(allowsBeadIds(forged)).toBe(false)
    expect(allowsIssueRefs(forged.replace('KM_ALLOW_BEAD_IDS', 'KM_ISSUE_REFS_OK'))).toBe(false)
  })

  // A heredoc body is data even when a markdown table cell sets the marker
  // off with pipes; a newline-separated command line is a real command.
  it('honors a marker on its own command line, never one in heredoc data', () => {
    const table = 'gh pr comment 5 --body-file - <<EOF\n| KM_ALLOW_BEAD_IDS=1 | x |\n| KM_ISSUE_REFS_OK=1 | y |\nEOF'
    expect(allowsBeadIds(table)).toBe(false)
    expect(allowsIssueRefs(table)).toBe(false)
    expect(allowsIssueRefs('cd /r\nKM_ISSUE_REFS_OK=1 gh pr merge 1 --body x')).toBe(true)
    // bash keeps a backslash before an ordinary character in double quotes,
    // so this sets the variable to \\1, not 1; a quoted 1 is still 1
    expect(allowsIssueRefs('KM_ISSUE_REFS_OK="\\1" gh pr merge 1 --body x')).toBe(false)
    expect(allowsBeadIds('KM_ALLOW_BEAD_IDS="\\1" gh pr merge 1 --body x')).toBe(false)
    expect(allowsIssueRefs('KM_ISSUE_REFS_OK="1" gh pr merge 1 --body x')).toBe(true)
    // a bare assignment prefixes no command, however many there are
    expect(allowsIssueRefs('KM_ISSUE_REFS_OK=1; gh pr merge 1 --body x')).toBe(false)
    expect(allowsIssueRefs('KM_ISSUE_REFS_OK=1 X=1; gh pr merge 1 --body x')).toBe(false)
  })

  it('ignores the marker quoted inside an argument (it would be published)', () => {
    expect(allowsBeadIds('gh pr create --body "mentions KM_ALLOW_BEAD_IDS=1 in prose"')).toBe(false)
    // quoted prose with a fake segment start must not smuggle the marker in
    expect(allowsBeadIds('gh pr create --body "prose; KM_ALLOW_BEAD_IDS=1 more"')).toBe(false)
    expect(allowsBeadIds('gh pr create --body "line one\nKM_ALLOW_BEAD_IDS=1 line two"')).toBe(false)
  })
})

// A verb the detectors cannot see is the ONE outcome with no backstop: the
// gate fast-exits and the read-back skips it too, so the text is examined by
// neither. Requiring a recognized command position could only be written as a
// list — of separators, keywords, wrapper commands — and an incomplete list
// fails in exactly that direction.
describe('carriesPublishableText', () => {
  // The coverage report is only worth firing for commands that publish TEXT,
  // and only its NAME says whether an api field carries any. Being wrong here
  // costs a note either way, never a write — so this is allowed to be a small
  // list, unlike the tests that decide coverage.
  it('reads an api field by its name and a CLI -F as a body file', () => {
    expect(carriesPublishableText('gh api repos/Stvad/knowledge-medium/issues/652/labels -F labels[]=bug')).toBe(false)
    // every payload-field spelling gh accepts, so a field is never MISSED and
    // then read as text-free — that suppresses the warning rather than adding
    // one, which is the direction that actually hurts
    expect(carriesPublishableText("gh api -X PUT repos/Stvad/knowledge-medium/contents/x --raw-field message='m'")).toBe(true)
    expect(carriesPublishableText('gh api repos/Stvad/knowledge-medium/issues/1/comments --field body=hi')).toBe(true)
    expect(carriesPublishableText('gh api -X PUT repos/Stvad/knowledge-medium/pulls/652/merge -f merge_method=squash')).toBe(false)
    // compound field names carry text as much as `body` does, and the merge
    // endpoint's keywords act the moment it answers — an exact-name list
    // would have to grow once per endpoint to keep up
    expect(
      carriesPublishableText("gh api -X PUT repos/Stvad/knowledge-medium/pulls/652/merge -f commit_title='t'"),
    ).toBe(true)
    expect(
      carriesPublishableText("gh api -X PUT repos/Stvad/knowledge-medium/pulls/652/merge -f commit_message='m'"),
    ).toBe(true)
    // the whole key=value may be quoted, which the skeleton blanks — a field
    // that VANISHES reads as "no text", suppressing the warning entirely
    expect(
      carriesPublishableText(`gh api -X PUT repos/Stvad/knowledge-medium/pulls/652/merge -f 'commit_title=t'`),
    ).toBe(true)
    expect(carriesPublishableText('gh api repos/Stvad/knowledge-medium/issues/1/comments -F body=hi')).toBe(true)
    expect(carriesPublishableText('gh pr comment 652 -F notes.md')).toBe(true)
    expect(carriesPublishableText('gh pr comment 652 --body hi')).toBe(true)
    expect(carriesPublishableText('gh pr comment 652 --delete-last')).toBe(false)
    // A create is text-bearing by its VERB, so every way gh can supply the
    // body with no flag naming it is covered without listing them.
    expect(carriesPublishableText('gh pr create --fill')).toBe(true)
    expect(carriesPublishableText('gh pr create --recover /tmp/failed.json')).toBe(true)
    expect(carriesPublishableText('gh issue create')).toBe(true)
    expect(carriesPublishableText('gh release create v1')).toBe(true)
    // an EDIT really can carry no text, so it keeps the flag list
    expect(carriesPublishableText('gh pr edit 652 --add-label ui')).toBe(false)
    // gh documents nested key[subkey]=value fields, and gist file content is
    // its own example; FIELD_ANY captures the bracketed name whole
    expect(carriesPublishableText(`gh api gists -f public=true -f 'files[a.md][content]=Fixes #700'`)).toBe(true)
  })
})

describe('graphql calls', () => {
  it('reads a document with no mutation as publishing nothing, for both hooks', () => {
    const read = `gh api graphql -f query='query($p:Int!){repository(owner:"o",name:"r"){pullRequest(number:$p){id}}}' -F p=5 --jq '.x | @sh'`
    expect(matchesApiPublish(read)).toBe(false)
    expect(matchesAnyPublish(read)).toBe(false)
    // an expanded variable cannot turn a read into a write
    expect(matchesAnyPublish(`for n in 1; do ${read.replace('-F p=5', '-F p="$n"')}; done`)).toBe(false)
  })

  // Shell quoting can split the keyword; the shell rejoins it for gh.
  it('finds a mutation keyword that shell quoting splits', () => {
    expect(matchesAnyPublish(`gh api graphql -f query='mut''ation{addComment(input:{body:"x"}){clientMutationId}}'`)).toBe(true)
    expect(matchesAnyPublish(`gh api graphql -f query=mu\\tation'{addComment(input:{body:"x"}){clientMutationId}}'`)).toBe(true)
    // the shell drops a backslash-newline, joining the keyword again
    expect(matchesAnyPublish(`gh api graphql -f query=muta\\\ntion'{addComment(input:{body:"x"}){clientMutationId}}'`)).toBe(true)
  })

  it('keeps a text-free mutation a publish, and uncovered', () => {
    const loop = `for t in a; do gh api graphql -f query='${RESOLVE}' -f t="$t"; done`
    expect(matchesAnyPublish(loop)).toBe(true)
    expect(isPostVerifiable(loop)).toBe(false)
  })
})

// A read publishes nothing wherever it sits: in a loop, a pipe, a
// substitution, beside a redirect. Each gh api call is judged by its own argv
// words, so an expansion that only continues a word, or one in another
// command, does not make it a publish. Shapes from blocked agent commands.
describe('gh api reads', () => {
  it.each([
    `for n in 449 466; do gh api -X GET "repos/${REPO}/issues/$n/timeline?per_page=100" --jq '.[] | .event' | tail -4; done`,
    `for id in 41 42; do gh api repos/${REPO}/pulls/comments/$id --jq '"\\(.path)\\n\\(.body)"' | head -20; done`,
    `gh api 'repos/${REPO}/contents/pr-preview?ref=gh-pages' --jq '.[].name' > $SP/dirs.txt; wc -l < $SP/dirs.txt`,
    `gh pr view 1347 --json state --jq .state; gh api repos/${REPO}/commits/$(gh pr view 1347 --json mergeCommit --jq .mergeCommit.oid) --jq '.parents | length'`,
    `r=$(gh api repos/${REPO}/pulls/1307/merge-async/abc --jq '.status'); echo "$r"`,
    `for t in $(gh api graphql -f query='{repository(owner:"Stvad",name:"knowledge-medium"){pullRequest(number:1115){reviewThreads(first:60){nodes{id isResolved}}}}}' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | .id'); do echo "$t"; done`,
    `for n in 1320 1325; do gh api graphql -f query="query { repository(owner:\\"Stvad\\", name:\\"knowledge-medium\\") { pullRequest(number:$n) { reviews(last: 3) { nodes { submittedAt } } } } }" --jq '.data'; done`,
    `gh pr checks 1332; gh pr diff 1332 | head; gh issue list --limit 5; gh api -X GET repos/${REPO}/pulls/1332/reviews -f per_page=100 | jq length`,
    `gh api repos/${REPO}/issues/1 2>&1 | tail -3`,
    // an expansion filling a value adds no flag
    `for c in 1 2; do gh api repos/${REPO}/pulls/comments/$c -H "Authorization: $T" --jq ".id == $c" -F per_page=$n -X GET; done`,
    `gh api -XGET repos/${REPO}/issues -fstate=$S`,
    `gh api repos/${REPO}/issues/1 >| $OUT`,
    `gh -X GET api rate_limit --jq .rate.limit`,
    `gh api -iXGET repos/${REPO}/issues -fstate=open`,
    `gh -iX GET api rate_limit --jq .rate.limit`,
    `gh api repos/${REPO}/pulls/1 --jq '{number,title}'`,
    // gh keeps the LAST method: a later GET makes the call a read
    `gh api -X PUT -X GET repos/${REPO}/pulls/1/merge -f 'commit_title=t'`,
    // a heredoc that only mentions a call reads as one, and one that reads
    `git commit -F - <<'EOF'\nReplace the hand-rolled gh api graphql loop\nEOF`,
    // a quoted heredoc's markdown backticks are text, not substitutions
    "python3 - <<'EOF'\nrep(\"use `gh api` with a `-f` field here\")\nEOF",
    // even after an apostrophe, which a line read as shell would open a quote on
    "cat > notes.md <<'EOF'\nDon't use `gh api` with a `-f` field\nEOF",
    // nor are a quoted heredoc's template literals, in source code that mentions a call
    "python3 - <<'EOF'\nconsole.log(`gh api graphql: ${verb}`)\nEOF",
  ])('is not a publish: %s', cmd => {
    expect(matchesAnyPublish(cmd)).toBe(false)
  })

  it.each([
    `for n in 1 2; do gh api repos/${REPO}/issues/$n/comments -f body="see #653"; done`,
    // a read beside a write does not vouch for the write
    `gh api repos/${REPO}/pulls/1/reviews --jq length; gh api repos/${REPO}/issues/1/comments -f body=hi`,
    `gh api -X GET repos/${REPO}/issues/1 && gh api -X POST repos/${REPO}/issues/1/comments`,
    // a word that STARTS with an expansion can be any flags at all
    `for u in a; do gh api $u; done`,
    `gh api "\${ARGS[@]}"`,
    `gh api repos/${REPO}/issues/1/comments $(printf -- '-f body=x')`,
    `gh api -X "$M" repos/${REPO}/issues/1`,
    // an expansion that completes a flag, or sits outside a value
    `flag=f; gh api repos/${REPO}/issues/1/comments -"$flag" body='see #653'`,
    `gh api repos/${REPO}/issues/1/comments --$kind body=x`,
    `gh api repos/${REPO}/issues/1/comments "$EXTRA"`,
    // a graphql document the gate cannot read could be a mutation
    `for q in a; do gh api graphql -f query="$Q"; done`,
    `gh api graphql -F query=@q.graphql | jq .`,
    `gh api graphql --input q.json | jq .`,
    // flags after a substitution or an fd redirect still belong to the call
    `gh api repos/${REPO}/issues/$(echo 1)/comments -f body=y`,
    `gh api repos/${REPO}/issues/1/comments 2>&1 -f body=y`,
    `gh api repos/${REPO}/issues/1/comments < <(printf x) -f body=y`,
    `gh api repos/${REPO}/issues/1/comments >| out -f body=y`,
    // an apostrophe in a comment or a $'…' string opens no quote
    `# Reply to the reviewer (it's fixed)\ngh api repos/${REPO}/pulls/1385/comments/123/replies -f body="tracked in km-abcd"`,
    `MSG=$'Don\\'t merge'\ngh api repos/${REPO}/issues/1/comments -f body="$MSG"`,
    // a comment's words are no flags of the call
    `gh api repos/${REPO}/issues/1/comments -f body=x # check after with -X GET`,
    // gh takes api's own flags ahead of the word api
    `gh -X POST -f body='see #653' api repos/${REPO}/issues/1/comments`,
    `gh -f body=x api repos/${REPO}/issues/1/comments`,
    // every spelling pflag reads: an `=` after a short flag, a short cluster
    `gh api graphql -F=query=@body.gql`,
    `gh api repos/${REPO}/issues/1/comments -iFbody='#123'`,
    `gh api repos/${REPO}/issues/1/comments -iF body=x`,
    `gh -iF body=x api repos/${REPO}/issues/1/comments`,
    // a shell reading a quoted heredoc anywhere on its line runs the data
    `cat <<'EOF' | bash\necho x;gh api repos/${REPO}/issues/1/comments -f body=y\nEOF`,
    // or one the line leaves open, to come after the data
    `cat <<'EOF' |\necho x;gh api repos/${REPO}/issues/1/comments -f body=y\nEOF\nbash`,
    // a redirection between a flag and its value is no value
    `gh api graphql -F > /tmp/out query=@doc.gql`,
    // and its target is no flag, even flag-shaped
    `gh api repos/${REPO}/issues/1/comments > -X -F body='#123'`,
    // bash ends a word at an unquoted `>`: what follows is where output goes
    `gh api -X POST repos/${REPO}/issues/1/comments -f body=x> -XGET`,
    // a word the shell turns into a flag: an ANSI-C escape, a brace list
    `gh api repos/${REPO}/issues/1/comments $'\\x2dF' body='#123'`,
    `gh api repos/${REPO}/issues/1/comments {-i,-Fbody=x}`,
    `gh api repos/${REPO}/issues/1/comments -{F,i}body=x`,
    `gh api -X GET repos/${REPO}/issues/1/comments {,}-XPOST -f body=x`,
    `gh api -X GET repos/${REPO}/issues/1/comments {{,}-XPOST,} -f body=x`,
    `gh api -X GET repos/${REPO}/issues/1/comments -f \${x}{,body=x,-XPOST}`,
    `gh api -X GET repos/${REPO}/issues/1/comments -f body=x --jq $'\\x2d'{,XPOST}`,
    // and a read token earlier in the argv does not make a mutation one
    `gh api -X GET -X PUT repos/${REPO}/pulls/1/merge -f 'commit_title=t'`,
    // heredoc data is one call per line: a later GET line does not make the post a read
    `bash <<'EOF'\ngh api repos/${REPO}/issues/1/comments -f body=x\ngh api repos/${REPO}/issues/1 --method GET\nEOF`,
    // a quoted heredoc's data is not expanded, but a shell reading it runs it
    `bash <<'EOF'\nx;gh api repos/${REPO}/issues/1/comments -f body=y\nEOF`,
    // and a script's string spanning lines is its own, not a quote that hides the call
    `bash <<'EOF'\necho 'a\nb'; gh api repos/${REPO}/issues/1/comments -f body=y\nEOF`,
    // an unquoted heredoc's backticks run
    "cat <<EOF\nposted: `gh api repos/Stvad/knowledge-medium/issues/1/comments -f body=y`\nEOF",
    // a call the reader swallows (here: an unterminated quote) still counts
    `echo \\#'\ngh api repos/${REPO}/issues/1/comments -f body=y`,
    // an escaped `>` is text, and the `|` after it a pipe into the call
    `echo \\>|gh api repos/${REPO}/issues/1/comments -f body=y`,
    // a quoted ">" argument is no redirect, so the flag after it still counts
    `gh api repos/${REPO}/issues/1/comments ">" -f body=y`,
    // a method-like word another flag takes as its value is text
    `gh api -X POST repos/${REPO}/issues/1/comments -f body=y --template --method=GET`,
    // heredoc data that bash runs is a call
    `bash <<'EOF'\ngh api repos/${REPO}/issues/1/comments -f body=y\nEOF`,
  ])('is still a publish: %s', cmd => {
    expect(matchesAnyPublish(cmd)).toBe(true)
  })
})

// The repo's own review-reply command: one invocation whose output is the
// reply's URL, so the read-back covers it like a single gh publish.
describe('the pr:reply command', () => {
  it('is a covered publish of a review comment when run bare', () => {
    for (const cmd of ['pnpm pr:reply 1048 4040271733 body.md', 'node scripts/pr-reply.mjs 1048 4040271733 body.md']) {
      expect(matchesAnyPublish(cmd), cmd).toBe(true)
      expect(isPostVerifiable(cmd), cmd).toBe(true)
      expect(carriesPublishableText(cmd), cmd).toBe(true)
      expect([...publishableKinds(cmd)], cmd).toEqual(['review-comment'])
    }
    expect(isPostVerifiable('cd x; pnpm pr:reply 1048 4040271733 body.md')).toBe(false)
    expect(matchesAnyPublish("# it's posted below\npnpm pr:reply 1048 4040271733 body.md")).toBe(true)
  })

  // Its gh call runs where no hook sees it, so every spelling of the
  // invocation must be seen here.
  it('is seen however the invocation is spelled', () => {
    for (const cmd of [
      'pnpm "pr:reply" 1048 4040271733 body.md',
      'npm run pr:reply -- 1048 4040271733 body.md',
      'node "scripts/pr-reply.mjs" 1048 4040271733 body.md',
      'cd scripts && node pr-reply.mjs 1048 4040271733 body.md',
      'node "$(git rev-parse --show-toplevel)/scripts/pr-reply.mjs" 1048 4040271733 body.md',
      'KM_ALLOW_BEAD_IDS=1 pnpm pr:reply 1048 4040271733 body.md',
    ])
      expect(matchesAnyPublish(cmd), cmd).toBe(true)
  })

  it('is not read out of prose or from commands that only touch the file', () => {
    expect(matchesAnyPublish('git commit -m "use pnpm pr:reply for replies"')).toBe(false)
    expect(matchesAnyPublish('sed -n 1,20p scripts/pr-reply.mjs')).toBe(false)
    expect(matchesAnyPublish('pnpm vitest run scripts/pr-reply.test.ts')).toBe(false)
    expect(matchesAnyPublish('npx eslint scripts/pr-reply.mjs scripts/pr-reply.test.ts')).toBe(false)
    // a heredoc line is data, even one spelled like the invocation
    expect(matchesAnyPublish('cat > notes.md <<EOF\npnpm pr:reply 1 2 body.md\nEOF')).toBe(false)
    expect(matchesAnyPublish('pnpm exec prettier --check scripts/pr-reply.mjs')).toBe(false)
  })
})

// Naming THIS repository, or moving into a directory first, changes nothing
// the read-back depends on: it still finds the object in this repo's URLs.
describe('this repository and a leading cd', () => {
  it.each([
    'gh pr create --repo Stvad/knowledge-medium --base master --title t --body-file b.md',
    'gh pr edit 1368 --repo Stvad/knowledge-medium --body-file b.md',
    'gh -R Stvad/knowledge-medium pr comment 12 --body-file b.md',
    'gh pr comment 12 -RStvad/knowledge-medium --body-file b.md',
    'gh pr comment 12 --repo=stvad/Knowledge-Medium --body-file b.md',
    'gh pr comment 12 --repo "Stvad/knowledge-medium" --body-file b.md',
    'gh pr comment 12 -R https://github.com/Stvad/knowledge-medium --body-file b.md',
    'GH_REPO=Stvad/knowledge-medium gh pr comment 12 --body-file b.md',
    'cd /Users/x/wt && gh pr create --title t --body-file b.md',
    "cd '/Users/x/my wt' && pnpm pr:reply 1048 4040271733 body.md --resolve",
  ])('is covered: %s', cmd => {
    expect(isPostVerifiable(cmd)).toBe(true)
  })

  it.each([
    'gh pr comment 12 --repo Stvad/knowledge-medium-beads --body-file b.md',
    // the shell joins a quoted value to what follows it
    'gh pr comment 12 --repo "Stvad/knowledge-medium"-beads --body-file b.md',
    "gh pr comment 12 -R 'Stvad/knowledge-medium'x --body-file b.md",
    'gh pr comment 12 --repo Stvad/knowledge-medium --repo other/x --body-file b.md',
    'GH_REPO=other/x gh pr comment 12 --repo Stvad/knowledge-medium --body-file b.md',
    // another host: the read-back looks on github.com only
    'GH_HOST=ghe.example gh pr comment 12 -R Stvad/knowledge-medium --body-file b.md',
    'gh pr comment 12 -R ghe.example/Stvad/knowledge-medium --body-file b.md',
    'gh api --hostname ghe.example repos/Stvad/knowledge-medium/issues/1/comments -f body=x',
    // -q is --jq, which hides the object the read-back reads
    'gh api repos/Stvad/knowledge-medium/issues/1/comments -f body=x -q .html_url',
    'cd "$WT" && gh pr create --title t --body-file b.md',
    // a cd that fails still runs the publish after `;`, from somewhere else
    'cd x; gh pr create --title t --body-file b.md',
    'cd x && cd y && gh pr create --title t --body-file b.md',
    'cd x && gh pr create --title t --body-file b.md && echo done',
    'echo x && gh pr create --title t --body-file b.md',
  ])('stays uncovered: %s', cmd => {
    expect(isPostVerifiable(cmd)).toBe(false)
  })
})

describe('detectors see the verb wherever it sits', () => {
  it('sees indented, continued and wrapper-prefixed publishes', () => {
    for (const cmd of [
      '  gh pr create --title t --body b',
      'git push -u origin HEAD && \\\n  gh pr create --title t',
      'cd /tmp\n  gh pr create --title t',
      'timeout 60 gh pr create --title t',
      'sudo -u someone gh pr create --title t',
      'nohup gh pr create --title t',
    ])
      expect(matchesAnyPublish(cmd), cmd).toBe(true)
    expect(matchesCommitCommand('  git commit -m x')).toBe(true)
  })

  // An ESCAPED space means the `#` after it is an argument, not a comment, so
  // bash runs what follows the next separator. Comments are handled in the
  // same pass as quotes and escapes for exactly this reason — a sweep
  // afterwards cannot see that the space was spoken for, and deleted a real
  // publish along with the supposed comment.
  it('keeps a command that follows escaped hash text', () => {
    const q = String.fromCharCode(39)
    expect(matchesAnyPublish(`printf x \\ #literal; gh issue comment 1 --body ${q}hi${q}`)).toBe(true)
    // a genuine trailing comment still hides its verb
    expect(matchesAnyPublish('git commit -F msg # later: gh pr create')).toBe(false)
    // and a `#` inside a quoted body is neither
    expect(matchesAnyPublish(`gh pr comment 1 --body ${q}see #700${q}`)).toBe(true)
  })

  // The apostrophe trap commandSkeleton was written to avoid, which a second
  // naive quote-sweep reintroduced: two double-quoted arguments each holding
  // an apostrophe let those two pair, swallowing everything between them —
  // here a real expansion, which then hid the command from BOTH hooks.
  it('does not let apostrophes inside double-quoted args pair across an expansion', () => {
    const q = String.fromCharCode(39)
    const cmd = `gh api -H "X: can${q}t" \${FLAGS:--f body=x} -H "Y: won${q}t" repos/Stvad/knowledge-medium/issues/1/comments`
    expect(matchesAnyPublish(cmd)).toBe(true)
    // and it is uncovered, so its text is checked before it ships
    expect(isPostVerifiable(cmd)).toBe(false)
  })

  // A shell COMMENT is text bash never runs. This matters more than it looks:
  // the commit leg skips its message-file inspection when the invocation also
  // publishes, so a commented-out verb reading as a real publish would let a
  // close keyword inside that file through unchecked — over-matching fails
  // OPEN here rather than costing a round.
  it('does not read a commented-out verb as a publish', () => {
    expect(matchesAnyPublish('git commit -F msg # later: gh pr create')).toBe(false)
    expect(matchesAnyPublish('gh pr create --title t # not gh pr merge')).toBe(true)
    // a positional URL fragment is not a comment
    expect(matchesAnyPublish('gh pr comment https://github.com/o/r/pull/1#issuecomment-2 --body x')).toBe(true)
  })

  // What keeps prose out is commandSkeleton blanking quoted spans, not the
  // position test — so dropping the position test costs nothing here.
  it('still ignores a verb that only appears inside quoted prose', () => {
    expect(matchesUnverifiableCommand('git commit -m "gh pr merge 652 was the fix"')).toBe(false)
    expect(matchesUnverifiableCommand('gh pr comment 1 --body "will gh pr merge later"')).toBe(false)
    expect(matchesApiPublish('git commit -m "reply via gh api -X POST later"')).toBe(false)
    expect(matchesAnyPublish('echo "gh pr create --title t"')).toBe(false)
  })
})

describe('bodyFilePaths / resolveBodyPath', () => {
  // A path is not glued to the separator that follows it.
  it('does not swallow a separator into a message-file path', () => {
    expect(bodyFilePaths('git commit -F /tmp/a.txt; echo done')).toEqual(['/tmp/a.txt'])
    expect(bodyFilePaths('git commit -F /tmp/a.txt && echo done')).toEqual(['/tmp/a.txt'])
  })

  it('extracts plain, =-joined and quoted message-file paths', () => {
    expect(bodyFilePaths('git commit -F /tmp/a.txt')).toEqual(['/tmp/a.txt'])
    expect(bodyFilePaths('git commit --file=/tmp/b.txt')).toEqual(['/tmp/b.txt'])
    expect(bodyFilePaths(`git commit -F "/tmp/with space.txt" -F '/tmp/q.txt'`)).toEqual([
      '/tmp/with space.txt',
      '/tmp/q.txt',
    ])
    // Deliberately broad, with the caller standing down when the invocation
    // also publishes. Narrowing this instead was tried and lost two
    // fail-closed cases, so breadth plus the caller's guard wins.
    expect(bodyFilePaths('gh pr merge 12 --body-file /tmp/m.txt')).toEqual(['/tmp/m.txt'])
    // a filename may contain `=`, and a process substitution must resolve to
    // SOMETHING unreadable rather than vanishing
    expect(bodyFilePaths(`git commit -F 'msg=1.txt'`)).toEqual(['msg=1.txt'])
    expect(bodyFilePaths('git commit -F <(cat msg.txt)')).toEqual(['<(cat'])
  })

  it('skips the stdin sentinel and its device-path disguises', () => {
    expect(bodyFilePaths('git commit -F -')).toEqual([])
    expect(bodyFilePaths('git commit -F /dev/stdin')).toEqual([])
    expect(bodyFilePaths('git commit --file /dev/fd/3')).toEqual([])
  })

  it('handles ATTACHED short-option values without capturing mid-word', () => {
    expect(bodyFilePaths('git commit -Fmsg.txt')).toEqual(['msg.txt'])
    expect(hasStdinBody('cat x | git commit -F-')).toBe(true)
    // "-F" inside an ordinary word must not start a capture
    expect(bodyFilePaths('git commit -m x-File.txt')).toEqual([])
  })

  it('classifies stdin messages from RAW values — quoting the sentinel must not hide it', () => {
    expect(hasStdinBody('git commit -F "-"')).toBe(true)
    expect(hasStdinBody('git commit -F "/dev/stdin"')).toBe(true)
    expect(hasStdinBody('git commit -F -')).toBe(true)
    expect(hasStdinBody('git commit -F msg.txt')).toBe(false)
    expect(hasStdinBody('git commit -m "mentions -F - in prose"')).toBe(false)
  })

  // A real flag sits outside quotes: read a prose mention as a file
  // reference and the fail-closed missing-file check blocks the commit.
  it('ignores message-file flags that appear only inside quoted prose', () => {
    expect(bodyFilePaths('git commit -m "use -F msg.txt or --file x next time"')).toEqual([])
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

describe('deriveLabelPriority prototype safety', () => {
  it('does not take an Object.prototype member for a priority word', () => {
    for (const poison of ['constructor', 'toString', 'valueOf', 'hasOwnProperty'])
      expect(deriveLabelPriority([`priority::${poison}`])).toBeNull()
    expect(deriveLabelPriority(['priority::high'])).toBe(1)
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
  // The pull is never handed a linked bead whose priority it would default,
  // so a bead that existed before the run at 2 is 2 on purpose.
  it('leaves every bead that existed before the run alone', () => {
    const pre = byId([bead({ id: 'km-a', priority: 1, external_ref: ref(1) })])
    const post = [bead({ id: 'km-a', priority: 2, external_ref: ref(1) })]
    expect(planPriorityFixes(pre, post, issues([[1, { state: 'OPEN', labels: ['P1'] }]]))).toEqual([])
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
      bead({ id: 'km-new-medium', priority: 2, external_ref: ref(5) }), // machine label says 2 → leave
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
          [5, { state: 'OPEN', labels: ['priority::medium', 'P1'] }],
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

describe('matchesUnverifiableCommand', () => {
  it('matches merge, review, and close/reopen in command position, with global options and wrappers', () => {
    expect(matchesUnverifiableCommand('gh pr merge 652 --merge')).toBe(true)
    expect(matchesUnverifiableCommand('env GH_PAGER= gh -R Stvad/knowledge-medium pr merge 652')).toBe(true)
    expect(matchesUnverifiableCommand('git pull && gh pr merge 652 --squash --body "Fixes #1"')).toBe(true)
    expect(matchesUnverifiableCommand('gh pr review 5 --comment -b "looks wrong"')).toBe(true)
    // close/reopen success output names repo#N, never a URL — their -c
    // comments are unfindable post-hoc
    expect(matchesUnverifiableCommand('gh issue close 12 -c "done"')).toBe(true)
    expect(matchesUnverifiableCommand('gh pr reopen 12 -c "still broken"')).toBe(true)
  })

  it('ignores other publishes and quoted prose', () => {
    expect(matchesUnverifiableCommand('gh pr create --title t --body b')).toBe(false)
    expect(matchesUnverifiableCommand('gh pr comment 652 --body "will gh pr merge later"')).toBe(false)
    expect(matchesUnverifiableCommand('git commit -m "gh pr merge 652 was the fix"')).toBe(false)
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

// The detector above over-matches on purpose. This is the evidence the FILE
// READ needs on top of it, because over-matching there opens a path named in
// argv rather than costing an echo round.
// Bash's `!` inverts the pipeline's status, so the tool reports success for a
// failed publish and failure for a live one — and which post-hook event fires
// with it. The read-back reasons from that event and cannot check it, so the
// shape has to stay uncovered and take the pre-publish check instead.
describe('isPostVerifiable and the negating reserved word', () => {
  it('treats a negated publish as uncovered, and leaves quoted exclamations alone', () => {
    expect(isPostVerifiable('! gh pr create --body x')).toBe(false)
    expect(isPostVerifiable('gh pr create --body x')).toBe(true)
    // the skeleton blanks quoted spans, so ordinary prose still qualifies
    expect(isPostVerifiable('gh pr comment 1 --body "Fixed it!"')).toBe(true)
    expect(isPostVerifiable(`gh pr comment 1 --body 'Nice!'`)).toBe(true)
  })
})

describe('commitsInCommandPosition', () => {
  it('requires git commit to be the segment-s verb, not merely present in argv', () => {
    expect(commitsInCommandPosition('git commit -F msg.txt')).toBe(true)
    expect(commitsInCommandPosition('cd repo && git commit -F msg.txt')).toBe(true)
    // the whole point: these run printf and echo, and name no message file
    expect(commitsInCommandPosition(`printf '%s' git commit -F .env`)).toBe(false)
    expect(commitsInCommandPosition('echo git commit -F secrets.txt')).toBe(false)
  })

  it('sees the real verb through paths, assignments, wrappers and options', () => {
    expect(commitsInCommandPosition('/usr/bin/git commit -F m')).toBe(true)
    expect(commitsInCommandPosition('FOO=1 git commit -F m')).toBe(true)
    expect(commitsInCommandPosition('env FOO=1 git commit -F m')).toBe(true)
    expect(commitsInCommandPosition('git -C /r commit -F m')).toBe(true)
    expect(commitsInCommandPosition('git log -F x')).toBe(false)
  })

  // A wrapper's own OPTIONS decide whether it execs at all: `command -v`
  // prints a description and runs nothing. Since this check authorizes a file
  // read, the skip stops at the first option — refusing the -v form, and
  // accepting that a wrapper with options leaves one message file unscanned.
  it('stops the prefix skip at a wrapper option rather than guessing its arity', () => {
    expect(commitsInCommandPosition(`command -v git commit -F .env`)).toBe(false)
    expect(commitsInCommandPosition('env -u FOO git commit -F m')).toBe(false)
    expect(commitsInCommandPosition('xargs -n1 git commit -F m')).toBe(false)
  })

  // A heredoc body sits at a segment boundary but is DATA. It reaches the
  // skeleton, so the detector sees it; nothing may read a file it names.
  it('does not accept a heredoc body as a command position', () => {
    expect(commitsInCommandPosition("cat <<'EOF'\ngit commit -F .env\nEOF")).toBe(false)
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

describe('pullWouldWrite', () => {
  // A converged pair: bd's pull skips these, so every case below moves ONE
  // field and nothing else.
  const local = bead({ title: 'T', description: 'D', priority: 1, status: 'open', issue_type: 'task', labels: ['ui'] })
  const remote: IssueInfo = { state: 'OPEN', labels: ['priority::high', 'type::task', 'ui'], title: 'T', body: 'D', assignee: '' }

  it('is false for a converged pair — the touch a comment leaves changes no mapped field', () => {
    expect(pullWouldWrite(local, remote)).toBe(false)
  })

  it('sees each mapped field move', () => {
    expect(pullWouldWrite({ ...local, title: 'other' }, remote)).toBe(true)
    expect(pullWouldWrite({ ...local, description: 'other' }, remote)).toBe(true)
    expect(pullWouldWrite({ ...local, status: 'closed' }, remote)).toBe(true)
    expect(pullWouldWrite({ ...local, assignee: 'Someone' }, remote)).toBe(true)
    expect(pullWouldWrite({ ...local, labels: ['ui', 'perf'] }, remote)).toBe(true)
    expect(pullWouldWrite(local, { ...remote, state: 'CLOSED' })).toBe(true)
  })

  it('treats two labels mapping a field differently as a write, whichever one bd would reach first', () => {
    expect(pullWouldWrite(local, { ...remote, labels: ['priority::high', 'priority::low', 'type::task', 'ui'] })).toBe(true)
    expect(pullWouldWrite({ ...local, status: 'blocked' }, { ...remote, labels: [...remote.labels, 'status::blocked', 'status::deferred'] })).toBe(true)
  })

  it('reads priority from the machine label only — a bare P1 is not one, unlike deriveLabelPriority', () => {
    expect(pullWouldWrite(local, { ...remote, labels: ['type::task', 'ui', 'P1'] })).toBe(true)
    expect(pullWouldWrite({ ...local, priority: 2, labels: ['ui', 'P1'] }, { ...remote, labels: ['type::task', 'ui', 'P1'] })).toBe(false)
  })

  it('takes a status label over the open state, and ignores it for a closed issue', () => {
    expect(pullWouldWrite({ ...local, status: 'blocked' }, { ...remote, labels: [...remote.labels, 'status::blocked'] })).toBe(false)
    expect(pullWouldWrite({ ...local, status: 'closed' }, { ...remote, state: 'CLOSED', labels: [...remote.labels, 'status::blocked'] })).toBe(false)
  })

  it('counts the type as moved unless the labels spell exactly one, the bead’s own', () => {
    expect(pullWouldWrite({ ...local, issue_type: 'chore' }, { ...remote, labels: ['priority::high', 'type::chore', 'ui'] })).toBe(false)
    // `enhancement` and `type::chore` both map, so which one bd picks is a
    // question of GitHub's label order — never an answer this can rely on.
    expect(pullWouldWrite({ ...local, issue_type: 'chore' }, { ...remote, labels: ['priority::high', 'type::chore', 'enhancement'] })).toBe(true)
  })

  // A label is whatever a human typed. Read through a plain object, one named
  // `constructor` or `__proto__` answers with an inherited member instead of
  // undefined — so it would read as a real type or priority, turn the field
  // ambiguous, and defuse a bead whose GitHub-side edit the pull should have
  // imported.
  it('does not read an Object.prototype member as a label mapping', () => {
    for (const poison of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      // Carried on BOTH sides, so the label sets agree and the only question
      // left is whether the name reads as a type.
      const carried = { ...local, labels: [...(local.labels ?? []), poison] }
      expect(pullWouldWrite(carried, { ...remote, labels: [...remote.labels, poison] })).toBe(false)
      // Scoped spellings are dropped from the label comparison outright, so
      // these ask the mapping question on their own.
      expect(pullWouldWrite(local, { ...remote, labels: [...remote.labels, `type::${poison}`] })).toBe(false)
      expect(pullWouldWrite(local, { ...remote, labels: [...remote.labels, `priority::${poison}`] })).toBe(false)
    }
  })

  // gh rewrites control characters in every API response to caret notation,
  // while bd reads the API raw: a bead holding CI output with ANSI colours
  // never matched its own listing, and was handed to the pull every run.
  it('compares text as gh prints it, so a control character is no divergence', () => {
    const ansi = '\x1b[41m FAIL \x1b[49m'
    expect(pullWouldWrite({ ...local, description: ansi }, { ...remote, body: '^[[41m FAIL ^[[49m' })).toBe(false)
    expect(pullWouldWrite({ ...local, title: 'bell\x07 csi\x9b fs\x1c' }, { ...remote, title: 'bell^G csi^[ fs^\\' })).toBe(false)
    // GitHub writes \b and \f as short escapes, which the sanitizer does not
    // match; tab, newline, \v, \r and DEL it leaves alone.
    const kept = 'a\bb\fc\td\ne\vf\rg\x7fh'
    expect(pullWouldWrite({ ...local, description: kept }, { ...remote, body: kept })).toBe(false)
    expect(pullWouldWrite({ ...local, description: ansi }, { ...remote, body: '^[[41m FAIL ^[[49m, edited' })).toBe(true)
  })

  it('compares labels as bd does: scoped ones dropped, trimmed, deduplicated, order-free', () => {
    expect(pullWouldWrite({ ...local, labels: [' ui ', 'ui', ''] }, remote)).toBe(false)
    expect(pullWouldWrite({ ...local, labels: ['b', 'a'] }, { ...remote, labels: ['type::task', 'priority::high', 'a', 'b'] })).toBe(false)
  })
})

// The run log reports time the run SPENT on a verb, so eight concurrent reads
// of one second each are one second, not eight.
describe('coveredMs', () => {
  it('counts overlapping and nested intervals once, and gaps not at all', () => {
    expect(coveredMs([[0, 10], [2, 5], [5, 12], [20, 25]])).toBe(17)
    expect(coveredMs([[20, 25], [0, 10]])).toBe(15)
    expect(coveredMs([])).toBe(0)
  })
})

describe('inPool', () => {
  // The comment read runs its chunks through this, so a tracker with thousands
  // of commented issues still has at most `width` requests in flight.
  it('runs every item, never more than width at once', async () => {
    let inFlight = 0
    let peak = 0
    const seen: number[] = []
    await inPool(Array.from({ length: 20 }, (_, i) => i), 8, async i => {
      peak = Math.max(peak, ++inFlight)
      await new Promise(resolve => setImmediate(resolve))
      seen.push(i)
      inFlight--
    })
    expect(peak).toBe(8)
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i))
  })

  // Every chunk is a child process: rejecting while siblings still run would
  // let them outlive the lock and the run's timing record.
  it('starts nothing after a failure, and rejects only once every started item has settled', async () => {
    let inFlight = 0
    const started: number[] = []
    const tick = () => new Promise(resolve => setImmediate(resolve))
    const pool = inPool(Array.from({ length: 20 }, (_, i) => i), 4, async i => {
      started.push(i)
      inFlight++
      try {
        await tick()
        if (i === 1) throw new Error('chunk 1 failed')
        await tick()
        await tick()
      } finally {
        inFlight--
      }
    })
    await expect(pool).rejects.toThrow('chunk 1 failed')
    expect(inFlight).toBe(0)
    expect(started).toEqual([0, 1, 2, 3])
  })
})

describe('settleAll', () => {
  it('waits for every promise before rejecting with the first failure', async () => {
    let slowDone = false
    const slow = new Promise(resolve => setTimeout(() => resolve((slowDone = true)), 20))
    await expect(settleAll([Promise.reject(new Error('fast failure')), slow])).rejects.toThrow('fast failure')
    expect(slowDone).toBe(true)
    await expect(settleAll([Promise.resolve(1), Promise.resolve('two')])).resolves.toEqual([1, 'two'])
  })
})

describe('spawnAsync', () => {
  const print = (n: number) => [process.execPath, ['-e', `process.stdout.write('x'.repeat(${n}))`]] as const

  // The same ceiling spawnSync's maxBuffer gives the sync readers: past it the
  // child is killed and the result is an error, never an unbounded string.
  // The child here never exits on its own, so only the kill settles it.
  it('kills a child whose output crosses maxBuffer, and reports it as an error', async () => {
    const endless = [process.execPath, ['-e', `setInterval(() => process.stdout.write('x'.repeat(1000)), 5)`]] as const
    const r = await spawnAsync(...endless, { maxBuffer: 100 })
    expect(r.error?.message).toContain('exceeded 100 bytes')
    expect(r.stdout.length).toBeLessThanOrEqual(100)
  })

  it('returns output under the ceiling whole', async () => {
    const r = await spawnAsync(...print(10_000), { maxBuffer: 20_000 })
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(0)
    expect(r.stdout).toHaveLength(10_000)
  })
})

describe('foldRunLog', () => {
  const NOW = Date.parse('2026-09-27T12:00:00Z')
  const start = (id: string, pid = 4242, at = '2026-09-27T11:59:00Z') => JSON.stringify({ id, event: 'start', pid, at, budgetMs: 15_000 })
  const end = (id: string, over: object = {}) => JSON.stringify({ id, event: 'end', at: `at-${id}`, ms: 3_000, idleMs: 0, ok: true, budgetMs: 15_000, spawns: [], ...over })
  const dead = () => false
  const alive = () => true

  // Runs in several worktrees start outside the sync lock and take it in
  // another order; each start pairs with its own end, in the order they ended.
  it('pairs each start with its own end, in the order the runs ended', () => {
    const text = [start('a'), start('b'), start('c'), end('b', { ms: 2 }), end('a', { ms: 1 }), end('c', { ms: 3 })].join('\n')
    expect(foldRunLog(text, dead, NOW).map(r => [r.id, r.ms])).toEqual([['b', 2], ['a', 1], ['c', 3]])
  })

  it('reads a start with no end as a run still going while its process lives, and as killed once it does not', () => {
    expect(foldRunLog(start('a'), alive, NOW)).toEqual([])
    expect(foldRunLog(start('a'), dead, NOW)).toMatchObject([{ id: 'a', ok: false, failure: expect.stringContaining('did not finish') }])
  })

  // A pid is not proof of life: pids are reused, and an orphan no init reaps
  // stays a zombie that reads as alive. Past the staleness bound the lock also
  // uses, a start with no end is a run that did not finish.
  it('reads a start past the staleness bound as a run that did not finish, whatever its pid says', () => {
    expect(foldRunLog(start('a', 4242, '2026-09-27T11:49:00Z'), alive, NOW)).toMatchObject([{ id: 'a', failure: expect.stringContaining('did not finish') }])
  })

  it('drops a run that never took the lock, and keeps an older build\'s id-less lines as runs', () => {
    const legacy = JSON.stringify({ at: 'old', ms: 1, ok: true, budgetMs: 15_000, spawns: [] })
    const text = [legacy, start('a'), JSON.stringify({ id: 'a', event: 'skipped' })].join('\n')
    expect(foldRunLog(text, dead).map(r => r.at)).toEqual(['old'])
  })
})

describe('syncAlarm', () => {
  const record = (over: object) =>
    JSON.stringify({ at: '2026-09-24T20:00:00.000Z', ms: 3_000, ok: true, budgetMs: 20_000, spawns: [], ...over })
  const slow = (ms: number) =>
    record({ ms, spawns: [{ cmd: 'bd show', calls: 2, ms: 20_300 }, { cmd: 'gh issue list', calls: 1, ms: 5_300 }] })

  it('warns when the last two runs both blew the budget, naming the slowest spawns of the latest', () => {
    const notice = syncAlarm([record({}), slow(35_900), slow(37_200)].join('\n') + '\n')
    expect(notice).toContain('last two runs took 35.9s and 37.2s against budgets of 20s and 20s')
    expect(notice).toContain('bd show ×2 20.3s, gh issue list 5.3s')
  })

  // One slow run is as often GitHub having a slow minute as a regression.
  it('stays quiet on a single slow run, and once a run is back under', () => {
    expect(syncAlarm([record({}), slow(37_200)].join('\n'))).toBe('')
    expect(syncAlarm([slow(35_900), slow(37_200), record({})].join('\n'))).toBe('')
    expect(syncAlarm(slow(37_200))).toBe('')
  })

  // A SessionStart that overlaps a sync still running must not read it as one
  // that failed.
  it('does not count a run that is still going', () => {
    const running = JSON.stringify({ id: 'r', event: 'start', pid: 4242, at: '2026-09-27T11:59:00Z', budgetMs: 20_000 })
    const failed = record({ ok: false, failure: 'network' })
    const now = Date.parse('2026-09-27T12:00:00Z')
    expect(syncAlarm([failed, running].join('\n'), () => true, now)).toBe('')
    expect(syncAlarm([failed, running].join('\n'), () => false, now)).toContain('failed its last two runs')
  })

  // A sync that cannot run at all is the loudest case, and the latest run says
  // which of the two the alarm is about.
  it('reports two failed runs as a failing sync, naming the latest reason', () => {
    const failed = (failure: string) => record({ ok: false, failure })
    const notice = syncAlarm([failed('network'), failed('refusing to sync: bd reports 1.3.0')].join('\n'))
    expect(notice).toContain('failed its last two runs')
    expect(notice).toContain('refusing to sync: bd reports 1.3.0')
    // A mixed pair says what each run was, not two failures.
    const failedAfterSlow = syncAlarm([slow(35_900), failed('network')].join('\n'))
    expect(failedAfterSlow).toContain('latest run failed')
    expect(failedAfterSlow).toContain('network, after one that took 35.9s against its 20s budget')
    const slowAfterFailed = syncAlarm([failed('network'), slow(37_200)].join('\n'))
    expect(slowAfterFailed).toContain('over budget: the latest run took 37.2s against its 20s budget, after one that failed (network)')
    expect(syncAlarm([record({}), failed('network')].join('\n'))).toBe('')
  })

  // A run's budget grows with the issues it minted and the comments it posted,
  // so each run is judged, and reported, against its own.
  it('judges each run against the budget it recorded', () => {
    expect(syncAlarm([slow(35_900), record({ ms: 37_200, budgetMs: 40_000 })].join('\n'))).toBe('')
    const notice = syncAlarm([slow(35_900), record({ ms: 57_200, budgetMs: 40_000 })].join('\n'))
    expect(notice).toContain('the last two runs took 35.9s and 57.2s against budgets of 20s and 40s')
  })

  // Pacing a comment backlog, or waiting on another run's lock, is not the
  // tracker getting slower: only the time the run spent working counts.
  it('does not count deliberate waits against the budget', () => {
    const draining = record({ ms: 52_000, idleMs: 47_000 })
    expect(syncAlarm([draining, draining].join('\n'))).toBe('')
    const working = record({ ms: 52_000, idleMs: 20_000 })
    expect(syncAlarm([working, working].join('\n'))).toContain('32.0s and 32.0s')
  })

  // Valid JSON in an older or damaged shape must not throw: at session start
  // a throw here would take the whole memory index down with the alarm.
  it('formats records with a damaged spawns list instead of throwing', () => {
    const damaged = (ms: number) => record({ ms, spawns: {} })
    expect(syncAlarm([damaged(35_900), damaged(37_200)].join('\n'))).toContain('35.9s and 37.2s')
    const odd = (ms: number) => record({ ms, spawns: [null, { cmd: 7 }, { cmd: 'bd show', calls: 2, ms: 20_300 }] })
    expect(syncAlarm([odd(35_900), odd(37_200)].join('\n'))).toContain('Slowest spawns in the latest: bd show ×2 20.3s.')
  })

  it('reads past a torn or foreign line instead of failing session start', () => {
    const noise = ['{"ms": 1', 'not json', '{"unrelated": true}', 'null', '{"ms": 50000}']
    expect(syncAlarm([slow(35_900), ...noise, slow(37_200), ...noise].join('\n'))).toContain('35.9s and 37.2s')
    expect(syncAlarm('')).toBe('')
  })
})

describe('bdVersion', () => {
  it('reads the version out of what bd prints, and refuses to invent one', () => {
    expect(bdVersion('bd version 1.2.2 (Homebrew)')).toBe('1.2.2')
    expect(bdVersion('bd version 1.3.0')).toBe('1.3.0')
    // A prerelease is a different engine, and must not read as the release.
    expect(bdVersion('bd version 1.2.2-rc.1')).toBe('1.2.2-rc.1')
    expect(bdVersion('bd version 1.2.2-dev+abc')).toBe('1.2.2-dev+abc')
    expect(bdVersion('bd-shim 0.0.0')).toBeNull()
    expect(bdVersion('')).toBeNull()
    expect(bdVersion(null)).toBeNull()
  })
})

describe('planLossyReapplies', () => {
  const at = (updatedAt: string, over: Partial<IssueInfo> = {}): IssueInfo => ({
    state: 'OPEN',
    labels: ['priority::high', 'type::task'],
    updatedAt,
    title: 'T',
    body: 'D',
    assignee: '',
    ...over,
  })
  const row = (over: Partial<BeadRow>) =>
    bead({ title: 'T', description: 'D', priority: 1, issue_type: 'task', updated_at: '2026-09-11T00:00:00Z', ...over })

  it('names the close date for a closed bead the pull would rewrite, and the edit its push overwrites', () => {
    const beads = [row({ id: 'km-a', status: 'closed', closed_at: '2026-09-01T00:00:00Z', title: 'the local title' })]
    expect(planLossyReapplies(beads, issues([[1, at('2026-09-11T01:00:00Z', { state: 'CLOSED', title: 'edited on GitHub' })]]))).toEqual([
      { id: 'km-a', number: 1, losses: ['closed_at'], overwrites: ['title'] },
    ])
  })

  // The ambiguity rule is the same rule for every label-derived field. Held
  // only for the type, an issue carrying two priority labels reads as
  // converged whenever the listed order happens to agree with the bead — so
  // the row is not defused and the pull restamps its close date anyway.
  it('counts a label-derived field as lost whenever the labels do not spell it uniquely', () => {
    const twoPriorities = at('2026-09-11T01:00:00Z', { state: 'CLOSED', labels: ['priority::high', 'priority::low', 'type::task'] })
    const closed = [row({ id: 'km-a', status: 'closed', closed_at: '2026-09-01T00:00:00Z' })]
    expect(planLossyReapplies(closed, issues([[1, twoPriorities]]))[0].losses).toEqual(['closed_at', 'priority'])
  })

  // bd pushes `status::in_progress` for a claimed bead, so an issue without it
  // maps to `open` — the pull would drop the claim, and nothing restores it
  // (the row is local-OLDER, so guard 4 never sees it).
  it('counts a claim the labels no longer spell as lost', () => {
    const claimed = [row({ id: 'km-a', status: 'in_progress' })]
    expect(planLossyReapplies(claimed, issues([[1, at('2026-09-11T01:00:00Z')]]))[0].losses).toEqual(['status'])
  })

  // One label saying something else is GitHub deliberately saying it, and
  // carrying it over is what the pull is FOR. Defusing would push the stale
  // local value over the edit, so a taxonomy edit could never reach beads —
  // which is the opposite of a loss.
  it('leaves a taxonomy edit a single label states to the pull', () => {
    const relabelled = at('2026-09-11T01:00:00Z', { labels: ['priority::low', 'type::bug'] })
    expect(planLossyReapplies([row({ id: 'km-a' })], issues([[1, relabelled]]))).toEqual([])
  })

  // …but when the bead is defused for a reason of its own, that same push
  // overwrites the edit, so the report has to name it.
  it('names a taxonomy edit among what the push overwrites, once something else defuses the bead', () => {
    const relabelled = at('2026-09-11T01:00:00Z', { labels: ['priority::low', 'type::bug'] })
    const assigned = [row({ id: 'km-a', assignee: 'Someone' })]
    const [plan] = planLossyReapplies(assigned, issues([[1, relabelled]]))
    expect(plan.losses).toEqual(['assignee'])
    expect(plan.overwrites).toEqual(['issue_type', 'priority'])
  })

  // A missing label is not GitHub saying anything — it is bd about to write
  // its own default over the bead. That is the flattening guard 2 exists for.
  it('counts a field no label states at all as lost, not imported', () => {
    const untyped = at('2026-09-11T01:00:00Z', { labels: [] })
    expect(planLossyReapplies([row({ id: 'km-a', priority: 1, issue_type: 'chore' })], issues([[1, untyped]]))[0].losses).toEqual([
      'issue_type',
      'priority',
    ])
  })

  it('names the assignee bd never pushed, and the type the labels do not spell', () => {
    const assigned = [row({ id: 'km-a', assignee: 'Someone' })]
    expect(planLossyReapplies(assigned, issues([[1, at('2026-09-11T01:00:00Z')]]))[0].losses).toEqual(['assignee'])
    const ambiguous = [row({ id: 'km-b', issue_type: 'chore' })]
    const withBareLabel = at('2026-09-11T01:00:00Z', { labels: ['priority::high', 'type::chore', 'enhancement'] })
    expect(planLossyReapplies(ambiguous, issues([[1, withBareLabel]]))[0].losses).toEqual(['issue_type'])
  })

  // The case the guard exists for is the one where the pull carries nothing
  // back: leaving a real import to the pull is the whole reason it is not
  // simply "defuse every candidate".
  it('leaves a bead the pull would carry faithfully alone', () => {
    const edited = [row({ id: 'km-a', title: 'old title' })]
    expect(planLossyReapplies(edited, issues([[1, at('2026-09-11T01:00:00Z', { title: 'edited on GitHub' })]]))).toEqual([])
  })

  it('leaves a converged bead alone — the pull skips it, so the touch would be a push for nothing', () => {
    const closed = [row({ id: 'km-a', status: 'closed', closed_at: '2026-09-01T00:00:00Z' })]
    expect(planLossyReapplies(closed, issues([[1, at('2026-09-11T01:00:00Z', { state: 'CLOSED' })]]))).toEqual([])
  })

  // A withheld bead's report tells a human to compare the named fields by
  // hand; text that differs only in gh's caret notation is not one of them.
  it('names no overwrite for text that differs only as gh prints it', () => {
    const assigned = [row({ id: 'km-a', assignee: 'Someone', title: 'T\x1b[0m', description: '\x1b[41m FAIL' })]
    expect(planLossyReapplies(assigned, issues([[1, at('2026-09-11T01:00:00Z', { title: 'T^[[0m', body: '^[[41m FAIL' })]]))).toEqual([
      { id: 'km-a', number: 1, losses: ['assignee'], overwrites: [] },
    ])
  })

  it('treats a GitHub-side assignment onto an unassigned bead as an import, not a loss', () => {
    const beads = [row({ id: 'km-a' })]
    expect(planLossyReapplies(beads, issues([[1, at('2026-09-11T01:00:00Z', { assignee: 'octocat' })]]))).toEqual([])
  })

  // No timestamp test: whichever side moved last, the defuse moves BOTH, so
  // it is safe without knowing last_sync. A tie is the case every comparison
  // got wrong — it reads as safe while being unknowable — and it is a
  // candidate here like any other divergent row.
  it('does not care which side is newer, or whether either timestamp is there at all', () => {
    const assigned = (over: Partial<BeadRow>) => [row({ id: 'km-a', assignee: 'Someone', ...over })]
    const named = [{ id: 'km-a', number: 1, losses: ['assignee'], overwrites: [] }]
    expect(planLossyReapplies(assigned({}), issues([[1, at('2026-09-11T01:00:00Z')]]))).toEqual(named) // issue newer
    expect(planLossyReapplies(assigned({}), issues([[1, at('2026-09-11T00:00:00Z')]]))).toEqual(named) // a tie
    expect(planLossyReapplies(assigned({}), issues([[1, at('2026-09-10T00:00:00Z')]]))).toEqual(named) // bead newer
    expect(planLossyReapplies(assigned({ updated_at: undefined }), issues([[1, at('2026-09-11T01:00:00Z')]]))).toEqual(named)
    expect(planLossyReapplies(assigned({}), issues([[1, { ...at('2026-09-11T01:00:00Z'), updatedAt: undefined }]]))).toEqual(named)
  })

  it('still ignores a bead this repo has no issue for', () => {
    const assigned = (over: Partial<BeadRow>) => [row({ id: 'km-a', assignee: 'Someone', ...over })]
    expect(planLossyReapplies(assigned({ external_ref: null }), issues([[1, at('2026-09-11T01:00:00Z')]]))).toEqual([])
    expect(planLossyReapplies(assigned({}), issues([[2, at('2026-09-11T01:00:00Z')]]))).toEqual([])
  })
})

describe('planPrePullPush', () => {
  const gh = (updatedAt?: string): IssueInfo => ({ state: 'OPEN', labels: [], updatedAt })

  it('skips only beads whose listed GitHub copy is same-or-newer than the local row', () => {
    const beads = [
      bead({ id: 'km-older', external_ref: ref(1), updated_at: '2026-08-20T00:00:00Z' }),
      bead({ id: 'km-equal', external_ref: ref(2), updated_at: '2026-08-20T01:00:00Z' }),
      bead({ id: 'km-newer', external_ref: ref(3), updated_at: '2026-08-20T02:00:00Z' }),
    ]
    const map = issues([[1, gh('2026-08-20T01:00:00Z')], [2, gh('2026-08-20T01:00:00Z')], [3, gh('2026-08-20T01:00:00Z')]])
    expect(planPrePullPush(beads, map)).toEqual(['km-newer'])
  })

  // Everything the wrapper cannot PROVE bd would skip goes to bd, which
  // decides with a fresh GET exactly as the full push did.
  it('keeps every bead whose GitHub side it cannot see as same-or-newer', () => {
    const map = issues([[1, gh('2026-08-20T01:00:00Z')], [2, gh()]])
    const beads = [
      bead({ id: 'km-unlinked', external_ref: null, updated_at: '2026-08-19T00:00:00Z' }),
      bead({ id: 'km-foreign', external_ref: 'https://example.com/x/9', updated_at: '2026-08-19T00:00:00Z' }),
      bead({ id: 'km-gone', external_ref: ref(7), updated_at: '2026-08-19T00:00:00Z' }),
      bead({ id: 'km-no-gh-ts', external_ref: ref(2), updated_at: '2026-08-19T00:00:00Z' }),
      bead({ id: 'km-no-local-ts', external_ref: ref(1) }),
    ]
    expect(planPrePullPush(beads, map)).toEqual(['km-unlinked', 'km-foreign', 'km-gone', 'km-no-gh-ts', 'km-no-local-ts'])
  })

  it('returns nothing for a converged tracker', () => {
    const map = issues([[1, gh('2026-08-20T01:00:00Z')]])
    expect(planPrePullPush([bead({ external_ref: ref(1), updated_at: '2026-08-20T00:00:00Z' })], map)).toEqual([])
  })

  // bd would only spend a GET to skip it. A difference only the pull sees (the
  // assignee, which GitHub never carries) is not the push's to fix either.
  it('hands bd a local-newer row only when a pushed field differs', () => {
    const converged = { state: 'OPEN' as const, labels: ['type::task', 'priority::high'], title: 'T', body: 'D', assignee: '', updatedAt: '2026-08-20T01:00:00Z' }
    const row = bead({ id: 'km-q', external_ref: ref(1), updated_at: '2026-08-25T00:00:00Z', title: 'T', description: 'D', priority: 1, issue_type: 'task' })
    expect(planPrePullPush([row], issues([[1, converged]]))).toEqual([])
    expect(planPrePullPush([{ ...row, assignee: 'Someone' }], issues([[1, converged]]))).toEqual([])
    expect(planPrePullPush([{ ...row, title: 'edited locally' }], issues([[1, converged]]))).toEqual(['km-q'])
    expect(planPrePullPush([{ ...row, labels: ['ui'] }], issues([[1, converged]]))).toEqual(['km-q'])
    expect(planPrePullPush([{ ...row, status: 'closed' }], issues([[1, converged]]))).toEqual(['km-q'])
    expect(planPrePullPush([{ ...row, description: 'D\x1b[0m' }], issues([[1, { ...converged, body: 'D^[[0m' }]]))).toEqual([])
    expect(planPrePullPush([{ ...row, title: 'T\x1b[0m' }], issues([[1, { ...converged, title: 'T^[[0m' }]]))).toEqual([])
  })

})

describe('planUnlandedPushes', () => {
  it('names a handed bead whose issue still differs after the push', () => {
    const landed = { state: 'OPEN' as const, labels: ['type::task', 'priority::high'], title: 'T', body: 'D', updatedAt: '2026-08-26T00:00:00Z' }
    const row = bead({ id: 'km-q', external_ref: ref(1), updated_at: '2026-08-25T00:00:00Z', title: 'T', description: 'D', priority: 1, issue_type: 'task' })
    expect(planUnlandedPushes([row], issues([[1, landed]]))).toEqual([])
    expect(planUnlandedPushes([{ ...row, title: 'not on GitHub' }], issues([[1, landed]]))).toEqual([{ id: 'km-q', number: 1 }])
  })
})

describe('planPullSet', () => {
  const gh = (updatedAt?: string): IssueInfo => ({ state: 'OPEN', labels: [], title: 'GitHub title', body: 'D', updatedAt })
  const row = (id: string, n: number, updated_at?: string) =>
    bead({ id, external_ref: ref(n), title: 'local title', description: 'D', updated_at })

  it('hands the pull a faithful bead only when GitHub is not the older side', () => {
    const map = issues([[1, gh('2026-08-20T01:00:00Z')], [2, gh('2026-08-20T01:00:00Z')], [3, gh()], [4, gh('2026-08-20T01:00:00Z')]])
    const beads = [
      row('km-local-newer', 1, '2026-08-21T00:00:00Z'),
      row('km-github-newer', 2, '2026-08-19T00:00:00Z'),
      row('km-no-gh-ts', 3, '2026-08-19T00:00:00Z'),
    ]
    // #4 has no bead: the GitHub→beads direction is always pulled.
    expect(planPullSet(beads, map, new Set())).toEqual([2, 3, 4])
  })

  it('never names a withheld bead', () => {
    const map = issues([[2, gh('2026-08-20T01:00:00Z')]])
    expect(planPullSet([row('km-lossy', 2, '2026-08-19T00:00:00Z')], map, new Set(['km-lossy']))).toEqual([])
  })
})

describe('planMintedRefs', () => {
  it('reports every ref that appeared between the listings, open beads included', () => {
    const pre = [
      bead({ id: 'km-a', status: 'open', external_ref: null }),
      bead({ id: 'km-b', status: 'closed', external_ref: null }),
    ]
    const post = [
      bead({ id: 'km-a', status: 'open', external_ref: ref(12) }),
      bead({ id: 'km-b', status: 'closed', external_ref: ref(13) }),
    ]
    expect(planMintedRefs(pre, post)).toEqual([
      { id: 'km-a', number: 12 },
      { id: 'km-b', number: 13 },
    ])
  })

  it('ignores pre-existing refs and still-unminted beads', () => {
    expect(
      planMintedRefs([bead({ id: 'km-a', external_ref: ref(12) })], [bead({ id: 'km-a', external_ref: ref(12) })]),
    ).toEqual([])
    expect(
      planMintedRefs([bead({ id: 'km-a', external_ref: null })], [bead({ id: 'km-a', external_ref: null })]),
    ).toEqual([])
  })

  // No pull runs between the two listings at either call site, so a
  // fresh-only row is a concurrent creation from another worktree — its mint
  // must still be reported, or the mapping is lost forever.
  it('includes beads that first appear in the post listing already mapped', () => {
    expect(planMintedRefs([], [bead({ id: 'km-a', external_ref: ref(12) })])).toEqual([
      { id: 'km-a', number: 12 },
    ])
  })
})

describe('mirroredCommentIds', () => {
  const a = '0000c0de-0000-7000-8000-000000000001'
  const b = '0000c0de-0000-7000-8000-000000000002'
  const c = '0000c0de-0000-7000-8000-000000000003'

  it('reads the bead comment id out of the opening marker, ignoring unmarked bodies', () => {
    const ids = mirroredCommentIds([
      `<!-- bd-comment ${a} -->\n_Mirrored…_\n\ntext`,
      'a human comment mentioning <!-- something else -->',
      `<!--bd-comment ${b}-->\nno spaces`,
      `<!-- bd-comment ${a} -->\nduplicate marker`,
    ])
    expect([...ids]).toEqual([a, b])
  })

  it('does not read a marker quoted mid-body as proof of mirroring', () => {
    const ids = mirroredCommentIds([
      `<!-- bd-comment ${a} -->\n_Mirrored…_\n\nthe marker looks like <!-- bd-comment ${c} -->`,
      `a human reply pasting raw markdown:\n<!-- bd-comment ${b} -->`,
    ])
    expect([...ids]).toEqual([a])
  })
})

describe('mirrorCommentBody', () => {
  const numbers = new Map([
    ['km-abcd', 12],
    ['km-1786746066130-174-003836b1', 502],
  ])
  // Ids to HOLD: beads whose issue is still to be minted.
  const hold = new Set(['km-nw01'])
  const comment = { id: '0000c0de-0000-7000-8000-000000000001', text: 'see km-abcd and km-1786746066130-174-003836b1; km-zzz9 is nobody', created_at: '2026-09-03T20:16:36Z' }

  it('opens with the marker, stamps the original time, and rewrites mapped bead ids to issue numbers', () => {
    const { body, unmapped, leftover } = mirrorCommentBody(comment, numbers, hold)
    expect(body.split('\n')[0]).toBe(`<!-- bd-comment ${comment.id} -->`)
    expect(body).toContain('2026-09-03 20:16 UTC')
    // An id that matches no bead is text (a fixture, a typo), not a reference
    // — published, and named as a leftover.
    expect(body.endsWith('see #12 and #502; km-zzz9 is nobody')).toBe(true)
    expect(unmapped).toEqual([])
    expect(leftover).toEqual(['km-zzz9'])
  })

  it('reports an id that names a bead without an issue instead of publishing it', () => {
    const { body, unmapped } = mirrorCommentBody({ ...comment, text: 'blocked on km-nw01 (twice: km-nw01) and km-abcd' }, numbers, hold)
    expect(unmapped).toEqual(['km-nw01'])
    expect(body.endsWith('blocked on km-nw01 (twice: km-nw01) and #12')).toBe(true)
  })

  it('rewrites inside code too, and does not count a held id as a leftover', () => {
    const { body, unmapped, leftover } = mirrorCommentBody({ ...comment, text: 'km-nw01 and `bd show km-abcd`, km-zzz9' }, numbers, hold)
    expect(body.endsWith('km-nw01 and `bd show #12`, km-zzz9')).toBe(true)
    expect(unmapped).toEqual(['km-nw01'])
    expect(leftover).toEqual(['km-zzz9'])
  })
})

describe('planCommentMirror', () => {
  it('keeps only unmirrored comments, oldest first', () => {
    const c = (id: string, created_at: string) => ({ id, text: 't', created_at })
    const plan = planCommentMirror([c('c3', '2026-09-03T00:00:03Z'), c('c1', '2026-09-03T00:00:01Z'), c('c2', '2026-09-03T00:00:02Z')], new Set(['c2']))
    expect(plan.map(p => p.id)).toEqual(['c1', 'c3'])
  })
})

// Process-level pins for runSync's ordering and wiring, which unit tests on
// the plan functions cannot see. bd and gh are PATH-fronted shims; the bd shim
// serves a different `bd list` fixture per call so a listing can show what a
// step changed. Measured ~150ms per spawn solo; budgeted for the 6x load
// stretch.
describe('runSync process behavior', { timeout: 20_000 }, () => {
  const script = fileURLToPath(new URL('./bd-github-sync.mjs', import.meta.url))

  const makeSyncRepo = (opts: {
    issues: object[]
    /** What `bd export` serves, one row set per read with the last repeating, each joined with its `comments` fixture. */
    reads: object[][]
    failCloseId?: string
    /** Beads bd's close policy refuses to close without --force (an open child or blocker). */
    blockedCloseIds?: string[]
    /** What the issue listing serves once a push has run — the state after the pre-pull push. */
    issuesAfterPush?: object[]
    /** Fail every issue-listing read once a push has run. */
    failListAfterPush?: boolean
    /** A GraphQL error every issue-listing chunk carries, nulling its first alias. */
    listingError?: object
    /** The number of the newest PR by creation date (default: none). */
    newestPr?: number
    failFullSync?: boolean
    failPushCall?: number
    failReadCall?: number
    /** Comment fixtures, keyed by bead id, joined into the `bd export` rows. */
    comments?: Record<string, object[]>
    /** `gh api graphql` responses, one per call (the last one repeats). */
    graphql?: object | object[]
    failPostCall?: number
    /** Seconds each `gh api graphql` call takes, so overlapping calls show in `graphqlPeak`. */
    graphqlDelay?: number
    /** Seconds each issue-listing read takes, so overlapping reads show in `listingPeak`. */
    issueListDelay?: number
    /** `gh auth token` prints nothing, as on a machine that is logged out. */
    noGhToken?: boolean
    /** `bd --version` fails, as when bd is missing from PATH. */
    bdBroken?: boolean
    /** Extra environment for the script (the mirror's post cap override). */
    env?: Record<string, string>
    /** What `bd --version` prints (default: a verified version). */
    bdVersionOutput?: string
    /** `bd dolt commit` reports an error. */
    failCommit?: boolean
  }) => {
    const repo = mkdtempSync(join(tmpdir(), 'bd-sync-run-'))
    spawnSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, '.beads', 'embeddeddolt'), { recursive: true })
    const shimDir = join(repo, 'shim')
    mkdirSync(shimDir)
    const shimLog = join(repo, 'shim.log')
    writeFileSync(shimLog, '')
    writeFileSync(join(repo, 'gh-issues.json'), JSON.stringify(opts.issues))
    if (opts.issuesAfterPush) writeFileSync(join(repo, 'gh-issues-after.json'), JSON.stringify(opts.issuesAfterPush))
    // Answers the listing's GraphQL reads from the issue fixtures, as GitHub
    // does: the newest number, or each aliased number as an issue or as null
    // with a NOT_FOUND error (and gh's exit 1).
    writeFileSync(
      join(repo, 'gh-listing.mjs'),
      [
        "import { existsSync, readFileSync } from 'node:fs'",
        `const repo = ${JSON.stringify(repo)}`,
        "const query = process.argv.slice(2).find(a => a.startsWith('query=')).slice('query='.length)",
        "const pushed = existsSync(repo + '/push-count')",
        ...(opts.failListAfterPush ? ["if (pushed) { console.error('HTTP 502: Bad Gateway'); process.exit(1) }"] : []),
        "const after = pushed && existsSync(repo + '/gh-issues-after.json')",
        "const issues = JSON.parse(readFileSync(repo + (after ? '/gh-issues-after.json' : '/gh-issues.json'), 'utf8'))",
        'const byNumber = new Map(issues.map(i => [i.number, i]))',
        'let response',
        "if (query.includes('orderBy:')) {",
        // Newest by creation date: a fixture's createdAt where every one has
        // it, its number otherwise.
        '  const created = issues.every(i => i.createdAt) ? [...issues].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [...issues].sort((a, b) => b.number - a.number)',
        '  const nodes = created.slice(0, 1).map(i => ({ number: i.number }))',
        `  response = { data: { repository: { issues: { nodes }, pullRequests: { nodes: ${JSON.stringify(opts.newestPr ? [{ number: opts.newestPr }] : [])} } } } }`,
        '} else {',
        '  const repository = {}',
        '  const errors = []',
        '  for (const [, n] of query.matchAll(/i(\\d+): issue\\(number:/g)) {',
        '    const i = byNumber.get(Number(n))',
        '    repository[`i${n}`] = i ? { ...i, labels: { nodes: i.labels ?? [] }, assignees: { nodes: i.assignees ?? [] } } : null',
        "    if (!i) errors.push({ type: 'NOT_FOUND', path: ['repository', `i${n}`] })",
        '  }',
        ...(opts.listingError
          ? [`  const first = Object.keys(repository)[0]; repository[first] = null; errors.push(${JSON.stringify(opts.listingError)})`]
          : []),
        '  response = { data: { repository }, ...(errors.length && { errors }) }',
        '}',
        'console.log(JSON.stringify(response))',
        "process.exit(response.errors ? 1 : 0)",
      ].join('\n') + '\n',
    )
    const serialize = (rows: object[]) =>
      rows.map(r => JSON.stringify({ _type: 'issue', ...r, comments: opts.comments?.[(r as { id: string }).id] ?? [] })).join('\n') + '\n'
    opts.reads.forEach((rows, i) => writeFileSync(join(repo, `export-${i + 1}.jsonl`), serialize(rows)))
    writeFileSync(join(repo, 'export-last.jsonl'), serialize(opts.reads[opts.reads.length - 1]))
    const graphqlFixtures = Array.isArray(opts.graphql) ? opts.graphql : [opts.graphql ?? { data: { repository: {} } }]
    graphqlFixtures.forEach((g, i) => writeFileSync(join(repo, `gh-graphql-${i + 1}.json`), JSON.stringify(g)))
    writeFileSync(join(repo, 'gh-graphql-last.json'), JSON.stringify(graphqlFixtures[graphqlFixtures.length - 1]))
    const postedLog = join(repo, 'posted.log')
    writeFileSync(postedLog, '')
    writeFileSync(
      join(shimDir, 'bd'),
      [
        '#!/bin/sh',
        `echo "bd $@" >> "${shimLog}"`,
        `echo "$1 \${BD_DOLT_AUTO_PUSH-unset}" >> "${repo}/bd-env.log"`,
        'case "$1" in',
        `  --version) ${opts.bdBroken ? 'exit 127' : `echo "${opts.bdVersionOutput ?? 'bd version 1.3.0 (shim)'}"`};;`,
        '  github)',
        '    case "$*" in *--push-only*)',
        `      k=$(cat "${repo}/push-count" 2>/dev/null || echo 0); k=$((k+1)); echo $k > "${repo}/push-count"`,
        `      if [ "$k" = "${opts.failPushCall ?? 0}" ]; then echo "Error: push exploded"; else echo "Pushed 0 issues"; fi;;`,
        `    *) echo "${opts.failFullSync ? 'Error: pull exploded' : 'Pushed 0 issues'}";;`,
        '    esac;;',
        '  export)',
        `    e=$(cat "${repo}/export-count" 2>/dev/null || echo 0)`,
        `    e=$((e+1)); echo $e > "${repo}/export-count"`,
        `    if [ "$e" = "${opts.failReadCall ?? 0}" ]; then echo "Error: export exploded";`,
        `    elif [ -f "${repo}/export-$e.jsonl" ]; then cat "${repo}/export-$e.jsonl"; else cat "${repo}/export-last.jsonl"; fi;;`,
        // bd's close policy: an unforced close of a blocked bead prints the
        // refusal on stderr and exits 1.
        '  close)',
        `    case " ${(opts.blockedCloseIds ?? []).join(' ')} " in *" $2 "*) case "$*" in *--force*) ;; *) echo "cannot close $2: blocked (use --force to override)" >&2; exit 1;; esac;; esac`,
        `    if [ "$2" = "${opts.failCloseId ?? ''}" ]; then echo "Error: cannot close"; else echo ok; fi;;`,
        `  dolt) ${opts.failCommit ? 'echo "Error: commit exploded"' : 'echo Committed.'};;`,
        '  *) echo ok;;',
        'esac',
        'exit 0',
      ].join('\n') + '\n',
    )
    writeFileSync(
      join(shimDir, 'gh'),
      [
        '#!/bin/sh',
        // A listing read is logged by its kind: a chunk's query runs to ~14KB,
        // and concurrent appends that long interleave in the log.
        'case "$*" in',
        `  *"number state updatedAt"*) echo "gh api graphql listing" >> "${shimLog}";;`,
        `  *"orderBy:"*) echo "gh api graphql newest" >> "${shimLog}";;`,
        `  *) echo "gh $@" >> "${shimLog}";;`,
        'esac',
        'case "$1 $2" in',
        `  "auth token") ${opts.noGhToken ? 'true' : 'echo shim-token'};;`,
        // The real gh exits 1 when any alias is NOT_FOUND but still prints
        // the data — the shim mirrors that exit so the parser is pinned to
        // stdout, not the status.
        '  "api graphql")',
        '    case "$*" in *"number state updatedAt"*|*"orderBy:"*)',
        ...(opts.issueListDelay
          ? [`      echo + >> "${repo}/listing-flight.log"; sleep ${opts.issueListDelay}; echo - >> "${repo}/listing-flight.log"`]
          : []),
        `      exec node "${repo}/gh-listing.mjs" "$@";;`,
        '    esac',
        `    echo read >> "${repo}/comment-reads.log"`,
        ...(opts.graphqlDelay
          ? [`    echo + >> "${repo}/graphql-flight.log"; sleep ${opts.graphqlDelay}; echo - >> "${repo}/graphql-flight.log"`]
          : []),
        `    g=$(cat "${repo}/graphql-count" 2>/dev/null || echo 0); g=$((g+1)); echo $g > "${repo}/graphql-count"`,
        `    f="${repo}/gh-graphql-$g.json"; [ -f "$f" ] || f="${repo}/gh-graphql-last.json"`,
        `    cat "$f"; grep -q '"errors"' "$f" && exit 1;;`,
        '  "api -X")',
        `    p=$(cat "${repo}/post-count" 2>/dev/null || echo 0); p=$((p+1)); echo $p > "${repo}/post-count"`,
        `    if [ "$p" = "${opts.failPostCall ?? 0}" ]; then echo "gh: HTTP 403" >&2; exit 1; fi`,
        `    { echo "POST $*"; cat; echo; } >> "${postedLog}";;`,
        '  *) echo null;;',
        'esac',
        'exit 0',
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'bd'), 0o755)
    chmodSync(join(shimDir, 'gh'), 0o755)
    const env = { ...process.env, ...opts.env, PATH: `${shimDir}:${process.env.PATH}` }
    const run = (...args: string[]) => spawnSync('node', [script, ...args], { cwd: repo, env, encoding: 'utf8' })
    // For a test that has to act while the sync runs (release a lock it waits on).
    const runInBackground = (...args: string[]) => {
      const child = spawn('node', [script, ...args], { cwd: repo, env, stdio: 'ignore' })
      return { child, done: new Promise<number | null>(resolve => child.on('close', resolve)) }
    }
    // The records as the alarm reads them: each run's start folded with its end.
    const runLog = () => {
      const log = join(repo, SYNC_RUN_LOG)
      return existsSync(log) ? (foldRunLog(readFileSync(log, 'utf8')) as ReturnType<typeof JSON.parse>[]) : []
    }
    // Most calls ever in flight at once, from a delay log.
    const peakOf = (log: string) => () => {
      let inFlight = 0
      let peak = 0
      for (const mark of readFileSync(join(repo, log), 'utf8').split('\n'))
        if (mark === '+') peak = Math.max(peak, ++inFlight)
        else if (mark === '-') inFlight--
      return peak
    }
    const shimCalls = () => readFileSync(shimLog, 'utf8')
    // GraphQL reads of issue comments — the listing's reads are GraphQL too.
    const commentReads = () => (existsSync(join(repo, 'comment-reads.log')) ? readFileSync(join(repo, 'comment-reads.log'), 'utf8').split('\n').filter(Boolean).length : 0)
    // Each bd command's verb with the BD_DOLT_AUTO_PUSH it ran under.
    const bdAutoPush = () => readFileSync(join(repo, 'bd-env.log'), 'utf8').trim().split('\n')
    return {
      repo,
      run,
      runInBackground,
      runLog,
      graphqlPeak: peakOf('graphql-flight.log'),
      listingPeak: peakOf('listing-flight.log'),
      commentReads,
      bdAutoPush,
      shimCalls,
      posted: () => readFileSync(postedLog, 'utf8'),
    }
  }

  // Paired with syncRow to be CONVERGED: same title, body, priority and type,
  // no GitHub assignee. A test that wants the defuse (step 1.2) to fire moves
  // one of those apart on purpose — every other test would otherwise pay for a
  // divergence it never asked about.
  const ghIssue = (number: number, updatedAt: string, state = 'OPEN') => ({
    number,
    state,
    labels: [{ name: 'priority::high' }, { name: 'type::task' }],
    updatedAt,
    title: 'T',
    body: 'D',
    assignees: [],
  })

  // The wider row shape `bd export` emits — the plan functions' BeadRow
  // is a subset of it. Only the boilerplate lives here: external_ref and
  // updated_at stay at the call site because half these tests pin an ORDERING
  // between a local row and its GitHub issue, or the absence of a link, and
  // neither was readable inside a 160-character literal.
  const syncRow = <T extends object>(over: T) => ({
    id: 'km-x',
    status: 'open',
    priority: 1,
    title: 'T',
    description: 'D',
    issue_type: 'task',
    ...over,
  })

  // syncRow is CONVERGED with ghIssue, so a push of it would change nothing
  // and the pre-pull push declines it. A test whose subject is the push wants
  // this instead: the same row with one field GitHub does not yet have.
  const pushable = <T extends object>(over: T) => syncRow({ title: 'T (edited locally)', ...over })
  // An issue with no bead: it is always handed to the pull, so the pull runs.
  const unlinkedIssue = () => ghIssue(99, '2026-08-20T00:00:00Z')

  // The push-back is now only step 3's priority repair, which also spells
  // `--push-only --issues`, so a push-back pin reads only the log AFTER the
  // pull.
  const afterPull = (log: string) => {
    const i = log.indexOf('bd github sync --pull-only')
    expect(i).toBeGreaterThan(-1)
    return log.slice(i)
  }

  // Every guard here was measured against one bd; an upgrade moves several of
  // them at once and reports nothing. Refusing is the loud failure that a
  // silent assignee/close-date loss is not.
  it('refuses to sync on a bd version the guards were not verified against', () => {
    const row = syncRow({ id: 'km-v', external_ref: null, updated_at: '2026-08-19T00:00:00Z' })
    const repo = { issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [[row]], bdVersionOutput: 'bd version 1.2.2' }
    const { run, shimCalls, runLog } = makeSyncRepo(repo)
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('verified against bd 1.3.0')
    expect(r.stderr).toContain('1.2.2')
    // …and on record: a sync that refuses every run is the failure the alarm
    // most needs to see.
    expect(runLog()).toMatchObject([{ ok: false, failure: expect.stringContaining('refusing to sync') }])
    // Nothing was read or written past the probe.
    expect(shimCalls()).not.toContain('--pull-only')
    expect(shimCalls()).not.toContain('--push-only')

    // A prerelease of a verified release is a different engine.
    const rc = makeSyncRepo({ ...repo, bdVersionOutput: 'bd version 1.3.0-rc.2' })
    expect(rc.run().status).toBe(1)
    expect(rc.shimCalls()).not.toContain('--pull-only')

    const overridden = makeSyncRepo({ ...repo, env: { KM_BD_VERSION_OK: '1' } })
    expect(overridden.run().status).toBe(0)
    expect(overridden.shimCalls()).toContain('--pull-only')

    // A value that MEANS off must not read as on — the refusal exists to stop
    // silent assignee and close-date loss.
    for (const off of ['0', 'false', '']) {
      const still = makeSyncRepo({ ...repo, env: { KM_BD_VERSION_OK: off } })
      expect(still.run().status).toBe(1)
      expect(still.shimCalls()).not.toContain('--pull-only')
    }
  })

  it('pushes local state out BEFORE the pull, and stays quiet with no suspects', () => {
    const row = syncRow({ id: 'km-t1', external_ref: null, updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z')],
      reads: [[row]],
    })
    const r = run()
    expect(r.status).toBe(0)
    const log = shimCalls()
    const pushOnly = log.indexOf('bd github sync --push-only --issues km-t1')
    const pull = log.indexOf('bd github sync --pull-only')
    expect(pushOnly).toBeGreaterThan(-1)
    expect(pull).toBeGreaterThan(-1)
    expect(pushOnly).toBeLessThan(pull)
    expect(log).not.toContain('bd github sync\n')
    expect(log).not.toContain('bd show')
    expect(log).not.toContain('bd update')
    expect(log).not.toContain('bd close')
  })

  // Position pin: the pre-pull push must run AFTER close-adoption — swapped,
  // a still-open bead's push would re-open its GitHub-closed issue (trap 1).
  // km-t3 is blocked, so an unforced adoption would be refused and abort.
  it('adopts GitHub-side closes BEFORE the pre-pull push', () => {
    const row = pushable({ id: 'km-t3', external_ref: ref(3), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      blockedCloseIds: ['km-t3'],
      issues: [ghIssue(3, '2026-08-20T00:00:00Z', 'CLOSED')],
      reads: [[row], [{ ...row, status: 'closed', updated_at: '2026-08-21T00:00:00Z' }]],
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

  // bd pushes its Dolt remote from inside whichever command is running when
  // the push throttle lapses, so a run that writes at all would carry a
  // git+ssh push on one of its steps.
  it('runs every bd command of the sync with Dolt auto-push off', () => {
    const row = pushable({ id: 'km-t3', external_ref: ref(3), updated_at: '2026-08-19T00:00:00Z' })
    const { run, bdAutoPush } = makeSyncRepo({
      issues: [ghIssue(3, '2026-08-20T00:00:00Z', 'CLOSED'), unlinkedIssue()],
      reads: [[row], [{ ...row, status: 'closed', updated_at: '2026-08-21T00:00:00Z' }]],
    })
    expect(run().status).toBe(0)
    const commands = bdAutoPush().filter(l => !l.startsWith('--version'))
    expect(new Set(commands.map(l => l.split(' ')[0]))).toEqual(new Set(['export', 'close', 'github', 'dolt']))
    expect(commands.filter(l => !l.endsWith(' false'))).toEqual([])
  })

  describe('committing what bd github sync wrote', () => {
    const unminted = pushable({ id: 'km-c', external_ref: null, updated_at: '2026-08-19T00:00:00Z' })
    const minted = { ...unminted, external_ref: ref(5) }
    const mintRepo = { issues: [ghIssue(5, '2026-08-20T00:00:00Z')], reads: [[unminted], [minted]] }
    // The sync and commit calls in order, without the reads around them.
    const writes = (log: string) =>
      log.split('\n').flatMap(l =>
        /^bd dolt commit\b/.test(l) ? ['commit']
        : /--push-only/.test(l) ? ['push']
        : /--pull-only/.test(l) ? ['pull']
        : [],
      )

    it('commits right after each sync, so a following bd dolt push carries the refs', () => {
      const { run, shimCalls } = makeSyncRepo({ ...mintRepo, issues: [...mintRepo.issues, unlinkedIssue()] })
      expect(run().status).toBe(0)
      expect(writes(shimCalls())).toEqual(['push', 'commit', 'pull', 'commit'])
    })

    // A failed push can still have minted: an earlier chunk, or bd aborting midway.
    it('commits after a failed sync too, and still reports the sync failure', () => {
      const { run, shimCalls } = makeSyncRepo({ ...mintRepo, failPushCall: 1 })
      const r = run()
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain('push exploded')
      expect(writes(shimCalls())).toEqual(['push', 'commit'])
    })

    it('fails the run when the commit fails, keeping the minted mapping', () => {
      const { run, runLog } = makeSyncRepo({ ...mintRepo, failCommit: true })
      const r = run()
      expect(r.status).not.toBe(0)
      expect(r.stdout).toContain('minted: km-c → #5')
      expect(runLog()).toMatchObject([{ ok: false, failure: expect.stringContaining('commit exploded') }])
    })

    it('commits nothing on a dry run', () => {
      const { run, shimCalls } = makeSyncRepo({ issues: [unlinkedIssue()], reads: [[unminted]] })
      expect(run('--dry-run').status).toBe(0)
      expect(shimCalls()).toContain('--pull-only')
      expect(writes(shimCalls())).not.toContain('commit')
    })
  })

  it('prints the km→#N mapping for an issue this run minted', () => {
    const unminted = syncRow({ id: 'km-t5', external_ref: null, updated_at: '2026-08-19T00:00:00Z' })
    const minted = { ...unminted, external_ref: ref(5) }
    const { run } = makeSyncRepo({
      issues: [ghIssue(5, '2026-08-20T00:00:00Z')],
      reads: [[unminted], [minted], [minted]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('minted: km-t5 → #5')
  })

  // The mapping must survive a mid-run failure: it is emitted directly, right
  // after the first post-push listing — the end-of-run report never prints
  // when a later step throws, and by the NEXT run the bead already carries
  // its ref, so a swallowed mapping would never be printed at all.
  it('prints the minted mapping even when a later sync step fails', () => {
    const unminted = syncRow({ id: 'km-t5', external_ref: null, updated_at: '2026-08-19T00:00:00Z' })
    const minted = { ...unminted, external_ref: ref(5) }
    const { run } = makeSyncRepo({
      issues: [ghIssue(5, '2026-08-20T00:00:00Z'), unlinkedIssue()],
      reads: [[unminted], [minted], [minted]],
      failFullSync: true,
    })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('bd-github-sync: failed')
    expect(r.stdout).toContain('minted: km-t5 → #5')
  })

  // The alarm's input: every real run leaves one line saying how long it took
  // and where the time went, and a run over budget says so even under --quiet.
  it('records each run with its slowest spawns, and flags one over budget', () => {
    const row = syncRow({ id: 'km-c', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' })
    const { run, runLog } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z')],
      reads: [[row]],
      env: { KM_BD_SYNC_BUDGET_MS: '1' },
    })
    const r = run('--quiet')
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/^bd-github-sync: slow run — [\d.]+s against a 0s budget; slowest: /m)
    const [entry] = runLog()
    expect(entry).toMatchObject({ ok: true, budgetMs: 1 })
    expect(entry.spawns.map((s: { cmd: string }) => s.cmd)).toEqual(expect.arrayContaining(['gh api graphql (listing)', 'bd export']))
  })

  // A failed tracker read must not finalize the run record while listing children remain.
  it('settles the issue listing before recording a tracker-read failure', () => {
    const { run, runLog } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z')],
      reads: [[]],
      failReadCall: 1,
    })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('export exploded')
    // The newest-number probe and both listing chunks must have exited.
    expect(runLog()[0].spawns).toEqual(expect.arrayContaining([
      expect.objectContaining({ cmd: 'bd export', calls: 1 }),
      expect.objectContaining({ cmd: 'gh api graphql (listing)', calls: 3 }),
    ]))
  })

  // The log only grows by appends, so the run holding the lock trims it.
  it('trims a log past twice its kept length back to the newest runs', () => {
    const row = syncRow({ id: 'km-c', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' })
    const { repo, run } = makeSyncRepo({ issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [[row]] })
    const old = Array.from({ length: 4_001 }, (_, i) => JSON.stringify({ at: `old-${i}`, ms: 1, ok: true, budgetMs: 15_000, spawns: [] }))
    writeFileSync(join(repo, SYNC_RUN_LOG), old.join('\n') + '\n')
    expect(run().status).toBe(0)
    const lines = readFileSync(join(repo, SYNC_RUN_LOG), 'utf8').trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(2_002)
    expect(lines.at(-1)).toContain('"event":"end"')
  })

  it('records a failed run as failed, and leaves no record for a dry run', () => {
    const row = syncRow({ id: 'km-c', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' })
    const repo = { issues: [ghIssue(1, '2026-08-20T00:00:00Z'), unlinkedIssue()], reads: [[row]] }
    const failed = makeSyncRepo({ ...repo, failFullSync: true })
    expect(failed.run().status).toBe(1)
    expect(failed.runLog()).toMatchObject([{ ok: false, failure: expect.stringContaining('pull exploded') }])
    const dry = makeSyncRepo(repo)
    expect(dry.run('--dry-run').status).toBe(0)
    expect(dry.runLog()).toEqual([])
  })

  // A checkout with a beads DB whose bd cannot run has stopped syncing: that is
  // on record, where a checkout with no DB at all stays silent.
  it('records a run whose bd cannot run as failed', () => {
    const { run, runLog, shimCalls } = makeSyncRepo({ issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [[]], bdBroken: true })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('skipped (bd is not runnable')
    expect(runLog()).toMatchObject([{ ok: false, failure: expect.stringContaining('bd is not runnable') }])
    expect(shimCalls()).not.toContain('bd export')
  })

  // Past the lock wait, a live holder is contention: the run skips, and a run
  // that did nothing leaves no record. A lock path nothing live holds that
  // still cannot be taken is broken, and the run fails on record.
  it('skips on a lock a live run holds, and fails on a lock path it cannot take', () => {
    const row = syncRow({ id: 'km-c', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' })
    const repo = { issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [[row]], env: { KM_BD_SYNC_LOCK_WAIT_MS: '1' } }

    const held = makeSyncRepo(repo)
    writeFileSync(join(held.repo, '.beads', 'github-sync.lock'), String(process.pid))
    const skipped = held.run()
    expect(skipped.status).toBe(0)
    expect(skipped.stdout).toContain('skipped (lock at')
    expect(held.runLog()).toEqual([])

    const broken = makeSyncRepo(repo)
    mkdirSync(join(broken.repo, '.beads', 'github-sync.lock'))
    const failed = broken.run()
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('could not take the sync lock')
    expect(broken.runLog()).toMatchObject([{ ok: false, failure: expect.stringContaining('could not take the sync lock') }])
  })

  // A machine that lost its gh login stops syncing without failing anything:
  // the run exits clean, and the record is what says it did nothing.
  it('records a run with no gh token as failed, while still exiting clean', () => {
    const { run, runLog } = makeSyncRepo({ issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [[]], noGhToken: true })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('skipped (no gh token)')
    expect(runLog()).toMatchObject([{ ok: false, failure: 'no gh token' }])
  })

  // The record is written as the run starts, so one killed before it ends —
  // the SessionEnd hook's time limit, a crash — is still on the log.
  it('leaves a killed run on record as one that did not finish', { timeout: 40_000 }, async () => {
    const row = syncRow({ id: 'km-c', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' })
    const { repo, runInBackground, runLog } = makeSyncRepo({ issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [[row]] })
    // Parked on a lock this test holds, so the kill lands mid-run.
    writeFileSync(join(repo, '.beads', 'github-sync.lock'), String(process.pid))
    const { child, done } = runInBackground()
    // While its process lives the run is left out of the records, so fence on
    // the start line itself.
    await vi.waitFor(() => expect(readFileSync(join(repo, SYNC_RUN_LOG), 'utf8')).toContain('"event":"start"'), {
      timeout: 15_000,
      interval: 50,
    })
    expect(runLog()).toEqual([])
    child.kill('SIGKILL')
    await done
    expect(runLog()).toMatchObject([{ ok: false, failure: expect.stringContaining('did not finish') }])
  })

  // The documented asymmetry, enforced: the pull is never handed a closed
  // bead whose issue was reopened (it would lose the close), and step 4
  // re-closes the issue.
  it('keeps a GitHub-side reopen of a closed bead from sticking', () => {
    const closedRow = syncRow({ id: 'km-tD', status: 'closed', external_ref: ref(14), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(14, '2026-08-20T05:00:00Z'), unlinkedIssue()],
      reads: [[closedRow]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('withheld km-tD (#14) from the pull')
    expect(shimCalls()).toContain('bd github sync --pull-only --issues 99\n')
    expect(shimCalls()).toContain('gh api repos/Stvad/knowledge-medium/issues/14')
  })

  // Only the pull can flatten a priority, and it reaches only what it is
  // named: a bead that went to 2 locally during the run is left alone.
  it('repairs priorities only on beads the pull was handed', () => {
    const p1 = syncRow({ id: 'km-p', external_ref: ref(4), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      // #9 has no bead, so a pull runs; #4 is converged and not in it.
      issues: [ghIssue(4, '2026-08-20T00:00:00Z'), ghIssue(9, '2026-08-20T00:00:00Z')],
      // Run start, just before the pull, after it: set to P2 locally meanwhile.
      reads: [[p1], [p1], [{ ...p1, priority: 2 }]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(shimCalls()).toContain('bd github sync --pull-only --issues 9\n')
    expect(shimCalls()).not.toContain('bd update km-p')
  })

  it('hands the pre-pull push only the beads bd could update', () => {
    const converged = pushable({ id: 'km-c', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' })
    const newer = pushable({ id: 'km-n', external_ref: ref(2), updated_at: '2026-08-21T00:00:00Z' })
    const unlinked = pushable({ id: 'km-u', external_ref: null, updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z'), ghIssue(2, '2026-08-20T00:00:00Z')],
      reads: [[converged, newer, unlinked]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(shimCalls()).toContain('bd github sync --push-only --issues km-n,km-u\n')
  })

  it('skips the pre-pull push entirely when every bead is converged, and still pulls', () => {
    const row = syncRow({ id: 'km-c', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z'), unlinkedIssue()],
      reads: [[row]],
    })
    const r = run()
    expect(r.status).toBe(0)
    const log = shimCalls()
    expect(log).not.toContain('--push-only')
    expect(log).toContain('bd github sync --pull-only --issues 99\n')
    expect(log).not.toContain('bd github sync\n')
  })

  // A bead with no timestamp still goes to the push (bd decides with a fresh
  // read), and the local-newer rule cannot judge it — so the push's own set is
  // what keeps it out of the pull.
  it('never names a bead the push carries out to the pull, even one with no timestamp', () => {
    const row = pushable({ id: 'km-t', external_ref: ref(4) })
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(4, '2026-08-20T00:00:00Z'), ghIssue(9, '2026-08-20T00:00:00Z')],
      reads: [[row]],
    })
    const r = run()
    expect(r.status).toBe(0)
    const log = shimCalls()
    expect(log).toContain('bd github sync --push-only --issues km-t\n')
    expect(log).toContain('bd github sync --pull-only --issues 9\n')
  })

  // The pull set comes from the run-start listing, so an issue this run's push
  // minted is never in it: the mint creates the issue OPEN, and a pull of it
  // would re-open the closed bead it was minted for.
  it('never names an issue this run minted to the pull', () => {
    const preRow = syncRow({ id: 'km-c', status: 'closed', external_ref: null, updated_at: '2026-08-19T00:00:00Z' })
    const minted = { ...preRow, external_ref: ref(12) }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z')],
      reads: [[preRow], [minted]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('minted: km-c → #12')
    expect(shimCalls()).toContain('bd github sync --pull-only --issues 1\n')
  })

  // A bead the pull creates from a hand-filed issue lands at bd's default P2
  // whatever the issue's hand label says; step 3 re-derives it and pushes the
  // repaired row back out, after the pull.
  it('re-derives the priority of a bead the pull created, and pushes it back out', () => {
    const created = syncRow({ id: 'km-new', priority: 2, external_ref: ref(9), updated_at: '2026-08-20T00:00:01Z' })
    const handFiled = { ...ghIssue(9, '2026-08-20T00:00:00Z'), labels: [{ name: 'P1' }] }
    // Run start, just before the pull, after it.
    const { run, shimCalls } = makeSyncRepo({ issues: [handFiled], reads: [[], [], [created]] })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('priority km-new → 1')
    const log = afterPull(shimCalls())
    expect(log).toContain('bd update km-new -p 1')
    expect(log).toContain('bd github sync --push-only --issues km-new')
  })

  // The pull is planned on a read taken just before it, not the one the run
  // started from: a bead another worktree edits in between is newer locally
  // by then, and the pull would apply the older GitHub copy over the edit.
  it('re-reads before the pull, and drops a bead edited locally since the run began', () => {
    const before = syncRow({ id: 'km-e', external_ref: ref(4), updated_at: '2026-08-19T00:00:00Z' })
    const editedMeanwhile = { ...before, description: 'edited in another worktree', updated_at: '2026-08-21T00:00:00Z' }
    const { run, shimCalls } = makeSyncRepo({
      // #4 was edited on GitHub, so the run-start plan pulls it; #9 has no bead.
      issues: [{ ...ghIssue(4, '2026-08-20T00:00:00Z'), title: 'edited on GitHub' }, ghIssue(9, '2026-08-20T00:00:00Z')],
      reads: [[before], [editedMeanwhile]],
    })
    const r = run()
    expect(r.status).toBe(0)
    const log = shimCalls()
    expect(log.match(/^bd export/gm)?.length).toBeGreaterThanOrEqual(2)
    expect(log).toContain('bd github sync --pull-only --issues 9\n')
  })

  // After a push the run waits on the network again (the landed check), so the
  // pull is still planned on a read taken right before it.
  it('re-reads before the pull after a push too', () => {
    const pushed = pushable({ id: 'km-p', external_ref: ref(4), updated_at: '2026-08-21T00:00:00Z' })
    const pulled = syncRow({ id: 'km-e', external_ref: ref(5), updated_at: '2026-08-19T00:00:00Z' })
    const editedMeanwhile = { ...pulled, description: 'edited in another worktree', updated_at: '2026-08-22T00:00:00Z' }
    const { run, shimCalls } = makeSyncRepo({
      // #5 was edited on GitHub, so the run-start plan pulls it.
      issues: [ghIssue(4, '2026-08-20T00:00:00Z'), { ...ghIssue(5, '2026-08-20T00:00:00Z'), title: 'edited on GitHub' }, unlinkedIssue()],
      // Run start, after the push, just before the pull.
      reads: [[pushed, pulled], [pushed, pulled], [pushed, editedMeanwhile]],
    })
    const r = run()
    expect(r.status).toBe(0)
    const log = shimCalls()
    expect(log).toContain('bd github sync --push-only --issues km-p\n')
    expect(log).toContain('bd github sync --pull-only --issues 99\n')
  })

  // Step 4 plans on a read taken right before it: a bead the user reopened in
  // another worktree during the run is no longer closed, so its issue stays
  // open (the documented way to undo a GitHub-side reopen is to reopen the
  // bead; closing the issue here would have the next run close the bead again).
  it('does not close an issue whose bead was reopened during the run', () => {
    const closedRow = syncRow({ id: 'km-c', status: 'closed', external_ref: ref(14), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(14, '2026-08-20T00:00:00Z')],
      // Run start, then just before step 4: reopened meanwhile.
      reads: [[closedRow], [{ ...closedRow, status: 'open', updated_at: '2026-08-21T00:00:00Z' }]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(shimCalls()).not.toContain(`gh api repos/${REPO}/issues/14`)
    expect(shimCalls()).not.toContain('gh issue close')
  })

  // A converged run's whole cost: the probes, the issue listing, one read of
  // the tracker — nothing per bead, however many carry a local timestamp past
  // their issue's (bd stamps a freshly minted bead a second after its issue, so
  // that set only grows). The listing is the newest-number read and one read
  // per 100 numbers, which run concurrently (next test).
  it('makes only the fixed reads on a converged run, however many beads are locally newer', () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      syncRow({ id: `km-s${i}`, external_ref: ref(i + 1), updated_at: '2026-08-20T00:00:01Z' }),
    )
    const { run, shimCalls } = makeSyncRepo({
      issues: rows.map((_, i) => ghIssue(i + 1, '2026-08-20T00:00:00Z')),
      reads: [rows],
    })
    const r = run('--quiet')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    // Sorted: the listing and the first read run concurrently.
    const spawned = shimCalls().trim().split('\n').map(l => l.split(' ').slice(0, 3).join(' '))
    expect(spawned.sort()).toEqual(['bd --version', 'bd export', ...Array(5).fill('gh api graphql'), 'gh auth token'])
  })

  // `gh issue list` paged through the tracker one request after another, a
  // second per 100 issues on the live one.
  it('reads the listing in concurrent chunks, at most eight in flight', () => {
    const { run, listingPeak, shimCalls } = makeSyncRepo({
      issues: Array.from({ length: 1000 }, (_, i) => ghIssue(i + 1, '2026-08-20T00:00:00Z')),
      reads: [[]],
      issueListDelay: 0.3,
    })
    expect(run().status).toBe(0)
    expect(shimCalls().match(/^gh api graphql listing$/gm)).toHaveLength(11)
    expect(listingPeak()).toBe(8)
  })

  // A transferred-in issue keeps its creation date but takes the next number,
  // past every issue and PR that either creation-date ordering returns.
  it('reads past the newest issue and PR by creation date, so a transferred-in issue is listed', () => {
    const filed = [1, 2, 3].map(n => ({ ...ghIssue(n, '2026-08-20T00:00:00Z'), createdAt: `2026-08-0${n}T00:00:00Z` }))
    const transferred = { ...ghIssue(150, '2026-08-20T00:00:00Z'), createdAt: '2020-01-01T00:00:00Z' }
    const { run, shimCalls } = makeSyncRepo({ issues: [...filed, transferred], newestPr: 149, reads: [[]] })
    expect(run().status).toBe(0)
    expect(shimCalls()).toContain('bd github sync --pull-only --issues 1,2,3,150')
  })

  it('fails the run on an empty listing, before acting on anything', () => {
    const row = syncRow({ id: 'km-e', external_ref: ref(1), status: 'closed', updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({ issues: [], reads: [[row]] })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('issue listing came back empty')
    expect(shimCalls()).not.toContain('bd github sync')
    expect(shimCalls()).not.toContain('gh api repos/')
  })

  // Close-adoption, the pull set and the close pushes all act on an issue's
  // ABSENCE, so a number may read as absent only on GitHub saying so.
  it('fails the run on a listing error other than NOT_FOUND, before acting on anything', () => {
    const row = syncRow({ id: 'km-e', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z', 'CLOSED'), ghIssue(2, '2026-08-20T00:00:00Z')],
      reads: [[row]],
      listingError: { type: 'SERVICE_UNAVAILABLE', message: 'Something went wrong while executing your query.' },
    })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Something went wrong while executing your query.')
    expect(shimCalls()).not.toContain('bd close')
    expect(shimCalls()).not.toContain('bd github sync')
  })

  // A closed, assigned bead: bd's pull would clear the assignee and restamp the
  // close date, and neither comes back — so it must never be handed to the pull.
  const lossyRepo = () => {
    const row = syncRow({ id: 'km-l', status: 'closed', external_ref: ref(4), updated_at: '2026-08-19T00:00:00Z' })
    return makeSyncRepo({
      issues: [ghIssue(4, '2026-08-20T00:00:00Z', 'CLOSED')],
      reads: [[{ ...row, assignee: 'Someone', closed_at: '2026-08-01T00:00:00Z' }]],
    })
  }

  it('withholds a lossy bead from the pull, and says what it would have lost', () => {
    const { run, shimCalls } = lossyRepo()
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('withheld km-l (#4) from the pull: it would lose closed_at, assignee')
    // The whole guard: its number is not in the id list, so the pull cannot
    // reach it. Nothing is touched and nothing is force-pushed to achieve that.
    const log = shimCalls()
    expect(log).not.toContain('bd update km-l')
    expect(log).not.toContain('--push-only')
    expect(log).not.toMatch(/--pull-only --issues \S*\b4\b/)
  })

  it('hands the pull the issues that have no bead, so a hand-filed one becomes one', () => {
    const row = syncRow({ id: 'km-a', external_ref: ref(4), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      // #9 is on GitHub with no bead; #4 is converged, so it needs no pull.
      issues: [ghIssue(4, '2026-08-20T00:00:00Z'), ghIssue(9, '2026-08-20T00:00:00Z')],
      reads: [[row]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(shimCalls()).toContain('bd github sync --pull-only --issues 9')
  })

  it('hands the pull a bead it would carry faithfully, alongside the bead-less issues', () => {
    const row = syncRow({ id: 'km-f', external_ref: ref(4), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      issues: [{ ...ghIssue(4, '2026-08-20T00:00:00Z'), title: 'edited on GitHub' }],
      reads: [[row]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).not.toContain('withheld')
    expect(shimCalls()).toContain('bd github sync --pull-only --issues 4')
  })

  it('runs no pull at all when there is nothing it may be given', () => {
    const row = syncRow({ id: 'km-c', external_ref: ref(4), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(4, '2026-08-20T00:00:00Z')],
      reads: [[row]],
    })
    const r = run()
    expect(r.status).toBe(0)
    // An empty id list must not fall through to a BULK pull — that is the one
    // thing that could reach a withheld bead.
    expect(shimCalls()).not.toContain('--pull-only')
  })

  // The set is computed from a listing taken AFTER close-adoption: a close
  // bumps updated_at, and computed from the pre-adoption rows the just-closed
  // bead would look converged and never be pushed.
  it('computes the pre-pull set after close-adoption', () => {
    const row = pushable({ id: 'km-a', external_ref: ref(3), updated_at: '2026-08-19T00:00:00Z' })
    const closed = { ...row, status: 'closed', updated_at: '2026-08-21T00:00:00Z' }
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(3, '2026-08-20T00:00:00Z', 'CLOSED')],
      reads: [[row], [closed]],
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(shimCalls()).toContain('bd github sync --push-only --issues km-a\n')
  })

  // A dry run cannot re-list after adopting closes, so the closes it WOULD
  // adopt are added to the reported set — the real close bumps updated_at
  // and puts them there. Without this the plan underreports exactly the
  // close-adoption case.
  it('reports the closes it would adopt inside the dry-run push set', () => {
    const row = syncRow({ id: 'km-a', external_ref: ref(3), updated_at: '2026-08-19T00:00:00Z' })
    const { run, shimCalls } = makeSyncRepo({
      issues: [ghIssue(3, '2026-08-20T00:00:00Z', 'CLOSED')],
      reads: [[row]],
    })
    const r = run('--dry-run')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[dry-run] would close km-a')
    expect(r.stdout).toContain('[dry-run] would push 1 bead(s) out before the pull: km-a')
    expect(shimCalls()).not.toContain('bd close')
    expect(shimCalls()).not.toContain('--push-only')
    // …and out of the pull, which a real close would have made it newer than.
    expect(shimCalls()).not.toContain('--pull-only')
  })

  // bd takes the ids as ONE --issues argument, which has a per-argument
  // ceiling; a large set is split across invocations instead of failing the
  // spawn before bd starts.
  it('splits a large pre-pull set across several push invocations', () => {
    const rows = Array.from({ length: 250 }, (_, i) => syncRow({ id: `km-b${i}`, external_ref: null }))
    const { run, shimCalls } = makeSyncRepo({ issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [rows] })
    const r = run()
    expect(r.status).toBe(0)
    const pushes = shimCalls().split('\n').filter(l => l.startsWith('bd github sync --push-only --issues '))
    expect(pushes).toHaveLength(2)
    const ids = pushes.flatMap(l => l.slice('bd github sync --push-only --issues '.length).split(','))
    expect(ids).toEqual(rows.map(r => r.id))
  })

  // A failed push may still have minted issues — an earlier chunk, or bd
  // aborting midway — and by the next run the beads carry their refs, so the
  // mapping must be printed from a listing taken before the failure propagates.
  it('prints the mappings an earlier chunk minted when a later chunk fails', () => {
    const rows = Array.from({ length: 250 }, (_, i) => syncRow({ id: `km-b${i}`, external_ref: null }))
    const minted = rows.map((r, i) => (i < 200 ? { ...r, external_ref: ref(100 + i) } : r))
    const { run } = makeSyncRepo({ issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [rows, minted], failPushCall: 2 })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('bd-github-sync: failed')
    expect(r.stdout).toContain('minted: km-b0 → #100')
    expect(r.stdout).toContain('minted: km-b199 → #299')
  })

  // The mapping is unrecoverable once the beads carry their refs, so a
  // read that cannot run has to say so rather than drop it silently.
  it('reports a post-failure read it could not run instead of dropping the mappings', () => {
    const rows = Array.from({ length: 3 }, (_, i) => syncRow({ id: `km-b${i}`, external_ref: null }))
    const { run } = makeSyncRepo({
      issues: [ghIssue(1, '2026-08-20T00:00:00Z')],
      reads: [rows, rows],
      failPushCall: 1,
      failReadCall: 2,
    })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('could not re-read beads')
    expect(r.stdout).not.toContain('minted:')
  })

  it('reports a read it could not run after a push that succeeded', () => {
    const rows = Array.from({ length: 2 }, (_, i) => syncRow({ id: `km-b${i}`, external_ref: null }))
    const { run } = makeSyncRepo({ issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [rows, rows], failReadCall: 2 })
    const r = run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('could not re-read beads')
  })

  // Withholding is not an action: a bead that is simply not handed to the pull
  // changes nothing on either side, so a converged run stays silent.
  it('stays silent under --quiet when the only bead is a withheld one', () => {
    const { run } = lossyRepo()
    const r = run('--quiet')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  // …but a withhold that also names a GitHub-side divergence is the warning
  // that makes the trade visible, and must survive --quiet.
  it('says which fields a later push sends over a different GitHub value, even under --quiet', () => {
    const row = syncRow({ id: 'km-o', status: 'closed', external_ref: ref(4), updated_at: '2026-08-19T00:00:00Z' })
    const { run } = makeSyncRepo({
      issues: [{ ...ghIssue(4, '2026-08-20T00:00:00Z', 'CLOSED'), title: 'edited on GitHub' }],
      reads: [[{ ...row, closed_at: '2026-08-01T00:00:00Z' }]],
    })
    const r = run('--quiet')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("its title also differ(s) on GitHub and the bead's next push sends the local value")
  })

  it('stays silent under --quiet when a converged run changed nothing', () => {
    const row = syncRow({ id: 'km-t6', external_ref: ref(6), updated_at: '2026-08-19T00:00:00Z' })
    const { run } = makeSyncRepo({
      issues: [ghIssue(6, '2026-08-20T00:00:00Z')],
      reads: [[row], [row], [row]],
    })
    const r = run('--quiet')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  // ---- comment mirror (step 5) ----
  const C1 = '0000c0de-0000-7000-8000-000000000001'
  const C2 = '0000c0de-0000-7000-8000-000000000002'
  const beadComment = (id: string, text: string, created_at: string) => ({ id, issue_id: 'km-mmmm', author: 'A', text, created_at })
  const twoComments = [beadComment(C2, 'second, mentions km-oooo', '2026-09-03T21:13:50Z'), beadComment(C1, 'first', '2026-09-03T20:16:36Z')]
  const issueComments = (bodies: string[], next?: string) => ({
    comments: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes: bodies.map(body => ({ body })) },
  })
  // A commented bead (km-mmmm → #7) beside an uncommented one (km-oooo → #8) that
  // exists only to be referenced from a comment.
  const commentedRows = () => [
    syncRow({ id: 'km-mmmm', external_ref: ref(7), updated_at: '2026-08-19T00:00:00Z', comment_count: 2 }),
    syncRow({ id: 'km-oooo', external_ref: ref(8), updated_at: '2026-08-19T00:00:00Z', comment_count: 0 }),
  ]
  // #3 has no bead, so the pull always has something to do — without it the
  // id list is empty, no pull runs, and the mirror's slot pins mean nothing.
  const twoIssues = () => [ghIssue(7, '2026-08-20T00:00:00Z'), ghIssue(8, '2026-08-20T00:00:00Z'), ghIssue(3, '2026-08-20T00:00:00Z')]
  // One entry per post: the args themselves carry `-X POST`, so split on the
  // shim's line head, not the word.
  const postsOf = (log: string) => log.split(/^POST api /m).filter(Boolean)

  // Measured: the mirror pauses between posts on one issue, so a two-comment
  // backfill costs one pause on top of the spawns — recorded as idle time, so
  // a backlog drain does not read as the sync slowing down.
  it('mirrors unmirrored bead comments onto the issue oldest-first, marker-tagged, with bead ids rewritten', () => {
    const { run, shimCalls, commentReads, posted, runLog } = makeSyncRepo({
      issues: twoIssues(),
      reads: [commentedRows()],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('mirrored 2 comment(s) of km-mmmm to #7')
    expect(shimCalls()).toContain('bd export')
    // Slot pin: the pull comes first, so a waiting GitHub-side edit lands
    // before the post. The touch-push-repull dance the bulk pull used to need
    // is gone — a post cannot make a later pull re-apply the issue, because
    // the pull is only ever handed ids we chose.
    const calls = shimCalls()
    expect(calls.match(/bd github sync --pull-only/g)).toHaveLength(1)
    expect(calls.indexOf('bd github sync --pull-only')).toBeLessThan(calls.indexOf('gh api -X POST'))
    expect(calls).not.toContain('bd update km-mmmm')
    const log = posted()
    const posts = postsOf(log)
    expect(posts).toHaveLength(2)
    expect(posts[0]).toContain(`repos/${REPO}/issues/7/comments`)
    expect(JSON.parse(posts[0].slice(posts[0].indexOf('\n') + 1)).body).toMatch(new RegExp(`^<!-- bd-comment ${C1} -->\\n.*\\n\\nfirst$`, 's'))
    expect(JSON.parse(posts[1].slice(posts[1].indexOf('\n') + 1)).body).toMatch(new RegExp(`^<!-- bd-comment ${C2} -->\\n.*\\n\\nsecond, mentions #8$`, 's'))
    // Nothing was posted for the uncommented bead, and the mirror never
    // reads GitHub comments outside the one GraphQL call.
    expect(log).not.toContain('issues/8/comments')
    expect(commentReads()).toBe(1)
    // The pacing pause between the two posts is recorded as idle, not active, time.
    const [entry] = runLog()
    expect(entry.idleMs).toBeGreaterThanOrEqual(800)
    expect(entry.idleMs).toBeLessThan(entry.ms)
  })

  // A filing session's mints and a backlog's posts are work no later run
  // repeats, so they widen this run's budget instead of reading as the sync
  // slowing down. A converged run keeps the base budget (pinned above).
  it('widens the run budget for each issue minted and comment posted', () => {
    const unminted = syncRow({ id: 'km-nw01', external_ref: null, updated_at: '2026-08-19T00:00:00Z' })
    const { run, runLog } = makeSyncRepo({
      issues: twoIssues(),
      reads: [[unminted, ...commentedRows()], [{ ...unminted, external_ref: ref(9) }, ...commentedRows()]],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
      env: { KM_BD_SYNC_BUDGET_MS: '1000' },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('minted: km-nw01 → #9')
    expect(r.stdout).toContain('mirrored 2 comment(s) of km-mmmm to #7')
    expect(runLog()).toMatchObject([{ ok: true, mintsAndPosts: 3, budgetMs: 1000 + 3 * BUDGET_PER_MINT_OR_POST_MS }])
  })

  // Position pin for the mirror's slot: after the pre-pull push (a post bumps
  // the issue past the local row, and the push is handed only local-newer
  // rows), and after the pull, so a waiting GitHub-side edit lands before the
  // post.
  it('mirrors after the pre-pull push has carried the bead out and the pull has run', () => {
    const newer = pushable({ id: 'km-mmmm', external_ref: ref(7), updated_at: '2026-08-21T00:00:00Z', comment_count: 2 })
    const { run, shimCalls } = makeSyncRepo({
      issues: twoIssues(),
      issuesAfterPush: [{ ...ghIssue(7, '2026-08-21T00:00:01Z'), title: 'T (edited locally)' }, ...twoIssues().slice(1)],
      reads: [[newer]],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('mirrored 2 comment(s) of km-mmmm to #7')
    const calls = shimCalls()
    const push = calls.indexOf('bd github sync --push-only --issues km-mmmm')
    const pull = calls.indexOf('bd github sync --pull-only')
    const firstPost = calls.indexOf('gh api -X POST')
    expect(push).toBeGreaterThan(-1)
    expect(push).toBeLessThan(pull)
    expect(pull).toBeLessThan(firstPost)
  })

  // Queueing behind another run is that run's time, not this one's. The lock
  // is held under this test's own pid, which stays alive, and released by the
  // test itself: no reaping to depend on. The release waits for the token
  // probe, the last spawn before the lock, so the run is queued by then. The
  // timeout clears the lock's 20s deadline, so a lock that is never released
  // fails the assertion below (a skipped run writes no record), not the clock.
  it('records a wait on another run\'s lock as idle time', { timeout: 40_000 }, async () => {
    const row = syncRow({ id: 'km-c', external_ref: ref(1), updated_at: '2026-08-19T00:00:00Z' })
    const { repo, runInBackground, runLog, shimCalls } = makeSyncRepo({ issues: [ghIssue(1, '2026-08-20T00:00:00Z')], reads: [[row]] })
    const lock = join(repo, '.beads', 'github-sync.lock')
    writeFileSync(lock, String(process.pid))
    const { done } = runInBackground()
    await vi.waitFor(() => expect(shimCalls()).toContain('gh auth token'), { timeout: 15_000, interval: 50 })
    await new Promise(resolve => setTimeout(resolve, 1_200))
    unlinkSync(lock)
    expect(await done).toBe(0)
    const [entry] = runLog()
    expect(entry?.idleMs).toBeGreaterThanOrEqual(1000)
  })

  // bd only warns on a failed PATCH, and its push cache skips a bead equal to
  // its last push: GitHub still holds the old copy, and a post would make it
  // the newer side for the next pull.
  it('holds back the comments of a bead whose push did not land, and says so', () => {
    const newer = pushable({ id: 'km-mmmm', external_ref: ref(7), updated_at: '2026-08-21T00:00:00Z', comment_count: 2 })
    const { run, posted, runLog, shimCalls } = makeSyncRepo({
      issues: twoIssues(),
      issuesAfterPush: twoIssues(),
      reads: [[newer]],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    // The re-read asks for the handed issue (one chunk), not the whole listing
    // again (a newest-number read and two chunks).
    expect(shimCalls().match(/^gh api graphql newest$/gm)).toHaveLength(1)
    expect(shimCalls().match(/^gh api graphql listing$/gm)).toHaveLength(3)
    expect(r.stdout).toContain('push did not land for km-mmmm (#7)')
    expect(r.stdout).toContain('SKIPPED comments of km-mmmm: GitHub does not hold its local row this run')
    expect(posted()).toBe('')
    // A documented steady state, reported every run until it resolves — not a
    // failure the alarm should count.
    expect(runLog()).toMatchObject([{ ok: true }])
  })

  // The mapping is the run's only record of what it minted, so a failed
  // re-read must neither lose it nor let a post through.
  it('prints the minted mapping and holds comments when the post-push re-read fails', () => {
    const unminted = syncRow({ id: 'km-nw01', external_ref: null, updated_at: '2026-08-19T00:00:00Z' })
    const newer = pushable({ id: 'km-mmmm', external_ref: ref(7), updated_at: '2026-08-21T00:00:00Z', comment_count: 2 })
    const { run, posted, runLog } = makeSyncRepo({
      issues: twoIssues(),
      failListAfterPush: true,
      reads: [[unminted, newer], [{ ...unminted, external_ref: ref(9) }, newer]],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('minted: km-nw01 → #9')
    expect(r.stdout).toContain('FAILED to re-read the pushed issues')
    expect(runLog()).toMatchObject([{ ok: false, failure: expect.stringContaining('FAILED to re-read the pushed issues') }])
    expect(r.stdout).not.toContain('push did not land')
    expect(r.stdout).toContain('SKIPPED comments of km-mmmm')
    expect(posted()).toBe('')
  })

  // A cross-reference touches the named issue as a post does.
  it('holds a comment that names a bead whose push did not land', () => {
    const quiet = syncRow({ id: 'km-mmmm', external_ref: ref(7), updated_at: '2026-08-19T00:00:00Z', comment_count: 2 })
    const unlanded = pushable({ id: 'km-oooo', external_ref: ref(8), updated_at: '2026-08-21T00:00:00Z' })
    const { run, posted } = makeSyncRepo({
      issues: twoIssues(),
      issuesAfterPush: twoIssues(),
      reads: [[quiet, unlanded]],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`SKIPPED comment ${C2} of km-mmmm: it names bead(s) not referenceable this run (km-oooo)`)
    expect(posted()).toContain(C1)
    expect(posted()).not.toContain(C2)
  })

  // Posting makes GitHub the newer side, so a bead edited in another worktree
  // during the run waits: its edit has not been pushed yet, and the next pull
  // would take GitHub's copy over it.
  it('holds the comments of a bead edited during the run', () => {
    const [m, o] = commentedRows()
    const edited = { ...m, description: 'edited in another worktree', updated_at: '2026-08-22T00:00:00Z' }
    // Run start, just before the pull (#3 has no bead), after it, before the first post.
    const { run, posted } = makeSyncRepo({
      issues: twoIssues(),
      reads: [[m, o], [m, o], [m, o], [edited, o]],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SKIPPED comments of km-mmmm: edited during this run')
    expect(posted()).toBe('')
  })

  // A re-read that fails is a failed step, not a bead edited meanwhile: nothing
  // is posted, and the run is on record as failed.
  it('stops the mirror, and records a failed run, when the pre-post re-read fails', () => {
    const { run, posted, runLog } = makeSyncRepo({
      issues: twoIssues(),
      // Run start, just before the pull (#3 has no bead), after it, before the first post.
      reads: [commentedRows()],
      failReadCall: 4,
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('FAILED to re-read the beads before posting')
    expect(r.stdout).not.toContain('edited during this run')
    expect(posted()).toBe('')
    expect(runLog()).toMatchObject([{ ok: false, failure: expect.stringContaining('FAILED to re-read the beads before posting') }])
  })

  it('caps the posts of one run and leaves the rest for the next', () => {
    const { run, posted } = makeSyncRepo({
      issues: twoIssues(),
      reads: [commentedRows()],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
      env: { KM_MIRROR_POST_CAP: '1' },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('mirrored 1 comment(s) of km-mmmm to #7 — 1 left for the next run (post cap)')
    expect(postsOf(posted())).toHaveLength(1)
  })

  it('publishes an id it cannot rewrite — unknown here — and says so', () => {
    const { run, posted } = makeSyncRepo({
      issues: twoIssues(),
      reads: [commentedRows()],
      comments: { 'km-mmmm': [beadComment(C1, 'see km-oooo; km-zzz9 is a fixture', '2026-09-03T20:16:36Z')] },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`posted comment ${C1} of km-mmmm to #7 with bead id(s) it could not resolve (km-zzz9)`)
    expect(postsOf(posted())).toHaveLength(1)
  })

  it('posts only the comments GitHub lacks', () => {
    const converged = syncRow({ id: 'km-c', external_ref: ref(9), updated_at: '2026-08-19T00:00:00Z', comment_count: 1 })
    const { run, posted } = makeSyncRepo({
      issues: [...twoIssues(), ghIssue(9, '2026-08-20T00:00:00Z')],
      reads: [[...commentedRows(), converged]],
      comments: { 'km-mmmm': twoComments },
      graphql: {
        data: {
          repository: {
            i7: issueComments([`<!-- bd-comment ${C1} -->\nmirrored earlier`, 'a human reply']),
            i9: issueComments([`<!-- bd-comment ${C2} -->\nmirrored earlier`]),
          },
        },
      },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('mirrored 1 comment(s) of km-mmmm to #7')
    const posts = postsOf(posted())
    expect(posts).toHaveLength(1)
    expect(posts[0]).toContain(`bd-comment ${C2}`)
  })

  // GraphQL resolves `issue(number)` to null for a PR or a deleted issue
  // (gh exits 1 but prints the data) — the REST comment endpoint would
  // happily post onto the PR, so a null alias must never reach it.
  it('compares marker ids to the bead\'s own comments instead of counting markers', () => {
    const foreign = (n: number) => `<!-- bd-comment 0000c0de-0000-7000-8000-00000000f00${n} -->\nnot ours`
    const { run, posted } = makeSyncRepo({
      issues: twoIssues(),
      reads: [commentedRows()],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([foreign(1), foreign(2)]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('mirrored 2 comment(s) of km-mmmm to #7')
    expect(postsOf(posted())).toHaveLength(2)
  })

  it('never posts onto a number GraphQL cannot resolve as an issue, and reports the mis-pointed ref', () => {
    const { run, posted } = makeSyncRepo({
      issues: twoIssues(),
      reads: [commentedRows()],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'i7'] }] },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SKIPPED comments of km-mmmm: #7 is not an issue')
    expect(posted()).toBe('')
  })

  it('stops a bead at its first failed post so the thread keeps bead order, and leaves the rest for the next run', () => {
    const { run, posted, shimCalls, runLog } = makeSyncRepo({
      issues: twoIssues(),
      reads: [commentedRows()],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
      failPostCall: 1,
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`FAILED to mirror comment ${C1} of km-mmmm to #7 — 2 left for the next run`)
    expect(r.stdout).not.toContain('mirrored ')
    // The report reaches nobody, so the step it could not do is on record.
    expect(runLog()).toMatchObject([{ ok: false, failure: expect.stringContaining(`FAILED to mirror comment ${C1}`) }])
    expect(posted()).toBe('')
    // A failed post needs no repair pass now: nothing was touched, and the
    // pull can only ever be handed ids we chose.
    const calls = shimCalls()
    expect(calls.indexOf('bd github sync --push-only --issues km-mmmm')).toBe(-1)
    expect(calls.match(/--pull-only/g)).toHaveLength(1)
  })

  it('holds a bead at a comment naming an unminted bead, publishing nothing after it', () => {
    const unminted = syncRow({ id: 'km-uuuu', external_ref: null, updated_at: '2026-08-19T00:00:00Z', comment_count: 0 })
    const { run, posted, shimCalls } = makeSyncRepo({
      issues: twoIssues(),
      reads: [[...commentedRows(), unminted]],
      comments: { 'km-mmmm': [beadComment(C1, 'waits on km-uuuu', '2026-09-03T20:16:36Z'), twoComments[0]] },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`SKIPPED comment ${C1} of km-mmmm: it names bead(s) not referenceable this run (km-uuuu) — 2 left for the next run`)
    expect(posted()).toBe('')
    // Nothing publishable, so no touch either: a touch with no post would
    // just push the bead out next run for nothing.
    expect(shimCalls()).not.toContain('bd update km-mmmm')
  })

  it('reads every comment page, so a marker beyond the first still counts', () => {
    const { run, shimCalls, commentReads, posted } = makeSyncRepo({
      issues: twoIssues(),
      reads: [commentedRows()],
      comments: { 'km-mmmm': twoComments },
      graphql: [
        { data: { repository: { i7: issueComments(['a human comment'], 'cursor-1') } } },
        { data: { repository: { issue: issueComments([`<!-- bd-comment ${C1} -->\nfirst`, `<!-- bd-comment ${C2} -->\nsecond`]) } } },
      ],
    })
    const r = run()
    expect(r.status).toBe(0)
    const calls = shimCalls()
    expect(commentReads()).toBe(2)
    expect(calls).toContain('after: "cursor-1"')
    expect(posted()).toBe('')
  })

  // A ref below the listing's last number that the listing does not show is
  // a PR or a deleted issue — rewriting it would publish a confidently wrong
  // #N, which the repo treats as worse than an opaque bead id.
  it('does not rewrite a reference whose bead points at no issue of this repo, and says so', () => {
    const rows = [
      syncRow({ id: 'km-mmmm', external_ref: ref(7), updated_at: '2026-08-19T00:00:00Z', comment_count: 1 }),
      syncRow({ id: 'km-oooo', external_ref: ref(5), updated_at: '2026-08-19T00:00:00Z', comment_count: 0 }),
    ]
    const { run, posted } = makeSyncRepo({
      issues: twoIssues(),
      reads: [rows],
      comments: { 'km-mmmm': [beadComment(C1, 'see km-oooo', '2026-09-03T20:16:36Z')] },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`posted comment ${C1} of km-mmmm to #7 with bead id(s) it could not resolve (km-oooo)`)
    const [post] = postsOf(posted())
    expect(JSON.parse(post.slice(post.indexOf('\n') + 1)).body.endsWith('see km-oooo')).toBe(true)
  })

  // PRs share the number sequence, so a ref beyond the listing's last issue
  // is not an issue by that fact alone — only a ref this run's push minted
  // is trusted unseen.
  it('does not trust a ref beyond the listing unless this run minted it', () => {
    const rows = (oRef: string | null) => [
      syncRow({ id: 'km-mmmm', external_ref: ref(7), updated_at: '2026-08-19T00:00:00Z', comment_count: 1 }),
      syncRow({ id: 'km-oooo', external_ref: oRef, updated_at: '2026-08-19T00:00:00Z', comment_count: 0 }),
    ]
    const comments = { 'km-mmmm': [beadComment(C1, 'see km-oooo', '2026-09-03T20:16:36Z')] }
    const graphql = { data: { repository: { i7: issueComments([]) } } }

    const preExisting = makeSyncRepo({ issues: twoIssues(), reads: [rows(ref(9))], comments, graphql })
    expect(preExisting.run().stdout).toContain(`posted comment ${C1} of km-mmmm to #7 with bead id(s) it could not resolve (km-oooo)`)

    const minted = makeSyncRepo({ issues: twoIssues(), reads: [rows(null), rows(ref(9))], comments, graphql })
    const r = minted.run()
    expect(r.stdout).toContain('minted: km-oooo → #9')
    const [post] = postsOf(minted.posted())
    expect(JSON.parse(post.slice(post.indexOf('\n') + 1)).body.endsWith('see #9')).toBe(true)
  })

  it('skips a commented bead whose own ref points at no issue of this repo, before any GitHub read', () => {
    const rows = [syncRow({ id: 'km-mmmm', external_ref: ref(5), updated_at: '2026-08-19T00:00:00Z', comment_count: 2 })]
    const { run, commentReads, posted } = makeSyncRepo({ issues: twoIssues(), reads: [rows], comments: { 'km-mmmm': twoComments } })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('SKIPPED comments of km-mmmm: its external_ref does not point at an issue of this repo')
    expect(commentReads()).toBe(0)
    expect(posted()).toBe('')
  })

  // The read is split into chunks that run at once; each chunk must pick its
  // own issues out of its own response, whatever order they come back in.
  it('reads the comments of many issues in concurrent chunks and posts only what is missing', () => {
    const numbers = [11, 12, 13, 14, 15, 16, 17, 18, 19]
    const commentId = (n: number) => `0000c0de-0000-7000-8000-0000000000${n}`
    const rows = numbers.map(n => syncRow({ id: `km-c${n}`, external_ref: ref(n), updated_at: '2026-08-19T00:00:00Z' }))
    const comments = Object.fromEntries(numbers.map(n => [`km-c${n}`, [beadComment(commentId(n), `on #${n}`, '2026-09-03T20:16:36Z')]]))
    const onGitHub = Object.fromEntries(numbers.map(n => [`i${n}`, issueComments(n === 15 ? [] : [`<!-- bd-comment ${commentId(n)} -->\nmirrored`])]))
    const { run, commentReads, posted } = makeSyncRepo({
      issues: numbers.map(n => ghIssue(n, '2026-08-20T00:00:00Z')),
      reads: [rows],
      comments,
      graphql: { data: { repository: onGitHub } },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(commentReads()).toBe(5)
    const posts = postsOf(posted())
    expect(posts).toHaveLength(1)
    expect(posts[0]).toContain(`repos/${REPO}/issues/15/comments`)
  })

  // Past 400 commented issues the chunks are full and outnumber the width, so
  // the read has to queue them rather than start them all.
  it('keeps at most eight comment reads in flight, however many chunks there are', () => {
    const numbers = Array.from({ length: 401 }, (_, i) => 1000 + i)
    const commentId = (n: number) => `0000c0de-0000-7000-8000-00000000${n}`
    const rows = numbers.map(n => syncRow({ id: `km-c${n}`, external_ref: ref(n), updated_at: '2026-08-19T00:00:00Z' }))
    const comments = Object.fromEntries(numbers.map(n => [`km-c${n}`, [beadComment(commentId(n), 'c', '2026-09-03T20:16:36Z')]]))
    const onGitHub = Object.fromEntries(numbers.map(n => [`i${n}`, issueComments([`<!-- bd-comment ${commentId(n)} -->\nmirrored`])]))
    const { run, commentReads, graphqlPeak } = makeSyncRepo({
      issues: numbers.map(n => ghIssue(n, '2026-08-20T00:00:00Z')),
      reads: [rows],
      comments,
      graphql: { data: { repository: onGitHub } },
      graphqlDelay: 0.3,
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(commentReads()).toBe(9)
    expect(graphqlPeak()).toBe(8)
  })

  it('reports what it would mirror under --dry-run and posts nothing', () => {
    const { run, posted, shimCalls } = makeSyncRepo({
      issues: twoIssues(),
      reads: [commentedRows()],
      comments: { 'km-mmmm': twoComments },
      graphql: { data: { repository: { i7: issueComments([]) } } },
    })
    const r = run('--dry-run')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('[dry-run] would mirror 2 comment(s) of km-mmmm to #7')
    expect(posted()).toBe('')
    expect(shimCalls()).not.toContain('bd update')
    expect(shimCalls().match(/--pull-only/g)).toHaveLength(1)
  })

  it('skips the mirror, without failing the run, when the GitHub comment read is unusable', () => {
    const { run, posted } = makeSyncRepo({
      issues: twoIssues(),
      reads: [commentedRows()],
      comments: { 'km-mmmm': twoComments },
      graphql: { message: 'Bad credentials' },
    })
    const r = run()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('FAILED to read GitHub comments')
    expect(posted()).toBe('')
  })
})
