import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { RESOLVE } from './bd-github-sync-test-support'

// The two gh-side fixtures the hook tests reach for. Named because the whole
// distinction is `pull_request` being present at all — a close keyword aimed
// at a PR is the case the gate warns about, and spotting that in an inline
// literal took a second look every time.
const AN_ISSUE = { title: 'Real GC failure', state: 'open' }
const A_PR = { title: 'Some PR', state: 'open', pull_request: {} }

// Whether this process reads through permission bits, as root does.
const permissionBitsIgnored = () => {
  const probe = join(mkdtempSync(join(tmpdir(), 'perm-probe-')), 'f')
  writeFileSync(probe, '')
  chmodSync(probe, 0o000)
  try {
    readFileSync(probe)
    return true
  } catch {
    return false
  }
}

// Process-level pins for hookPrePr's composition — the ordering and gating
// that unit tests on the pure functions cannot see. Runs the real entry point
// in a scratch git repo with NO .beads/embeddeddolt and a PATH-fronted `bd`
// shim that logs every invocation: the fresh-clone invariant is exactly "no
// bd process is ever spawned there" (the first bd command would create an
// empty DB that then refuses to pull).
// Measured ~150ms per spawn solo; budgeted for the 6x load stretch.
describe('hookPrePr process behavior', { timeout: 20_000 }, () => {
  const script = fileURLToPath(new URL('./bd-github-sync.mjs', import.meta.url))

  const makeRepo = (opts: {
    dbReady: boolean
    ghIssues?: Record<number, object>
    shows?: object[][]
  }) => {
    const repo = mkdtempSync(join(tmpdir(), 'bd-sync-hook-'))
    spawnSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, '.beads'))
    if (opts.dbReady) mkdirSync(join(repo, '.beads', 'embeddeddolt'))
    const shimDir = join(repo, 'shim')
    mkdirSync(shimDir)
    const shimLog = join(repo, 'bd-shim.log')
    writeFileSync(shimLog, '')
    const shows = opts.shows ?? [[]]
    shows.forEach((rows, i) => writeFileSync(join(repo, `show-${i + 1}.json`), JSON.stringify(rows)))
    writeFileSync(join(repo, 'show-last.json'), JSON.stringify(shows[shows.length - 1]))
    // The shim answers --version with real text: initializedDbRoot treats
    // empty stdout as "bd missing", which would silently turn dbReady repos
    // DB-less and make the zero-calls assertions vacuous.
    writeFileSync(
      join(shimDir, 'bd'),
      [
        '#!/bin/sh',
        `echo "bd $@" >> "${shimLog}"`,
        'case "$1" in',
        '  --version) echo "bd-shim 0.0.0";;',
        '  show)',
        `    m=$(cat "${repo}/show-count" 2>/dev/null || echo 0)`,
        `    m=$((m+1)); echo $m > "${repo}/show-count"`,
        `    if [ -f "${repo}/show-$m.json" ]; then cat "${repo}/show-$m.json"; else cat "${repo}/show-last.json"; fi;;`,
        '  github) echo "Pushed 1 issues";;',
        '  *) echo ok;;',
        'esac',
        'exit 0',
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'bd'), 0o755)
    for (const [n, body] of Object.entries(opts.ghIssues ?? {}))
      writeFileSync(join(repo, `gh-issue-${n}.json`), JSON.stringify(body))
    writeFileSync(
      join(shimDir, 'gh'),
      [
        '#!/bin/sh',
        `echo "gh $@" >> "${shimLog}"`,
        'if [ "$1" = "auth" ]; then echo shim-token; exit 0; fi',
        'if [ "$1" = "api" ]; then',
        '  n=$(basename "$2")',
        `  if [ -f "${repo}/gh-issue-$n.json" ]; then cat "${repo}/gh-issue-$n.json"; exit 0; fi`,
        '  echo \'{"message":"Not Found"}\'; exit 1',
        'fi',
        'exit 0',
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'gh'), 0o755)
    // GH_TOKEN/GH_HOST: if a shim ever breaks, PATH search must not fall
    // through to the real gh with live credentials.
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      GH_TOKEN: '',
      GH_HOST: '127.0.0.1',
      BD_GITHUB_SYNC_DRY: '1',
      // the session attestation memo lives under the OS temp dir
      TMPDIR: join(repo, 'tmp'),
    }
    mkdirSync(join(repo, 'tmp'))
    const hook = (command: string, extra: Record<string, unknown> = {}) => {
      const payload = JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command }, ...extra })
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

  // The #N echo-gate survives pre-publish for the verifier-BLIND class —
  // merge, review, close/reopen, graphql, response-hiding or captured
  // output — each pinned below. Publishes the verifier can read hand their
  // refs to bd-publish-verify.mjs.
  it('echoes issue references on gh pr merge with their real titles and blocks once', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook('gh pr merge 12 --squash --body "relates to #653 and #999"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
    expect(r.stderr).toContain('#999 → NO SUCH ISSUE OR PR')
    // the nonexistent number suppresses the bypass offer for the whole round
    expect(r.stderr).not.toContain('KM_ISSUE_REFS_OK=1')
    const resolved = hook('gh pr merge 12 --squash --body "relates to #653"')
    expect(resolved.stderr).toContain('KM_ISSUE_REFS_OK=1')
  })

  it('honors KM_ISSUE_REFS_OK before any lookup (zero gh calls)', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook('KM_ISSUE_REFS_OK=1 gh pr merge 12 --body "relates to #653"')
    expect(r.status).toBe(0)
    expect(shimCalls()).not.toContain('gh api')
  })

  it('warns when a merge close keyword targets a pull request', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: A_PR } })
    const r = hook('gh pr merge 12 --body "Fixes #700"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
  })

  // The mixed case: the bead deny licenses a KM_ISSUE_REFS_OK=1 re-run, so
  // any #N already in merge text must be echoed in the SAME round —
  // otherwise that licence would publish unverified numbers.
  it('echoes pre-existing issue refs inside the bead-id deny round on merge', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook('gh pr merge 12 --body "tracks km-zzzz, relates to #653"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('km-zzzz')
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
  })

  // The legs are INDEPENDENT: a publish verb in the same invocation must not
  // swallow the commit check.
  it('gates commit close keywords even when the invocation also publishes', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: A_PR } })
    const r = hook('git commit -m "land it\n\nFixes #700" && gh pr comment 12 --body "posted"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
  })

  // #683 B: blind-publish text that lives OUTSIDE the command (files,
  // payloads, expansion) is not read — it blocks outright, and BOTH escapes
  // attest. One rule, no per-channel detection; the merge COMMIT itself is
  // additionally read back post-merge by bd-publish-verify.
  it('blocks blind publishes whose text lives outside the command, both escapes to pass', () => {
    const { hook, repo } = makeRepo({ dbReady: true })
    writeFileSync(join(repo, 'merge-msg.txt'), 'ship it\n\nFixes #700\n')
    const fromFile = hook(`gh pr merge 12 --squash -F ${join(repo, 'merge-msg.txt')}`)
    expect(fromFile.status).toBe(2)
    expect(fromFile.stderr).toContain('post-publication read-back covers')
    expect(hook('cat msg.txt | gh pr merge 12 -F -').status).toBe(2)
    // the CLI accepts the attached value form too
    expect(hook('gh pr merge 12 --squash -Fmsgfile').status).toBe(2)
    expect(hook('gh api --silent repos/Stvad/knowledge-medium/issues/1/comments --input payload.json').status).toBe(2)
    expect(hook(`gh api graphql -f query='mutation { x }' -F vars=@vars.json`).status).toBe(2)
    // the mutation keyword may live entirely in the external payload — the
    // graphql endpoint itself is blind-class, so the outside-text signal
    // still blocks these
    expect(hook('gh api graphql -F query=@q.graphql').status).toBe(2)
    expect(hook('gh api graphql -f query="$QUERY"').status).toBe(2)
    expect(hook(`KM_ISSUE_REFS_OK=1 gh pr merge 12 -F ${join(repo, 'merge-msg.txt')}`).status).toBe(2)
    expect(hook(`KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh pr merge 12 -F ${join(repo, 'merge-msg.txt')}`).status).toBe(0)
  })

  // Expansion-built unrepairable text has no readable form anywhere — the
  // command shows $(…), the merge commit is beyond repair. Non-merge
  // publishes with expansions stay allowed (the freeze pin below): the
  // verifier reads THEIR published result.
  it('fails closed on expansion-built merge/review/close text, both escapes required', () => {
    const { hook } = makeRepo({ dbReady: true })
    const r = hook('gh pr merge 12 --squash --body "$(cat msg)"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('shell expansion')
    expect(hook('gh pr review 5 -b "$REVIEW_TEXT"').status).toBe(2)
    expect(hook('KM_ISSUE_REFS_OK=1 gh pr merge 12 --body "$(cat msg)"').status).toBe(2)
    expect(hook('KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh pr merge 12 --body "$(cat msg)"').status).toBe(0)
  })

  // Quoted membership words reach gh unquoted but are blanked from the
  // skeleton — the raw text answers for them too.
  it('classifies quoted graphql/output-hiding words from the raw command', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook('gh api "--silent" repos/Stvad/knowledge-medium/issues/1/comments -f body="see #653"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
    const g = hook(`gh api "graphql" -f query='mutation { addComment(input: {body: "tracks km-zzzz"}) { x } }'`)
    expect(g.status).toBe(2)
    expect(g.stderr).toContain('km-zzzz')
  })

  // The whitelist: a shell operator of ANY kind leaves the covered shape, so
  // the publish keeps its pre-publish checks. One character class decides it
  // — no per-operator spelling, which is what previous rounds kept patching.
  // Even `2>` attests, though it leaves stdout intact: carving it out is
  // exactly the special-casing this shape exists to avoid.
  it('pre-echoes refs of any publish carrying a shell operator', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: A_PR } })
    const r = hook('gh pr edit 12 --body="Fixes #700" >/dev/null')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
    for (const cmd of [
      'gh pr edit 12 --body="Fixes #700" 2>/dev/null',
      'captured=$(gh pr edit 12 --body="Fixes #700")',
      'gh pr edit 12 --body="Fixes #700" | tail -n 0',
      'cat x | gh pr edit 12 --body="Fixes #700"',
      'gh pr edit 12 --body="Fixes #700" && echo done',
      // a foreign -R publish is uncovered by gh vocabulary, not by syntax:
      // the read-back is pinned to this repo
      'gh -R owner/other pr edit 12 --body="Fixes #700"',
      'gh --repo=owner/other pr edit 12 --body="Fixes #700"',
      // gh takes the attached form too — nothing would check this publish
      'gh -Rowner/other pr edit 12 --body="Fixes #700"',
    ])
      expect(hook(cmd).status, cmd).toBe(2)
    // the covered shape itself passes: one command, no operator, this repo
    expect(hook('gh pr edit 12 --body "relates to #653"').status).toBe(0)
  })

  it('treats every body-bearing file flag as outside-command text on blind publishes', () => {
    const { hook } = makeRepo({ dbReady: true })
    expect(hook('gh release edit v1 --notes-file msg.md >/dev/null').status).toBe(2)
    expect(hook('gh pr create --template msg.md >/dev/null').status).toBe(2)
    expect(hook('gh pr create -Tmsg.md >/dev/null').status).toBe(2)
  })

  // When the invocation also publishes, the commit leg scans raw text only:
  // a publish flag must not be misread as a commit-message file (an api
  // field value is not a path, and a publish body-file is the verifier's).
  it('does not misread publish file flags as commit-message files in compounds', () => {
    const { hook } = makeRepo({ dbReady: true })
    // the compound attests under the coarse rule, but on the PUBLISH's
    // flags — the commit leg must never report an unreadable message file
    const api = hook('git commit -m ok && gh api repos/Stvad/knowledge-medium/issues/1/comments -F body=hello')
    expect(api.status).toBe(2)
    expect(api.stderr).toContain('post-publication read-back covers')
    expect(api.stderr).not.toContain('does not exist at hook time')
    // the body-file belongs to the publish, so the compound attests under the
    // coarse rule — it must never fail closed on an unreadable COMMIT message
    const r = hook('git commit -m ok && gh pr create --title t --body-file missing.md')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('post-publication read-back covers')
    expect(r.stderr).not.toContain('does not exist at hook time')
  })

  // gh pr review output names no URL, so the verifier cannot find the
  // review — its refs stay pre-gated.
  it('echoes issue references on gh pr review and passes clean reviews', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook('gh pr review 5 --comment -b "relates to #653"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
    expect(hook('gh pr review 5 --approve').status).toBe(0)
  })

  // GraphQL mutations publish through a response envelope the verifier
  // cannot safely resolve; their inline query text sits in the raw command.
  it('gates refs and bead ids in graphql mutations, ignoring graphql reads', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook(`gh api graphql -f query='mutation { addComment(input: {body: "see #653"}) { x } }'`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Real GC failure')
    const beads = hook(`gh api graphql -f query='mutation { addComment(input: {body: "tracks km-zzzz"}) { x } }'`)
    expect(beads.status).toBe(2)
    expect(beads.stderr).toContain('km-zzzz')
    expect(hook(`gh api graphql -f query='query { repository(name: "x") { id } }'`).status).toBe(0)
  })

  // An api mutation with a response-hiding output flag is invisible to the
  // verifier — its READABLE inline text gets the tables here; a blanket
  // block would offer the escape without ever showing the refs.
  it('echoes readable text of response-hiding api mutations, passes clean ones', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook('gh api --silent -X PATCH repos/Stvad/knowledge-medium/pulls/12 -f body="relates to #653"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
    const jq = hook('gh api repos/Stvad/knowledge-medium/issues/1/comments -f body="tracks km-zzzz" --jq .id')
    expect(jq.status).toBe(2)
    expect(jq.stderr).toContain('km-zzzz')
    // clean readable text has nothing to confirm — no blanket block
    expect(hook('gh api --silent repos/Stvad/knowledge-medium/issues/1/comments -f body=done').status).toBe(0)
    // -F attests even inline. On gh api it is a typed FIELD, not a file, but
    // an INLINE api publish is covered and never reaches this branch — so
    // telling the two apart would only ever matter for a command already
    // attesting, and the split is what made a mixed compound read the wrong
    // signal. Over-blocking here costs one attested re-run.
    expect(hook('gh api --silent repos/Stvad/knowledge-medium/issues/1/comments -F body=done').status).toBe(2)
    expect(hook('gh api --silent repos/Stvad/knowledge-medium/issues/1/comments -F body=@notes.md').status).toBe(2)
    expect(hook('gh api --silent --method GET repos/Stvad/knowledge-medium/issues -f state=open').status).toBe(0)
  })

  // Round-6 pin: a sibling GET segment must not suppress the opaque leg —
  // there is no GET exemption left to suppress.
  it('echoes refs of a silent mutation even when a sibling segment is an explicit GET', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook(
      'gh api -X GET repos/Stvad/knowledge-medium/issues/1 && gh api --silent repos/Stvad/knowledge-medium/issues/1/comments -f body="see #653"',
    )
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
  })

  // Close/reopen comments publish text whose success output names repo#N,
  // never a URL — the verifier cannot find them, so their refs stay here.
  it('echoes issue references in close/reopen comments and passes comment-less closes', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook('gh issue close 12 -c "superseded, see #653"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
    expect(hook('gh issue close 12').status).toBe(0)
    expect(hook('gh pr close 12').status).toBe(0)
  })

  // The escapes are INDEPENDENT: approving the #N refs must not wave a
  // file-fed body through — under the coarse rule the file is never read,
  // so a single escape cannot attest for both checks.
  it('keeps blocking a refs-approved file-fed merge until both escapes attest', () => {
    const { hook, repo } = makeRepo({ dbReady: true })
    writeFileSync(join(repo, 'merge-body.txt'), 'ship it\n\ntracks km-zzzz\n')
    const r = hook(`KM_ISSUE_REFS_OK=1 gh pr merge 12 --squash -F ${join(repo, 'merge-body.txt')}`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('post-publication read-back covers')
    const both = hook(`KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh pr merge 12 --squash -F ${join(repo, 'merge-body.txt')}`)
    expect(both.status).toBe(0)
  })

  // Same independence for --silent api mutations: the refs approval unlocks
  // the silent block, never the bead-id scan of the raw command.
  it('still scans refs-approved silent api mutations for bead ids', () => {
    const { hook } = makeRepo({ dbReady: true })
    const r = hook('KM_ISSUE_REFS_OK=1 gh api --silent repos/Stvad/knowledge-medium/issues/12/comments -f body=km-zzzz')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('km-zzzz')
    const both = hook(
      'KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh api --silent repos/Stvad/knowledge-medium/issues/12/comments -f body=km-zzzz',
    )
    expect(both.status).toBe(0)
  })

  // Position pin: the escape must be honored BEFORE the commit leg's
  // fail-closed blocks — both block messages advertise the KM_ISSUE_REFS_OK
  // re-run, which would otherwise block again forever.
  it('honors KM_ISSUE_REFS_OK ahead of the stdin and missing-file blocks', () => {
    const { hook } = makeRepo({ dbReady: true })
    expect(hook('KM_ISSUE_REFS_OK=1 cat msg | git commit -F -').status).toBe(0)
    expect(hook('KM_ISSUE_REFS_OK=1 cd subdir && git commit -F msg.txt').status).toBe(0)
  })

  // The commit leg reads its OWN message file, and no longer stands down when
  // the invocation is also read as publishing. Nothing observable changes for
  // the compound below — a commit file flag always trips the coarse rule, so
  // it was blocked before this too — but the leg no longer depends on a
  // detector that deliberately over-matches, and the file is read for the
  // reason it should be rather than by luck of a second guard.
  it('reads the commit message file, and blocks a compound either way', () => {
    const { hook, repo } = makeRepo({
      dbReady: true,
      ghIssues: { 700: A_PR },
    })
    writeFileSync(join(repo, 'msg.txt'), 'land it\n\nFixes #700\n')
    // alone: the file is read and its close keyword checked against reality
    const alone = hook(`git commit -F ${join(repo, 'msg.txt')}`)
    expect(alone.status).toBe(2)
    expect(alone.stderr).toContain('close keyword targets a PR')
    // beside a verb in argv: still blocked, nothing slips through
    const verb = ['gh', 'pr', 'create'].join(' ')
    expect(hook(`git commit -F ${join(repo, 'msg.txt')}; printf '%s' ${verb}`).status).toBe(2)
  })

  // The gate LOOKS UP but never MINTS. The detectors deliberately over-match,
  // and a verb sitting in ordinary unquoted argv reads as a publish — so a
  // mint here would create a public issue for a command that is about to be
  // blocked and never runs. An extra check costs a round; an extra issue does
  // not come back.
  it('never mints an issue, even for a real unmapped bead in a real publish', () => {
    const { hook, shimCalls } = makeRepo({
      dbReady: true,
      shows: [[{ id: 'km-zzzz', external_ref: null }]],
    })
    const r = hook('gh pr create --title t --body "tracks km-zzzz"')
    expect(r.status).toBe(2)
    expect(shimCalls()).toContain('bd show km-zzzz')
    expect(shimCalls()).not.toContain('bd github sync')
    expect(r.stderr).toContain('pnpm bd:sync')
  })

  // The same, through the shape that made this urgent: a verb in argv, where
  // blanking quoted spans protects nothing.
  it('does not spawn a sync for a bead id in a non-publishing command', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true, shows: [[{ id: 'km-nw01', external_ref: null }]] })
    const verb = ['gh', 'pr', 'create'].join(' ')
    const r = hook(`printf '%s' ${verb} km-nw01`)
    expect(shimCalls()).not.toContain('bd github sync')
    // the id is still surfaced rather than silently allowed
    if (r.status === 2) expect(r.stderr).toContain('km-nw01')
  })

  // A COVERED publish gets no body inspection at all: one gh command, no
  // shell operator, this repo, a verb whose output names a URL. The gate
  // reads no files and spawns nothing — bd-publish-verify reads the
  // published object back instead. These pins keep the deleted parsing
  // surface from growing back (#672: the pre-gate's surface is frozen;
  // decline coverage findings here).
  it('lets covered publishes through without body inspection (post-publication owns them)', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    expect(hook('gh pr create --title t --body "relates to #653"').status).toBe(0)
    expect(hook('gh pr create --body-file missing-body.md --title t').status).toBe(0)
    expect(hook('gh pr create --recover abc123 --title t').status).toBe(0)
    expect(hook('gh api repos/Stvad/knowledge-medium/issues/1/comments -f body=hi').status).toBe(0)
    expect(shimCalls()).toBe('')
  })

  // The same bodies through an OPERATOR are uncovered, and the ones whose
  // text the gate cannot read then attest. This is the deliberate cost of
  // the whitelist — the fix is a single --body-file command, above.
  it('attests operator-borne bodies the gate cannot read', () => {
    const { hook } = makeRepo({ dbReady: true })
    for (const cmd of [
      'gh pr comment 1 --body "$(cat body.md)"',
      'cat body.md | gh pr comment 12 -F -',
      'cd subdir; gh pr create --body-file missing-body.md --title t',
    ])
      expect(hook(cmd).status, cmd).toBe(2)
  })

  // A mode that prints or hands off creates nothing for the read-back to
  // find, so it is UNCOVERED — never exempt from publishing checks. Exempting
  // fails open, and the token is command-wide: a dry-run beside a real
  // publish, or --dry-run=false, would exempt a genuine publish. Uncovered
  // fails closed in all three, at the cost of one confirmation round.
  it('makes --dry-run and --web uncovered, never exempt from the checks', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: A_PR } })
    for (const cmd of [
      'gh pr create --title t --body "Fixes #700" --dry-run',
      'gh pr create --title t --body "Fixes #700" --web',
      // the disabled form still checks, rather than exempting itself
      'gh pr create --title t --body "Fixes #700" --dry-run=false',
      // a dry-run beside a REAL publish must not exempt the real one
      'gh pr create --title t --dry-run; gh issue comment 1 --body "Fixes #700"',
      // nor must a body that merely mentions the flag exempt anything
      'gh pr merge 12 --squash --body "run it with --dry-run first, Fixes #700"',
    ]) {
      const r = hook(cmd)
      expect(r.status, cmd).toBe(2)
      expect(r.stderr, cmd).toContain('close keyword targets a PR')
    }
  })

  // A `$` or backtick inside SINGLE quotes never expands, so it is published
  // text rather than a hidden argument — an inline markdown code span or a
  // price must not cost the maximum-friction round. Double-quoted, the shell
  // WOULD expand it, so that stays uncovered.
  it('treats single-quoted dollars and backticks as text, not expansion', () => {
    const { hook } = makeRepo({ dbReady: true })
    expect(hook("gh pr comment 652 --body 'the `isPostVerifiable` gate'").status).toBe(0)
    expect(hook("gh pr comment 652 --body 'costs $5 per run'").status).toBe(0)
    // double quotes DO expand, so the gate still refuses to call it covered
    expect(hook('gh pr comment 652 --body "see $(cat notes.md)"').status).toBe(2)
  })

  // The gate must never fail on its OWN bug: PreToolUse treats an unasked-for
  // non-zero exit as a hook error and runs the command anyway, so a throw
  // would disable every check while looking like a problem with the command.
  it('never exits non-zero for its own errors', () => {
    const { hook, repo } = makeRepo({ dbReady: true })
    mkdirSync(join(repo, 'a-directory.txt'))
    // a directory where a message file is expected takes the fail-closed
    // branch (exit 2 with the block message), not a stack trace
    const dir = hook(`git commit -F ${join(repo, 'a-directory.txt')} -m x`)
    expect(dir.status).toBe(2)
    expect(dir.stderr).toContain('a-directory.txt: is a directory')
    expect(dir.stderr).not.toContain('at readFileSync')
    // and a payload the hook cannot make sense of at all allows explicitly,
    // rather than throwing its way to the same outcome with a stack trace
    const malformed = spawnSync('node', [script, '--hook-pre-pr'], {
      input: JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command: 42 } }),
      encoding: 'utf8',
    })
    expect(malformed.status).toBe(0)
    expect(malformed.stderr).toBe('')
  })

  // The gh-vocabulary layer: flags and selectors that leave the read-back
  // nothing to fetch. A gap here is bounded by one tool's manual — and no
  // longer silent, since bd-publish-verify reports a coverage claim it
  // could not honour.
  it('treats response-hiding flags and foreign selectors as uncovered', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: A_PR } })
    for (const cmd of [
      // -t is --template's short form; on gh api it formats the response away
      'gh api -X PATCH repos/Stvad/knowledge-medium/pulls/12 -f body="Fixes #700" -t \'{{.id}}\'',
      'gh api -X PATCH repos/Stvad/knowledge-medium/pulls/12 -f body="Fixes #700" --template \'{{.id}}\'',
      // GH_REPO selects the repository the way -R does, and the read-back's
      // URL pattern is pinned to this one
      'GH_REPO=owner/other gh pr edit 12 --body="Fixes #700"',
    ])
      expect(hook(cmd).status, cmd).toBe(2)
    // -t on a CLI verb is --title, not a template: still covered
    expect(hook('gh pr create -t "a title" --body "relates to #700"').status).toBe(0)
  })

  // The two signals must be read off the SAME string. Testing expansion on
  // the raw command while testing operators on the skeleton — which blanks a
  // QUOTED expansion — let a command be a publish and post-verified at once.
  it('treats a quoted flag expansion as uncovered, not just an unquoted one', () => {
    const { hook } = makeRepo({ dbReady: true })
    // the quoted form is the subject here: the skeleton blanks it, so only
    // the raw-text read catches it. The unquoted form is pinned separately.
    const r = hook('gh api "${FLAGS:---input=payload.json}" repos/Stvad/knowledge-medium/issues/1/comments')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('post-publication read-back covers')
  })

  // With its flags expanded, an api mutation shows no literal mutation flag
  // — neither this gate nor the read-back would otherwise look at it.
  it('treats an expansion-flagged api call as a publish', () => {
    const { hook } = makeRepo({ dbReady: true })
    const r = hook('gh api $FLAGS repos/Stvad/knowledge-medium/issues/1/comments')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('post-publication read-back covers')
    // a literal read stays out of the publish path entirely
    expect(hook('gh api repos/Stvad/knowledge-medium/issues/1').status).toBe(0)
  })

  // Repair used to catch a bead id that reached a published api body; with
  // the verifier read-only, the gate takes the case it can see for free —
  // an id in the raw command blocks whether or not the publish is covered.
  it('blocks bead ids in a covered api publish', () => {
    const { hook } = makeRepo({ dbReady: true, shows: [[{ id: 'km-abcd', external_ref: 'https://github.com/Stvad/knowledge-medium/issues/12' }]] })
    const r = hook('gh api repos/Stvad/knowledge-medium/issues/1/comments -f body="tracks km-abcd"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('km-abcd')
  })

  // The commit leg: close keywords act when the commit reaches the default
  // branch, so they get the echo round; plain mentions and ordinary commits
  // pass with zero subprocesses.
  it('gates close-keyword refs in git commit messages', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: A_PR } })
    const r = hook('git commit -m "land the fix\n\nFixes #700"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
  })

  it('gates a close keyword behind git global options (git -C … commit)', () => {
    const { hook, repo } = makeRepo({ dbReady: true, ghIssues: { 700: A_PR } })
    const r = hook(`git -C ${repo} commit -m "Fixes #700"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
  })

  // A referenced commit-message file the hook cannot read fails CLOSED:
  // commit text never becomes a GitHub object, so no post-publication pass
  // can verify the close keywords it may hold.
  it('blocks a commit whose message file cannot be resolved', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    const r = hook('cd subdir && git commit -F msg.txt')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('msg.txt: does not exist at hook time')
    expect(shimCalls()).toBe('')
  })

  // The block prints what it found, never a cause: a composed diagnosis must
  // hold for every mix of these facts, and a file the same command writes
  // after this hook ran is one of them.
  it('prints facts about each unreadable message file, never a diagnosis', () => {
    const { hook, repo } = makeRepo({ dbReady: true })
    mkdirSync(join(repo, 'a-dir'))
    const heredoc = hook(`cat > ${repo}/msg.txt <<'EOF'\nfix: x\nEOF\ngit commit -F ${repo}/msg.txt`)
    const redirect = hook(`git log -1 --format=%B > m2.txt && git commit -q -F m2.txt`)
    const appended = hook(`echo more | tee -a 'm3.txt' && git commit -F m3.txt`)
    const plain = hook('git commit -F elsewhere.txt')
    const dir = hook(`git commit -F ${repo}/a-dir`)
    const device = hook('git commit -F /dev/null')
    const home = hook('git commit -F ~/km-no-such-message.txt')
    for (const r of [heredoc, redirect, appended, plain, dir, device, home]) expect(r.status).toBe(2)
    expect(device.stderr).toContain('/dev/null: is not a regular file')
    // a home path is not relative to the cwd
    expect(home.stderr).not.toContain('resolved against')
    expect(heredoc.stderr).toContain(`${repo}/msg.txt: does not exist at hook time; this command writes it`)
    expect(redirect.stderr).toContain(`${join(repo, 'm2.txt')}: does not exist at hook time; this command writes it`)
    expect(appended.stderr).toContain('m3.txt: does not exist at hook time; this command writes it')
    expect(plain.stderr).toContain(`${join(repo, 'elsewhere.txt')}: does not exist at hook time`)
    expect(plain.stderr).not.toContain('this command writes it')
    expect(dir.stderr).toContain(`${repo}/a-dir: is a directory`)
    // a relative path says what it was resolved against; an absolute one has nothing to say
    expect(plain.stderr).toContain(`relative paths resolved against ${repo}`)
    expect(heredoc.stderr).not.toContain('resolved against')
    for (const r of [heredoc, redirect, appended, plain, dir])
      expect(r.stderr).not.toMatch(/\bcd\b|chains|Run from|probably|likely|should|try /i)
  })

  // Root, and some sandboxes, read through permission bits, so these cases
  // run only where a mode-000 file is actually unreadable.
  it.skipIf(permissionBitsIgnored())('prints the fact for a file or directory the hook may not read', () => {
    const { hook, repo } = makeRepo({ dbReady: true })
    writeFileSync(join(repo, 'locked.txt'), 'Fixes #1')
    chmodSync(join(repo, 'locked.txt'), 0o000)
    mkdirSync(join(repo, 'sealed'))
    writeFileSync(join(repo, 'sealed', 'msg.txt'), 'Fixes #1')
    chmodSync(join(repo, 'sealed'), 0o000)
    const locked = hook(`git commit -F ${repo}/locked.txt`)
    const sealed = hook(`git commit -F ${repo}/sealed/msg.txt`)
    chmodSync(join(repo, 'sealed'), 0o755)
    expect(locked.status).toBe(2)
    expect(locked.stderr).toContain(`${repo}/locked.txt: is not readable by this hook`)
    expect(sealed.status).toBe(2)
    expect(sealed.stderr).toContain(`${repo}/sealed/msg.txt: cannot be examined by this hook (EACCES)`)
  })

  // No foreign-repo shortcut: three rounds of target-parse bypasses retired
  // it. Every publish runs the gate, -R or not — including the multi-segment
  // payload where a foreign first segment used to bypass a same-repo second.
  it('gates every publish regardless of -R, including multi-segment payloads', () => {
    const { hook } = makeRepo({ dbReady: true })
    expect(hook('gh --repo other/repo pr comment 12 -b "tracks km-zzzz"').status).toBe(2)
    const multi = hook('gh -R owner/other issue comment 1 -b ok; gh pr create -b "tracks km-zzzz"')
    expect(multi.status).toBe(2)
    expect(multi.stderr).toContain('km-zzzz')
  })

  // A quoted -R value is blanked by the skeleton; if that read as a foreign
  // target the gate would switch itself off (round-10 regression shape).
  it('still gates a publish whose same-repo -R value is quoted', () => {
    const { hook } = makeRepo({ dbReady: true })
    const r = hook('gh -R "Stvad/knowledge-medium" pr comment 12 -b "tracks km-zzzz"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('km-zzzz')
  })

  // The commit leg keeps the stdin fail-closed rule: a pipe-fed message is
  // text this gate cannot see and no post-publication pass ever will.
  it('fails closed on a pipe-fed commit message but lets heredoc stdin through', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: A_PR } })
    const piped = hook('cat msg.txt | git commit -F -')
    expect(piped.status).toBe(2)
    expect(piped.stderr).toContain('stdin')
    // quoting the sentinel blanked it in the skeleton and bypassed the rule
    const quoted = hook('cat msg.txt | git commit -F "-"')
    expect(quoted.status).toBe(2)
    expect(quoted.stderr).toContain('stdin')
    // /dev/stdin is stdin in disguise: reading it in the hook scans the
    // hook's own drained stream while git reads the piped file
    const device = hook('cat msg.txt | git commit -F /dev/stdin')
    expect(device.status).toBe(2)
    expect(device.stderr).toContain('stdin')
    const heredoc = hook('git commit -F - <<EOF\nFixes #700\nEOF')
    expect(heredoc.status).toBe(2)
    expect(heredoc.stderr).toContain('close keyword targets a PR')
  })

  // The command's addressee is not published text: a positional target URL
  // on a merge must not cost a confirmation round, while the same URL inside
  // the quoted merge body is merge-commit text and still verifies.
  it('ignores positional target URLs on merge but verifies URLs inside merge bodies', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const target = hook(`gh pr merge https://github.com/Stvad/knowledge-medium/pull/653 --body "looks good"`)
    expect(target.status).toBe(0)
    expect(shimCalls()).not.toContain('gh api')
    const inBody = hook(`gh pr merge 12 --body "see https://github.com/Stvad/knowledge-medium/issues/653"`)
    expect(inBody.status).toBe(2)
    expect(inBody.stderr).toContain('Real GC failure')
    // quoted prose that merely RESEMBLES a positional target keeps its refs:
    // the strip applies only when the skeleton confirms an unquoted target.
    // The prose must spell the FULL `gh pr comment <url>` shape — anything
    // less never matches the strip regex at all and pins nothing (found by
    // mutation: with a gh-less prose body, deleting the skeleton-confirm
    // guard failed no test while stripping refs out of real merge bodies).
    const prose = hook(`gh pr merge 12 --body "as gh pr comment https://github.com/Stvad/knowledge-medium/issues/653 said"`)
    expect(prose.status).toBe(2)
    expect(prose.stderr).toContain('Real GC failure')
  })

  // Argv tokens alone must not make the hook open a file: `printf … git commit -F
  // <path>` runs printf. Before the position check this blocked, reporting
  // the path as an unreadable message file — i.e. it had tried to read it.
  it('does not read a message file for a command that only mentions git commit', () => {
    const { hook } = makeRepo({ dbReady: true })
    const r = hook(`printf '%s' git commit -F /nonexistent/secret.env`)
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('secret.env')
  })

  it('lets plain-mention and escaped commits pass with zero lookups', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
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

  // A thread-resolve loop: its only expansion is a thread id, which lands in
  // an ID position — a node id GitHub validates, not text anyone reads — so
  // nothing it carries is outside what the gate can see.
  it('lets a graphql mutation through when every expansion lands in an ID position', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    const doc = 'mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}'
    for (const cmd of [
      `for t in PRRT_a PRRT_b; do gh api graphql -f query='${doc}' -f t="$t" --jq '.data.resolveReviewThread.thread.isResolved'; done`,
      `for t in PRRT_a; do gh api graphql -f query='mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { id isResolved } } }' -F id="$t" --jq '.data | "\\(.x) resolved"'; done`,
      // the document itself double-quoted, the id interpolated as a string literal
      `for t in PRRT_a PRRT_b; do\n  gh api graphql -f query="mutation { resolveReviewThread(input:{threadId:\\"$t\\"}) { thread { id isResolved } } }" --jq '.data.resolveReviewThread.thread | "\\(.id) resolved=\\(.isResolved)"'\ndone`,
    ])
      expect(hook(cmd).status, cmd).toBe(0)
    expect(shimCalls()).toBe('')
  })

  // What keeps it closed: an expansion anywhere a value could become text.
  it('keeps blocking a graphql mutation whose expansion could carry text', () => {
    const { hook } = makeRepo({ dbReady: true })
    for (const cmd of [
      // a String variable can be published
      `gh api graphql -f query='mutation($b:String!){addComment(input:{subjectId:"X",body:$b}){clientMutationId}}' -f b="$BODY"`,
      // an undeclared variable, and a custom scalar
      `gh api graphql -f query='mutation{resolveReviewThread(input:{threadId:"X"}){thread{id}}}' -f t="$t"`,
      `gh api graphql -f query='mutation($u:URI!){x(input:{url:$u}){id}}' -f u="$U"`,
      // an input object carries whatever fields its value holds
      `gh api graphql -f query='mutation($i:AddCommentInput!){addComment(input:$i){clientMutationId}}' -F i="$INPUT"`,
      // interpolated into a text argument, or into one that is not an id
      `gh api graphql -f query="mutation { addComment(input:{subjectId:\\"X\\", body:\\"$B\\"}) { clientMutationId } }"`,
      `gh api graphql -f query="mutation { enablePullRequestAutoMerge(input:{pullRequestId:\\"X\\", commitHeadline:\\"$H\\"}) { clientMutationId } }"`,
      // unquoted: word splitting can add arguments of its own
      `for t in a; do gh api graphql -f query='${RESOLVE}' -f t=$t; done`,
      // an expansion outside any field: its value is not visible anywhere
      `for t in $(cat ids); do gh api graphql -f query='${RESOLVE}' -f t="$t"; done`,
      // the document itself from a variable is never a variable field
      `gh api graphql -f query="$QUERY" -f t=x`,
      // a payload the gate cannot read
      `gh api graphql -f query='${RESOLVE}' --input vars.json`,
      // quoting a file field or a payload flag does not hide it from gh
      `gh api graphql -f query='mutation($b:String!){addComment(input:{subjectId:"X",body:$b}){clientMutationId}}' --field 'b=@body.md'`,
      `gh api graphql -f query='mutation($b:String!){addComment(input:{subjectId:"X",body:$b}){clientMutationId}}' -F b='@-'`,
      `gh api graphql -f query='${RESOLVE}' '--input' vars.json`,
      // a commit message file rides along: it is text outside the command
      `git commit -F msg.txt && git push && gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=PRRT_x`,
      // GraphQL ignores comments and commas between tokens: a real String
      // declaration split by either must still be seen, and a decoy in a
      // comment must not vouch for it
      `gh api graphql -f query='mutation($b # note\n: String!){addComment(input:{subjectId:"X",body:$b}){clientMutationId}} # $b:ID' -f b="$BODY"`,
      `gh api graphql -f query='mutation($b ,: String!){addComment(input:{subjectId:"$b:ID",body:$b}){clientMutationId}}' -f b="$BODY"`,
      // shell quoting that splits a declaration is rejoined before it is read
      `gh api graphql -f query='mutation($b'':'' String!){addComment(input:{subjectId:"$b:ID",body:$b}){clientMutationId}}' -f b="$BODY"`,
      // one name, two documents: it is text-safe only if every declaration is
      `gh api graphql -f query='${RESOLVE}' -f t="$t"; gh api graphql -f query='mutation($t:String!){addComment(input:{subjectId:"X",body:$t}){clientMutationId}}' -f t="$t"`,
    ])
      expect(hook(cmd).status, cmd).toBe(2)
  })

  // Readable text of a text-free mutation keeps the usual treatment: a
  // visible number is echoed with its title, a bead id denied.
  it('still echoes numbers visible in a graphql mutation command', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const r = hook(
      `for t in PRRT_a; do gh api graphql -f query='${RESOLVE}' -f t="$t" --jq '"done for #653"'; done`,
    )
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → "Real GC failure" (issue, open)')
  })

  // A document with no `mutation` operation writes nothing, whatever its
  // variables hold, so the command publishes nothing and nothing in it is
  // published text: not a bead id in a sibling `bd` command or a path, and
  // not jq's `@sh`, which is no file reference.
  it('treats a graphql read as publishing nothing', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    const read = `gh api graphql -f query='query{repository(owner:"Stvad",name:"knowledge-medium"){pullRequest(number:506){reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}'`
    for (const cmd of [
      `bd dep relate km-dt2e km-6l79 2>&1 | tail -2\n${read} --jq '.data | "\\(.id)"'`,
      `${read} --jq '.data.x' > /private/tmp/claude-501/km-merge/threads.txt`,
      `${read} --jq '[.data.x[] | .id] | @sh'`,
      `gh api graphql -f query='query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){id}}}' -F o=Stvad -F n=knowledge-medium -F p=506`,
      `for n in 1 2; do gh api graphql -f query='query($p:Int!){repository(owner:"Stvad",name:"knowledge-medium"){pullRequest(number:$p){id}}}' -F p="$n"; done`,
      // in a read even a String variable writes nothing
      `for o in Stvad; do gh api graphql -f query='query($o:String!){repositoryOwner(login:$o){id}}' -f o="$o"; done`,
    ])
      expect(hook(cmd).status, cmd).toBe(0)
    expect(shimCalls()).toBe('')
  })

  // A read never reaches a lookup or a block, however it is wrapped.
  it('passes looped, piped and substituted REST reads untouched', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    for (const cmd of [
      `for n in 449 466; do gh api -X GET "repos/Stvad/knowledge-medium/issues/$n/timeline" --jq '.[] | .event' | tail -4; done`,
      `gh api repos/Stvad/knowledge-medium/commits/$(gh pr view 1347 --json mergeCommit --jq .mergeCommit.oid) --jq '.parents | length'`,
    ])
      expect(hook(cmd).status, cmd).toBe(0)
    expect(shimCalls()).toBe('')
  })

  it('does not extend the read exemption to anything beside a graphql read', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const read = `gh api graphql -f query='query{viewer{login}}'`
    for (const cmd of [
      `${read} && gh api repos/Stvad/knowledge-medium/issues/1/comments -f body="see #653"`,
      `${read} && gh pr comment 1 --body "see #653"`,
      // a CLI publish beside it keeps its own text-outside-the-command rule
      `${read} && gh pr comment 1 -F notes.md`,
      // a gh call the publish detectors cannot spell still counts against it
      `${read} && gh \\\n  api repos/Stvad/knowledge-medium/issues/1/comments -f body="see #653"`,
      // a mutation document anywhere in the invocation is not a read
      `${read}; gh api graphql -f query='mutation{addComment(input:{subjectId:"X",body:"see #653"}){clientMutationId}}'`,
    ])
      expect(hook(cmd).status, cmd).toBe(2)
  })

  // The Autofix reply as one covered command: the read-back owns its body,
  // exactly as it owns a --body-file on a covered gh publish.
  it('lets a bare pr:reply through unread, and blocks one behind an operator', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    expect(hook('pnpm pr:reply 1048 4040271733 missing-body.md').status).toBe(0)
    expect(shimCalls()).toBe('')
    // its text is always in a file, so uncovered it is text outside the command
    const r = hook('cd sub; pnpm pr:reply 1048 4040271733 missing-body.md')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('post-publication read-back covers')
    // a leading cd only picks where it runs
    expect(hook('cd sub && pnpm pr:reply 1048 4040271733 missing-body.md --resolve').status).toBe(0)
    // beside a graphql read it is still a publish in its own right
    expect(hook(`gh api graphql -f query='query{viewer{login}}' && pnpm pr:reply 1 2 b.md`).status).toBe(2)
  })

  // A refused compound runs NONE of its steps, so the message says so, names
  // what made it uncovered, and gives the shape that passes — the retry that
  // follows must not publish a body file the refused call never wrote.
  it('says nothing ran, names the token, and gives the one-shape recipe', () => {
    const { hook } = makeRepo({ dbReady: true })
    const r = hook(`cat > pr-body.md <<'EOF'\nbody\nEOF\ngh pr create --title t --body-file pr-body.md`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('nothing in this command ran')
    expect(r.stderr).toContain('the redirect `>`')
    expect(r.stderr).toContain('the heredoc `<<`')
    expect(r.stderr).toContain('Its text comes from `--body-file`')
    expect(r.stderr).toContain('with the Write tool to a NEW file in your session scratchpad')
    expect(r.stderr).toContain('--body-file <scratchpad>/pr-body.md')
    const piped = hook('gh pr create --title t --body-file b.md 2>&1 | tail -3')
    expect(piped.stderr).toContain('the redirect `2>&1`')
    expect(piped.stderr).toContain('the pipe `|`')
    expect(hook('pnpm pr:reply 1 2 "$F"').stderr).toContain('the expansion `$F`')
    expect(hook('gh pr comment 1 --body "$(cat notes.md)"').stderr).toContain('the expansion `$(…)`')
    // a verb no spelling makes covered gets the inline advice instead
    const merge = hook('gh pr merge 12 -F msg.txt')
    expect(merge.stderr).toContain('because of `gh pr merge`')
    expect(merge.stderr).toContain('put the text inline')
    expect(merge.stderr).not.toContain('Write tool')
    // with a stale file too, the escapes come with a new file, never alone
    const staleMerge = hook('gh pr merge 12 -F /tmp/claude-501/m.txt')
    expect(staleMerge.stderr).toContain('Write the text afresh')
    expect(staleMerge.stderr).toContain('or, with the text in a new file, after checking every #N')
  })

  // Every session writes to /tmp/claude-<uid>/, so a body file there outside a
  // session's own scratchpad can be another session's — the measured way a
  // stale body with a foreign close keyword got published. No escape lifts it.
  it("refuses a body file in the shared tmp outside a session's scratchpad", () => {
    const { hook, repo, shimCalls } = makeRepo({ dbReady: true })
    for (const cmd of [
      'gh pr create --title t --body-file /tmp/claude-501/pr-body.md',
      'gh pr edit 1 --body-file=/private/tmp/claude-501/km-1024-scratch/msg2.txt',
      'gh issue comment 1 -F/tmp/claude-501/c.md',
      'pnpm pr:reply 1048 4040271733 /tmp/claude-501/reply.md --resolve',
      'gh api repos/Stvad/knowledge-medium/issues/1/comments -F body=@/tmp/claude-501/c.md',
      'gh pr create --title t -T /tmp/claude-501/stale.md',
      // on a CLI verb a body path keeps its `=`
      'gh pr comment 1 --body-file /tmp/claude-501/dir=x/body.md',
      'gh pr comment 1 -F /tmp/claude-501/old=body.md',
      'gh api repos/Stvad/knowledge-medium/issues/1/comments --input /tmp/claude-501/payload.json',
      // short clusters spell the same flags
      'gh pr create --title t -dF /tmp/claude-501/pr-body.md',
      'gh api repos/Stvad/knowledge-medium/issues/1/comments -iFbody=@/tmp/claude-501/c.md',
      'gh issue create --title t --template=/tmp/claude-501/stale.md',
      'KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh pr merge 1 -F /tmp/claude-501/m.txt',
    ]) {
      const r = hook(cmd)
      expect(r.status, cmd).toBe(2)
      expect(r.stderr, cmd).toContain('nothing in this command ran')
      expect(r.stderr, cmd).toContain("outside this session's scratchpad")
    }
    // resolved against the directory the command runs in
    const relative = hook('gh pr create --title t --body-file pr-body.md', { cwd: '/tmp/claude-501' })
    expect(relative.stderr).toContain('/tmp/claude-501/pr-body.md: in /tmp/claude-501/')
    expect(hook('cd /tmp/claude-501 && gh pr create --title t --body-file pr-body.md').status).toBe(2)
    // a session's own scratchpad is its own
    expect(hook('gh pr create --title t --body-file /private/tmp/claude-501/-Users-x-wt/0b3c9d2e/scratchpad/pr-body.md').status).toBe(0)
    // and another running session's is not
    const own = { session_id: 'sess-a' }
    expect(hook('gh pr create --title t --body-file /private/tmp/claude-501/-Users-x-wt/sess-a/scratchpad/pr-body.md', own).status).toBe(0)
    expect(hook('gh pr create --title t --body-file /private/tmp/claude-501/-Users-x-wt/sess-b/scratchpad/pr-body.md', own).status).toBe(2)
    // a path is judged once `..` is resolved
    expect(hook('gh pr create --title t --body-file /private/tmp/claude-501/-Users-x-wt/sess-a/x/../scratchpad/b.md', own).status).toBe(0)
    expect(hook('gh pr create --title t --body-file /private/tmp/claude-501/-Users-x-wt/sess-a/scratchpad/../../sess-b/b.md', own).status).toBe(2)
    // gh api's --template formats its answer; a graphql document from a file is checked like a body
    expect(hook("KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh api repos/Stvad/knowledge-medium/issues/1/comments -f body=hi --template /tmp/claude-501/t").status).toBe(0)
    expect(hook('KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh api graphql -F query=@/tmp/claude-501/q.graphql').status).toBe(2)
    // a quoted `">"` is an argument, so the field after it is still read
    expect(hook('KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh api repos/Stvad/knowledge-medium/issues/1/comments ">" -F body=@/tmp/claude-501/c.md').status).toBe(2)
    // a symlink is judged by the file it names
    const shared = mkdtempSync('/tmp/claude-gate-test-')
    writeFileSync(join(shared, 'body.md'), 'another session')
    symlinkSync(join(shared, 'body.md'), join(repo, 'link.md'))
    const linked = hook('gh pr create --title t --body-file link.md')
    expect(linked.status).toBe(2)
    expect(linked.stderr).toContain("which every session shares, and outside this session's scratchpad")
    rmSync(shared, { recursive: true, force: true })
    // a read is not a publish
    expect(hook('gh api repos/Stvad/knowledge-medium/issues/1 > /tmp/claude-501/issue.json').status).toBe(0)
    expect(shimCalls()).toBe('')
  })

  it('refuses a body file written before the session started', () => {
    const { hook, repo } = makeRepo({ dbReady: true })
    const hourAgo = new Date(Date.now() - 3_600_000)
    writeFileSync(join(repo, 'old-body.md'), 'from an earlier session')
    utimesSync(join(repo, 'old-body.md'), hourAgo, hourAgo)
    // the session began ten minutes ago, by the first timestamp its transcript records
    const started = Date.now() - 600_000
    const transcript = join(repo, 'sess.jsonl')
    // a resumed transcript can open with a later queue entry ahead of the history it copies
    writeFileSync(
      transcript,
      `{"type":"bridge-session"}\n{"type":"queue-operation","timestamp":"${new Date().toISOString()}"}\n{"type":"user","timestamp":"${new Date(started).toISOString()}"}\n`,
    )
    const session = { session_id: 'sess', transcript_path: transcript }
    const early = new Date(started + 30_000)
    writeFileSync(join(repo, 'early-body.md'), 'written early in this session')
    utimesSync(join(repo, 'early-body.md'), early, early)
    expect(hook('gh pr create --title t --body-file early-body.md', session).status).toBe(0)
    const r = hook('gh pr create --title t --body-file old-body.md', session)
    expect(r.status).toBe(2)
    // as stored: a file system may round the time it was given
    const stored = new Date(statSync(join(repo, 'old-body.md')).mtimeMs).toISOString()
    expect(r.stderr).toContain(`${join(repo, 'old-body.md')}: last written ${stored}, before this session started`)
    writeFileSync(join(repo, 'new-body.md'), 'written in this session')
    expect(hook('gh pr create --title t --body-file new-body.md', session).status).toBe(0)
    // even one the command rewrites: whether the write runs first is the
    // command's order, which this gate does not read
    for (const cmd of [
      `KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 cat > old-body.md <<'EOF'\nx\nEOF\ngh pr create --title t --body-file old-body.md`,
      'KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh pr create --title t --body-file old-body.md && printf fresh > old-body.md',
    ])
      expect(hook(cmd, session).status, cmd).toBe(2)
    // a subagent's session began with the main transcript, not its own
    const beforeSubagent = new Date(started + 60_000)
    utimesSync(join(repo, 'new-body.md'), beforeSubagent, beforeSubagent)
    mkdirSync(join(repo, 'sess', 'subagents'), { recursive: true })
    writeFileSync(join(repo, 'sess', 'subagents', 'agent-1.jsonl'), `{"timestamp":"${new Date().toISOString()}"}\n`)
    const sub = { session_id: 'sess', agent_id: 'a1', transcript_path: join(repo, 'sess', 'subagents', 'agent-1.jsonl') }
    expect(hook('gh pr create --title t --body-file new-body.md', sub).status).toBe(0)
    // a name the shell expands could be any file, so it is refused, never passed
    for (const cmd of [
      'gh pr create --title t --body-file old-*.md',
      'gh pr create --title t --body-file ~+/old-body.md',
      'gh pr create --title t --body-file ~someone/old-body.md',
      'KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 gh pr create --title t --body-file "$S/pr-body.md"',
    ]) {
      const expanded = hook(cmd, session)
      expect(expanded.status, cmd).toBe(2)
      expect(expanded.stderr, cmd).toContain('a name the shell expands')
    }
    // in a compound command another step can move to another directory, or
    // make, relink or rewrite the file first, so a file-fed publish passes
    // only as a command of its own
    mkdirSync(join(repo, 'sub'))
    for (const cmd of [
      'cd -- sub && gh pr create --title t --body-file new-body.md',
      'builtin cd sub; gh pr create --title t --body-file new-body.md',
      'ln -s /x linked.md && gh pr create --title t --body-file linked.md',
      `cp /x ${join(repo, 'new-body.md')} && gh pr create --title t --body-file ${join(repo, 'new-body.md')}`,
      `gh pr create --title t --body-file ${join(repo, 'new-body.md')} | tail`,
    ]) {
      const chained = hook(`KM_ISSUE_REFS_OK=1 KM_ALLOW_BEAD_IDS=1 ${cmd}`, session)
      expect(chained.status, cmd).toBe(2)
      expect(chained.stderr, cmd).toContain('other commands chained to it')
    }
    expect(hook(`gh pr create --title t --body-file ${join(repo, 'new-body.md')}`, session).status).toBe(0)
    // behind a wrapper the directory is the wrapper's, so a name there must be absolute
    const wrapped = hook('env -C sub gh pr create --title t --body-file old-body.md', session)
    expect(wrapped.status).toBe(2)
    expect(wrapped.stderr).toContain('relative, behind `env`')
    expect(hook(`env -C sub gh pr create --title t --body-file ${join(repo, 'new-body.md')}`, session).status).toBe(0)
    // a publisher run directly reads the name where the command runs
    for (const cmd of [
      'KM_ISSUE_REFS_OK=1 gh pr create --title t --body-file new-body.md',
      'node scripts/pr-reply.mjs 1385 1 new-body.md',
      'scripts/pr-reply.mjs 1385 1 new-body.md',
    ])
      expect(hook(cmd, session).status, cmd).toBe(0)
    // the leading cd is placed, so a relative name after it is still read
    expect(hook('cd sub && gh pr create --title t --body-file ../new-body.md', session).status).toBe(0)
    // no transcript, no session start: nothing to compare
    expect(hook('gh pr create --title t --body-file old-body.md').status).toBe(0)
  })

  // An attestation is the agent's word that it read the number. Review loops
  // repeat the same #N in every commit and reply, so once a session has given
  // it, a command repeating only attested numbers passes, with their titles
  // as context rather than a block.
  it('passes numbers attested earlier in the same session, with their titles as context', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const session = { session_id: 'sess-1' }
    expect(hook('git commit -m "Fixes #653"', session).status).toBe(2)
    expect(hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"', session).status).toBe(0)
    const again = hook('git commit -m "follow-up\n\nFixes #653"', session)
    expect(again.status).toBe(0)
    const out = JSON.parse(again.stdout).hookSpecificOutput
    expect(out.hookEventName).toBe('PreToolUse')
    expect(out.additionalContext).toContain('#653 → "Real GC failure" (issue, open)')
    // context only: the host's own permission flow still decides
    expect(out).not.toHaveProperty('permissionDecision')
    // readable text of a blind publish reads the same memo
    expect(hook('gh pr merge 12 --squash --body "relates to #653"', session).status).toBe(0)
    // another session has attested nothing, and payloads with no session share no memo
    expect(hook('git commit -m "Fixes #653"', { session_id: 'sess-2' }).status).toBe(2)
    expect(hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"').status).toBe(0)
    expect(hook('git commit -m "Fixes #653"').status).toBe(2)
  })

  it('still blocks when any number in the command was not attested', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE, 700: A_PR } })
    const session = { session_id: 'sess-1' }
    hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"', session)
    const r = hook('git commit -m "Fixes #653, fixes #700"', session)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#700 → "Some PR"')
    expect(r.stderr).toContain('#653 → "Real GC failure"')
  })

  // The attestation vouched for a title; a number that no longer resolves
  // has none to vouch for.
  it('still blocks an attested number that does not resolve now', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const session = { session_id: 'sess-1' }
    expect(hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #999"', session).status).toBe(0)
    const r = hook('git commit -m "Fixes #999"', session)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#999 → NO SUCH ISSUE OR PR')
  })

  // An attestation vouched for which issue a number is, not for closing it:
  // a close keyword that draws a warning still blocks.
  it('still blocks an attested number used with a close keyword that draws a warning', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 700: A_PR } })
    const session = { session_id: 'sess-1' }
    hook('KM_ISSUE_REFS_OK=1 gh pr merge 12 --body "relates to #700"', session)
    expect(hook('gh pr merge 12 --body "relates to #700"', session).status).toBe(0)
    const r = hook('git commit -m "Fixes #700"', session)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('close keyword targets a PR')
  })

  it('still blocks an attested number whose lookup fails now', () => {
    const { hook, repo } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const session = { session_id: 'sess-1' }
    hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"', session)
    // a lookup that answers garbage is a failed lookup, not a title
    writeFileSync(join(repo, 'gh-issue-653.json'), 'not json')
    const r = hook('git commit -m "Fixes #653"', session)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → COULD NOT VERIFY')
  })

  it('reads only whole numbers from a memo, and keeps a subagent to its own', () => {
    const { hook, repo } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    mkdirSync(join(repo, 'tmp', 'km-publish-gate'))
    writeFileSync(join(repo, 'tmp', 'km-publish-gate', 'sess-1.json'), JSON.stringify({ attested: ['653'] }))
    expect(hook('git commit -m "Fixes #653"', { session_id: 'sess-1' }).status).toBe(2)
    hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"', { session_id: 'sess-1', agent_id: 'a1' })
    expect(hook('git commit -m "Fixes #653"', { session_id: 'sess-1', agent_id: 'a1' }).status).toBe(0)
    expect(hook('git commit -m "Fixes #653"', { session_id: 'sess-1', agent_id: 'a2' }).status).toBe(2)
    // an agent id that is not a plain name gets no memo, rather than a path
    hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"', { session_id: 'sess-1', agent_id: '../../escape' })
    expect(existsSync(join(repo, 'escape.json'))).toBe(false)
    expect(hook('git commit -m "Fixes #653"', { session_id: 'sess-1', agent_id: '../../escape' }).status).toBe(2)
    expect(hook('git commit -m "Fixes #653"', { session_id: 'sess-1' }).status).toBe(2)
  })

  // An attestation covers what the echo showed: not a positional target
  // address, not a plain mention in a commit message (only close keywords are
  // echoed there), and nothing for a covered publish, which echoes nothing.
  it('records only the numbers an echo would have shown', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE, 700: A_PR } })
    const session = { session_id: 'sess-1' }
    hook('KM_ISSUE_REFS_OK=1 gh issue close https://github.com/Stvad/knowledge-medium/issues/653 -c "see #700"', session)
    hook('KM_ISSUE_REFS_OK=1 git commit -m "see #653"', session)
    hook('KM_ISSUE_REFS_OK=1 gh pr comment 1 --body "relates to #653"', session)
    const r = hook('gh pr merge 12 --body "relates to #653"', session)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('#653 → "Real GC failure"')
    // the number that was shown is attested
    expect(hook('gh pr merge 12 --body "relates to #700"', session).status).toBe(0)
  })

  // A bead id is substituted, never attested.
  it('keeps bead ids blocked in a session that attested every number', () => {
    const { hook } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    const session = { session_id: 'sess-1' }
    hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"', session)
    const r = hook('gh pr merge 12 --body "tracks km-zzzz, relates to #653"', session)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('km-zzzz')
  })

  it('keys the memo by session id under the temp dir, and ignores an id that is not a plain name', () => {
    const { hook, repo } = makeRepo({ dbReady: true, ghIssues: { 653: AN_ISSUE } })
    hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"', { session_id: 'sess-1' })
    expect(existsSync(join(repo, 'tmp', 'km-publish-gate', 'sess-1.json'))).toBe(true)
    hook('KM_ISSUE_REFS_OK=1 git commit -m "Fixes #653"', { session_id: '../escape' })
    expect(existsSync(join(repo, 'tmp', 'escape.json'))).toBe(false)
    expect(hook('git commit -m "Fixes #653"', { session_id: '../escape' }).status).toBe(2)
  })

  // A branch is an address, not a reference, even one named after a bead.
  it('does not read --head/--base values as bead-id references', () => {
    const { hook, shimCalls } = makeRepo({ dbReady: true })
    expect(hook('gh pr create --base master --head claude/km-avrg-retain-measure --title t --body-file pr-body.md').status).toBe(0)
    expect(hook('gh pr create --base master --head km-zzzz --title t --body "clean"').status).toBe(0)
    expect(hook("gh pr create -B master -H 'km-zzzz' --title t --body clean").status).toBe(0)
    // gh takes the short flags' values attached too
    expect(hook('gh pr create -Brelease/km-zzzz -Hfeature/km-zzzz --title t --body clean').status).toBe(0)
    expect(shimCalls()).toBe('')
    // the strip stops at the flag's own value: body text still counts
    const body = hook('gh pr create --head km-zzzz --title t --body "tracks km-zzzz"')
    expect(body.status).toBe(2)
    expect(body.stderr).toContain('km-zzzz')
    // a branch flag glued into a value is the value's text, not a flag
    const glued = hook('gh pr create --title t --body=--head=km-zzzz')
    expect(glued.status).toBe(2)
    expect(glued.stderr).toContain('km-zzzz')
    // a branch flag spelled inside an api payload value is payload text
    const payload = hook('gh api --silent repos/Stvad/knowledge-medium/issues/1/comments -f body=--head=km-zzzz')
    expect(payload.status).toBe(2)
    expect(payload.stderr).toContain('km-zzzz')
    // and a flag quoted inside the published body is text, not a flag
    const quoted = hook('gh pr create --title t --body "branch --head km-zzzz"')
    expect(quoted.status).toBe(2)
    expect(quoted.stderr).toContain('km-zzzz')
  })
})
