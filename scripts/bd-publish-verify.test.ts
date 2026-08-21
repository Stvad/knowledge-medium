import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { matchesApiPublish, publishableKinds } from './bd-github-sync.mjs'
import { apiPathFor, clipContext, mergedPrNumbers, publishedTargets } from './bd-publish-verify.mjs'

const PR_CREATE = 'gh pr create --title t --body-file /tmp/x.md'
// A compound whose verbs produce every kind — for tests that exercise
// classification rather than the kind filter.
const ALL_KINDS_CMD =
  'gh pr create -F a; gh issue edit 1 -F b; gh release edit v1 -F c; gh pr comment 1 -F d; gh pr review 1 -b e'
const url = (path: string) => `https://github.com/Stvad/knowledge-medium/${path}`

describe('matchesApiPublish', () => {
  it('matches gh api mutations: explicit method, attached method, field flags (attached too)', () => {
    expect(matchesApiPublish('gh api -X PATCH repos/Stvad/knowledge-medium/pulls/652 --input -')).toBe(true)
    expect(matchesApiPublish('gh api -XPATCH repos/Stvad/knowledge-medium/pulls/652 --input -')).toBe(true)
    expect(matchesApiPublish('gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=hi')).toBe(true)
    expect(matchesApiPublish('gh api repos/Stvad/knowledge-medium/issues/652/comments -fbody=hi')).toBe(true)
    expect(matchesApiPublish('gh api repos/Stvad/knowledge-medium/issues/652/comments -Fbody=@notes.md')).toBe(true)
    expect(matchesApiPublish('cat x | gh api graphql -f query=@-')).toBe(true)
  })

  // Explicit-GET commands still MATCH: a compound can mix a GET segment with
  // a mutating one, so the look must happen. Reading back an object a GET
  // merely printed costs one echoed line.
  it('keeps looking at explicit-GET field commands; only plain no-field reads stay out', () => {
    expect(matchesApiPublish('gh api repos/Stvad/knowledge-medium/issues/652')).toBe(false)
    expect(matchesApiPublish('gh api --method GET repos/Stvad/knowledge-medium/issues -f state=open')).toBe(true)
  })

  it('ignores quoted prose and non-api gh commands', () => {
    expect(matchesApiPublish('git commit -m "reply via gh api -X POST later"')).toBe(false)
    expect(matchesApiPublish('gh pr view 652')).toBe(false)
  })
})

describe('publishableKinds', () => {
  it('maps publish verbs to the kinds their output can name', () => {
    expect([...publishableKinds('gh pr create --title t')]).toEqual(['pr'])
    expect([...publishableKinds('gh issue close 9 -c done')].sort()).toEqual(['comment', 'issue'])
    expect([...publishableKinds('gh pr comment 1 -b x')]).toEqual(['comment'])
    expect([...publishableKinds('gh release create v1 --notes n')]).toEqual(['release'])
    expect([...publishableKinds(ALL_KINDS_CMD)].sort()).toEqual([
      'comment',
      'issue',
      'pr',
      'release',
      'review',
      'review-comment',
    ])
  })

  it('does not read verbs out of quoted prose', () => {
    expect([...publishableKinds('gh pr comment 1 -b "later run gh issue edit 2"')]).toEqual(['comment'])
  })
})

describe('publishedTargets', () => {
  it('classifies every kind from CLI publish output, deduplicated', () => {
    const out = [
      'Creating pull request for x into master',
      url('pull/652'),
      url('pull/652'),
      url('issues/643'),
      url('releases/tag/v1.2.0'),
      url('pull/652#issuecomment-99'),
      url('pull/652#discussion_r41'),
      url('pull/652#pullrequestreview-7'),
    ].join('\n')
    expect(publishedTargets(ALL_KINDS_CMD, out)).toEqual([
      { kind: 'pr', number: 652 },
      { kind: 'issue', number: 643 },
      { kind: 'release', tag: 'v1.2.0' },
      { kind: 'comment', id: 99 },
      { kind: 'review-comment', id: 41 },
      { kind: 'review', pr: 652, id: 7 },
    ])
  })

  // The kind filter: the Bash tool merges the whole invocation's output, so
  // a sibling command's printed URL of a kind this command's verbs cannot
  // produce must not even be fetched.
  it('drops CLI targets whose kind the command cannot have produced', () => {
    const out = `${url('issues/500')}\n${url('pull/652')}`
    expect(publishedTargets(PR_CREATE, out)).toEqual([{ kind: 'pr', number: 652 }])
  })

  it('ignores foreign-repo URLs and output with no target', () => {
    expect(publishedTargets(PR_CREATE, 'https://github.com/other/repo/pull/1')).toEqual([])
    expect(publishedTargets(PR_CREATE, 'nothing here')).toEqual([])
  })

  // The injection pin: a gh api response's body can QUOTE foreign URLs (a
  // comment quoting another PR); only the top-level html_url may become a
  // target, else the verifier would fetch and report an object this
  // command never touched.
  it('takes only the top-level html_url from gh api output, never URLs quoted in the body', () => {
    const cmd = 'gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=hi'
    const out = JSON.stringify({
      html_url: url('pull/652#issuecomment-99'),
      body: `see ${url('pull/500')} and ${url('issues/501')}`,
    })
    expect(publishedTargets(cmd, out)).toEqual([{ kind: 'comment', id: 99 }])
  })

  // The Bash tool merges stderr into stdout, so gh chatter (update notices)
  // can surround the JSON — recover the object line instead of giving up.
  it('recovers the api response line from merged stderr chatter', () => {
    const cmd = 'gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=hi'
    const out = `A new release of gh is available!\n${JSON.stringify({ html_url: url('pull/652#issuecomment-99') })}`
    expect(publishedTargets(cmd, out)).toEqual([{ kind: 'comment', id: 99 }])
  })

  it('yields no targets for api output without a top-level html_url', () => {
    const cmd = 'gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=hi'
    expect(publishedTargets(cmd, `posted!\n${url('pull/500')}`)).toEqual([])
    expect(publishedTargets('gh api graphql -f query=@q.graphql', '{"data":{}}')).toEqual([])
  })

  // A sibling command can print an html_url object of its own; picking one
  // line would be output→command association, so ALL object lines are read
  // back — an extra one costs a line of echo, not a wrong write.
  it('unwraps --slurp/--paginate array responses', () => {
    const cmd = 'gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=hi --paginate --slurp'
    const out = JSON.stringify([{ html_url: url('pull/652#issuecomment-99') }])
    expect(publishedTargets(cmd, out)).toEqual([{ kind: 'comment', id: 99 }])
  })

  it('collects every api output line with an html_url, not the first', () => {
    const cmd = 'gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=hi'
    const out = [
      JSON.stringify({ html_url: url('issues/12') }),
      JSON.stringify({ html_url: url('pull/652#issuecomment-99') }),
    ].join('\n')
    expect(publishedTargets(cmd, out)).toEqual([
      { kind: 'issue', number: 12 },
      { kind: 'comment', id: 99 },
    ])
  })
  // One Bash event can carry both a CLI publisher and an api publisher;
  // picking a single mode by command kind dropped whichever the other mode
  // owned.
  it('keeps both targets when one invocation publishes via CLI and api', () => {
    const cmd = 'gh pr comment 1 -b hi && gh api repos/Stvad/knowledge-medium/issues/12 -X PATCH -f body=x'
    const out = [url('pull/652#issuecomment-99'), JSON.stringify({ html_url: url('issues/12') })].join('\n')
    expect(publishedTargets(cmd, out)).toEqual([
      { kind: 'comment', id: 99 },
      { kind: 'issue', number: 12 },
    ])
  })
})

describe('mergedPrNumbers strategies', () => {
  // gh prints "Squashed and merged" / "Rebased and merged" for the other two
  // strategies; matching only "Merged" left the merge-commit read-back dead
  // for both — and squash is the strategy whose PR body carries the keywords
  // no pre-gate can read.
  it('reads the PR number from every merge strategy gh prints', () => {
    expect(mergedPrNumbers('✓ Merged pull request Stvad/knowledge-medium#652 (T)')).toEqual([652])
    expect(mergedPrNumbers('✓ Squashed and merged pull request Stvad/knowledge-medium#652 (T)')).toEqual([652])
    expect(mergedPrNumbers('✓ Rebased and merged pull request Stvad/knowledge-medium#652 (T)')).toEqual([652])
    // a foreign qualifier is still refused, and git's own subject is not a merge line
    expect(mergedPrNumbers('✓ Squashed and merged pull request other/repo#652 (T)')).toEqual([])
    expect(mergedPrNumbers('Merge pull request #652 from a/b')).toEqual([])
  })
})

describe('apiPathFor tag encoding', () => {
  it('sends a slashed release tag as one path parameter', () => {
    expect(apiPathFor({ kind: 'release', tag: 'release/1.0' })).toBe(
      'repos/Stvad/knowledge-medium/releases/tags/release%2F1.0',
    )
    // an already-encoded capture must not be encoded twice
    expect(apiPathFor({ kind: 'release', tag: 'release%2F1.0' })).toBe(
      'repos/Stvad/knowledge-medium/releases/tags/release%2F1.0',
    )
  })
})

describe('mergedPrNumbers', () => {
  it('reads PR numbers from gh merge success lines only', () => {
    expect(mergedPrNumbers('✓ Merged pull request #652 (feat x)\n✓ Deleted branch')).toEqual([652])
    expect(mergedPrNumbers('Merged pull request Stvad/knowledge-medium#12 (y)')).toEqual([12])
    expect(mergedPrNumbers('relates to #700 and pull request #12')).toEqual([])
    // a -R merge prints a foreign qualifier — never read back OUR PR of that number
    expect(mergedPrNumbers('Merged pull request other/repo#12 (y)')).toEqual([])
  })
})

describe('apiPathFor', () => {
  it('maps each target kind to its REST resource', () => {
    expect(apiPathFor({ kind: 'pr', number: 5 })).toBe('repos/Stvad/knowledge-medium/pulls/5')
    expect(apiPathFor({ kind: 'issue', number: 5 })).toBe('repos/Stvad/knowledge-medium/issues/5')
    expect(apiPathFor({ kind: 'comment', id: 7 })).toBe('repos/Stvad/knowledge-medium/issues/comments/7')
    expect(apiPathFor({ kind: 'review-comment', id: 7 })).toBe('repos/Stvad/knowledge-medium/pulls/comments/7')
    expect(apiPathFor({ kind: 'review', pr: 5, id: 7 })).toBe('repos/Stvad/knowledge-medium/pulls/5/reviews/7')
    expect(apiPathFor({ kind: 'release', tag: 'v1' })).toBe('repos/Stvad/knowledge-medium/releases/tags/v1')
  })
})

describe('clipContext', () => {
  it('passes short text through and clips long text with a notice', () => {
    expect(clipContext('short')).toBe('short')
    const clipped = clipContext('x'.repeat(20_000))
    expect(clipped.length).toBeLessThanOrEqual(9_000)
    expect(clipped).toContain('[bd-publish-verify]')
  })

  it('never ends the clipped slice on a lone surrogate', () => {
    const clipped = clipContext('🚨'.repeat(10_000), 101)
    expect(Buffer.from(clipped, 'utf8').toString('utf8')).toBe(clipped)
  })
})

// Process pins: the fail-open contract (exit 0 always, silence unless there
// is something to say) and the read-back loop.
// Measured ~200ms per spawn solo; budgeted for the 6x load stretch.
describe('bd-publish-verify process behavior', { timeout: 30_000 }, () => {
  const script = fileURLToPath(new URL('./bd-publish-verify.mjs', import.meta.url))

  const makeRepo = (opts: {
    dbReady?: boolean
    fixtures?: Record<string, object>
    shows?: object[][]
    budgetMs?: number
  }) => {
    const repo = mkdtempSync(join(tmpdir(), 'bd-publish-verify-'))
    spawnSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, '.beads'))
    if (opts.dbReady !== false) mkdirSync(join(repo, '.beads', 'embeddeddolt'))
    const shimDir = join(repo, 'shim')
    mkdirSync(shimDir)
    const shimLog = join(repo, 'shim.log')
    writeFileSync(shimLog, '')
    for (const [apiPath, body] of Object.entries(opts.fixtures ?? {})) {
      // 'path#2' writes the fixture served on the SECOND GET of that path
      const [pth, nth] = apiPath.split('#')
      const base = `fixture-${pth.replaceAll('/', '_')}${nth ? `.${nth}` : ''}.json`
      writeFileSync(join(repo, base), JSON.stringify(body))
    }
    const shows = opts.shows ?? [[]]
    shows.forEach((rows, i) => writeFileSync(join(repo, `show-${i + 1}.json`), JSON.stringify(rows)))
    writeFileSync(join(repo, 'show-last.json'), JSON.stringify(shows[shows.length - 1]))
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
    writeFileSync(
      join(shimDir, 'gh'),
      [
        '#!/bin/sh',
        `echo "gh $@" >> "${shimLog}"`,
        'if [ "$1" = "auth" ]; then echo shim-token; exit 0; fi',
        'if [ "$1" = "api" ]; then',
        '  if [ "$2" = "-X" ]; then',
        `    cat > "${repo}/patch-input-$(echo "$4" | tr '/' '_').json"`,
        "    echo '{}'; exit 0",
        '  fi',
        `  name=$(echo "$2" | tr '/' '_')`,
        `  cnt=$(cat "${repo}/getcount-$name" 2>/dev/null || echo 0); cnt=$((cnt+1)); echo $cnt > "${repo}/getcount-$name"`,
        `  if [ -f "${repo}/fixture-$name.$cnt.json" ]; then cat "${repo}/fixture-$name.$cnt.json"; exit 0; fi`,
        `  if [ -f "${repo}/fixture-$name.fail.json" ]; then cat "${repo}/fixture-$name.fail.json"; exit 1; fi`,
        `  f="${repo}/fixture-$name.json"`,
        '  if [ -f "$f" ]; then cat "$f"; exit 0; fi',
        '  echo \'{"message":"Not Found"}\'; exit 1',
        'fi',
        'exit 0',
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'bd'), 0o755)
    chmodSync(join(shimDir, 'gh'), 0o755)
    // GH_TOKEN/GH_HOST: if a shim ever breaks, PATH search must not fall
    // through to the REAL gh with live credentials.
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      GH_TOKEN: '',
      GH_HOST: '127.0.0.1',
    }
    if (opts.budgetMs !== undefined) env.BD_PUBLISH_VERIFY_BUDGET_MS = String(opts.budgetMs)
    const hook = (command: string, stdout: string | null, extra: object = {}) => {
      const payload = JSON.stringify({
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command },
        ...(stdout === null ? {} : { tool_response: { stdout } }),
        ...extra,
      })
      return spawnSync('node', [script], { cwd: repo, env, input: payload, encoding: 'utf8' })
    }
    return { hook, repo, shimCalls: () => readFileSync(shimLog, 'utf8') }
  }

  const context = (r: { stdout: string }) =>
    r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : ''

  it('stays silent for non-publish commands WITHOUT spawning anything', () => {
    const { hook, shimCalls } = makeRepo({})
    const r = hook('gh pr view 652', url('pull/652'))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(shimCalls()).toBe('')
  })

  // Pins the publish-command gate SPECIFICALLY: this output is exactly what
  // the api-mode branch accepts (top-level html_url JSON), so without the
  // gate a plain file dump would trigger a fetch-and-report of a published
  // object. The `gh pr view` case above cannot pin this — its URL output
  // already dies in the api-mode JSON parse one layer later.
  it('ignores non-publish commands even when their output is an html_url object', () => {
    const { hook, shimCalls } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-abc' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook('cat notes.json', JSON.stringify({ html_url: url('pull/652'), body: 'tracks km-abc' }))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(shimCalls()).toBe('')
  })

  it('stays silent when the published body is clean', () => {
    const { hook } = makeRepo({
      fixtures: { 'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'clean' } },
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  // The mapped number joins the refs echo, so the agent reads its real title
  // before pasting it into the body by hand.
  it('reports a published bead id with the mapped number and that number real title', () => {
    const { hook, shimCalls } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-abc' },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook(PR_CREATE, `some output\n${url('pull/652')}`)
    expect(r.status).toBe(0)
    expect(context(r)).toContain('km-abc → #12')
    expect(context(r)).toContain('#12 → "Tracked issue" (issue, open)')
    expect(shimCalls()).not.toContain('gh api -X')
  })

  // Minting is the sync's job, not a read-only hook's: an unmapped id is
  // reported with the command that fixes it.
  it('reports an unmapped bead id without minting an issue for it', () => {
    const { hook, shimCalls } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-zzzz' },
      },
      shows: [[{ id: 'km-zzzz', external_ref: null }]],
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(shimCalls()).not.toContain('bd github sync')
    expect(context(r)).toContain('km-zzzz → no GitHub issue yet')
  })

  // The pre-gate's escape marks the mention as a deliberate literal — the
  // verifier must not report it as a mistake, nor look it up.
  it('honors KM_ALLOW_BEAD_IDS: no lookup, no bead-id note, refs still echoed', () => {
    const { hook, shimCalls } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': {
          html_url: url('pull/652'),
          title: 'T',
          body: 'literal km-abc, relates to #12',
        },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook(`KM_ALLOW_BEAD_IDS=1 ${PR_CREATE}`, url('pull/652'))
    expect(r.status).toBe(0)
    expect(shimCalls()).not.toContain('bd ')
    expect(context(r)).not.toContain('publishes bead ids')
    expect(context(r)).toContain('#12 → "Tracked issue" (issue, open)')
  })

  // #683 D: the merge commit is the one truly unrepairable text — read it
  // back and echo what it references, because its close keywords have
  // ALREADY acted. Detected from gh's own success line, so file-fed and
  // expanded merge bodies are covered without reading any command channel.
  it('reads the merge commit back after a merge and warns about acted close keywords', () => {
    const sha = 'abc123def4567890abc123def4567890abc123de'
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': {
          html_url: url('pull/652'),
          merged: true,
          merge_commit_sha: sha,
          base: { ref: 'master', repo: { default_branch: 'master' } },
        },
        [`repos/Stvad/knowledge-medium/commits/${sha}`]: { commit: { message: 'stack tip (#652)\n\nFixes #700' } },
        'repos/Stvad/knowledge-medium/issues/700': { title: 'Closed by merge', state: 'closed' },
      },
    })
    const r = hook('gh pr merge 652 --squash --delete-branch', '✓ Merged pull request #652 (stack tip)')
    expect(r.status).toBe(0)
    expect(context(r)).toContain(`merge commit ${sha.slice(0, 9)} of #652`)
    expect(context(r)).toContain('#700 → "Closed by merge"')
    expect(context(r)).toContain('ALREADY acted')
    // the PR's own number is noise, not a reference
    expect(context(r)).not.toContain('#652 →')
  })

  // GitHub applies closing keywords only on the default branch. Merged into
  // the branch below it in a stack, nothing was closed — advising a reopen
  // would send the agent after an issue that is still open.
  it('does not claim close keywords acted when the merge landed off the default branch', () => {
    const sha = 'dd11ee22ff3344556677889900aabbccddeeff00'
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': {
          html_url: url('pull/652'),
          merged: true,
          merge_commit_sha: sha,
          base: { ref: 'claude/lower-of-the-stack', repo: { default_branch: 'master' } },
        },
        [`repos/Stvad/knowledge-medium/commits/${sha}`]: { commit: { message: 'upper of the stack (#652)\n\nFixes #700' } },
        'repos/Stvad/knowledge-medium/issues/700': { title: 'Still open', state: 'open' },
      },
    })
    const r = hook('gh pr merge 652 --merge', '✓ Merged pull request #652 (upper of the stack)')
    expect(r.status).toBe(0)
    expect(context(r)).toContain('#700 → "Still open"')
    expect(context(r)).toContain('have NOT acted')
    expect(context(r)).toContain('claude/lower-of-the-stack')
    expect(context(r)).not.toContain('ALREADY acted')
    expect(context(r)).not.toContain('reopen it now')
  })

  // The gate let this through on the promise that this hook would check it.
  // When the output names no object, that promise cannot be kept — say so
  // rather than returning silently and leaving the text checked by nobody.
  it('reports a covered publish whose output named no object', () => {
    const { hook } = makeRepo({ fixtures: {} })
    const r = hook(PR_CREATE, 'Creating pull request for x into master\nsomething went to a template')
    expect(r.status).toBe(0)
    expect(context(r)).toContain('treated as covered by the pre-publish gate')
    expect(context(r)).toContain('nothing has checked the references')
  })

  // Empty output is the case with LEAST to go on, so it is the last place the
  // report may fall silent: the gate skipped this text on the read-back's
  // promise, and printing nothing does not keep it.
  it('reports a covered publish that printed nothing at all', () => {
    const { hook } = makeRepo({ fixtures: {} })
    const r = hook(PR_CREATE, '')
    expect(r.status).toBe(0)
    expect(context(r)).toContain('treated as covered by the pre-publish gate')
  })

  // A --dry-run creates nothing, so a read-back that finds nothing is correct
  // rather than a broken promise. Warning here would train the agent to
  // ignore the warning, which is the only thing making it worth having.
  it('stays silent for a dry-run that published nothing', () => {
    const { hook } = makeRepo({ fixtures: {} })
    const r = hook('gh pr create --title t --body-file /tmp/x.md --dry-run', 'Would have created a Pull Request with:\ntitle\tt')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  // A command the tool reports as failed published nothing, so there is no
  // unkept coverage promise — and telling the agent to go inspect a
  // nonexistent object is the cry-wolf failure this report cannot afford.
  it('stays silent when a covered command FAILED before publishing', () => {
    const { hook } = makeRepo({ fixtures: {} })
    const r = hook(PR_CREATE, 'HTTP 422: Validation Failed', { hook_event_name: 'PostToolUseFailure' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  // gh prints EXISTING objects in its error text ("a pull request for branch
  // X already exists: <url>"), so on a failure event attribution is UNKNOWN —
  // the per-target notes must not read as "you published this, go fix it".
  // Unknown is as far as it goes: an earlier segment of a failed compound
  // really can have published the object named, so claiming it did NOT would
  // be the same over-claim in the other direction.
  it('says attribution is unknown when the command failed', () => {
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'relates to #12' },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
    })
    const r = hook(PR_CREATE, null, {
      hook_event_name: 'PostToolUseFailure',
      error: `a pull request for branch "x" already exists:\n${url('pull/652')}`,
    })
    expect(r.status).toBe(0)
    expect(context(r)).toContain('attribution of the object(s) below is UNKNOWN')
    expect(context(r)).toContain('Confirm which before editing')
  })

  // An unreadable base branch must not be reported as "merged off the default
  // branch" — that advice tells the agent NOT to look for a wrongly closed
  // issue, which is the dangerous direction to be wrong in.
  it('says UNKNOWN when it cannot tell which branch the merge landed on', () => {
    const sha = 'bb22cc33dd4455667788990011aabbccddeeff22'
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': {
          html_url: url('pull/652'),
          merged: true,
          merge_commit_sha: sha,
          base: { ref: 'master', repo: {} },
        },
        [`repos/Stvad/knowledge-medium/commits/${sha}`]: { commit: { message: 'landed (#652)\n\nFixes #700' } },
        'repos/Stvad/knowledge-medium/issues/700': { title: 'Some issue', state: 'closed' },
      },
    })
    const r = hook('gh pr merge 652 --merge', '✓ Merged pull request #652 (landed)')
    expect(r.status).toBe(0)
    expect(context(r)).toContain('UNKNOWN')
    expect(context(r)).not.toContain('have NOT acted')
    expect(context(r)).not.toContain('ALREADY acted')
  })

  // A non-numeric budget yielded NaN, and every `>= deadline` test against NaN
  // is false: nothing stopped on time while every echo blamed the budget.
  it('falls back to the default budget when the override is not a number', () => {
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/issues/643': { html_url: url('issues/643'), title: 'T', body: 'relates to #12' },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      budgetMs: 'not-a-number' as unknown as number,
    })
    const r = hook('gh issue edit 643 --body-file /tmp/x.md', url('issues/643'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('#12 → "Tracked issue" (issue, open)')
    expect(context(r)).not.toContain('out of time budget')
  })

  // A publish carrying no TEXT has no reference the read-back could have
  // verified, so an empty result there is not a broken promise. Without this
  // the warning fires on label changes, reactions, merge-method calls and
  // comment deletions — and it is worth having only while it is trusted.
  it('stays silent for a covered publish that carries no text', () => {
    const { hook } = makeRepo({ fixtures: {} })
    for (const cmd of [
      'gh pr comment 652 --delete-last',
      'gh api repos/Stvad/knowledge-medium/issues/652/labels -f labels[]=bug',
      'gh api -X PUT repos/Stvad/knowledge-medium/pulls/652/merge -f merge_method=squash',
    ]) {
      const r = hook(cmd, 'done, no url printed')
      expect(r.status, cmd).toBe(0)
      expect(r.stdout, cmd).toBe('')
    }
    // a text-bearing publish with the same empty output still reports
    expect(context(hook(PR_CREATE, 'created, no url printed'))).toContain('treated as covered')
  })

  // An uncovered publish was already checked BEFORE it shipped, so the same
  // empty read-back there is expected, not a surprise.
  it('stays silent when an uncovered publish names no object', () => {
    const { hook } = makeRepo({ fixtures: {} })
    const r = hook('gh pr merge 652 --squash', 'merged, no url printed')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  // The substitution line is an instruction an agent can act on without
  // reading the table below it, so the number on it must be confirmed.
  it('reports a bead mapping whose issue 404s as stale, not as unchecked', () => {
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-abc' },
        // no fixture for issues/12: the mapped issue 404s
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('DOES NOT EXIST')
    expect(context(r)).toContain('External: field is stale')
    expect(context(r)).toContain('do not publish this number')
  })

  // A lookup that FAILED says nothing about the bead — advising a repair of
  // its External: field would send the agent after a link that may be fine,
  // and the reference table retries and can contradict this line outright.
  it('reports a bead mapping it could not check as unconfirmed, not as stale', () => {
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-abc' },
        'repos/Stvad/knowledge-medium/issues/12#fail': { message: 'Server Error' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('UNCONFIRMED')
    expect(context(r)).toContain('read it yourself before publishing it')
    expect(context(r)).not.toContain('is stale')
  })

  // Off the default branch nothing has closed yet — but the PR's own commits
  // may never close anything at all, since a squash with custom text discards
  // them. Promising eventual closure for those would be a different wrong
  // answer from the one this branch exists to avoid.
  it('keeps the squash caveat for the PR-s own commits on an off-default merge', () => {
    const sha = 'aa11bb22cc3344556677889900aabbccddeeff11'
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': {
          html_url: url('pull/652'),
          merged: true,
          merge_commit_sha: sha,
          base: { ref: 'release/2.0', repo: { default_branch: 'master' } },
        },
        [`repos/Stvad/knowledge-medium/commits/${sha}`]: { commit: { message: 'squashed (#652)' } },
        'repos/Stvad/knowledge-medium/pulls/652/commits?per_page=100': [{ commit: { message: 'work\n\nFixes #700' } }],
        'repos/Stvad/knowledge-medium/issues/700': { title: 'Still open', state: 'open' },
      },
    })
    const r = hook('gh pr merge 652 --squash', '✓ Merged pull request #652 (squashed)')
    expect(r.status).toBe(0)
    expect(context(r)).toContain('may never')
    expect(context(r)).not.toContain('ALREADY acted')
  })

  it('echoes the post-mode issue-reference table for published refs', () => {
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/issues/643': { html_url: url('issues/643'), title: 'T', body: 'relates to #12' },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
    })
    const r = hook('gh issue edit 643 --body-file /tmp/x.md', url('issues/643'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('#12 → "Tracked issue" (issue, open)')
    expect(context(r)).toContain('already published')
    expect(context(r)).not.toContain('KM_ISSUE_REFS_OK')
  })

  it('verifies a comment target through the comments API', () => {
    const { hook, shimCalls } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/issues/comments/99': {
          html_url: url('pull/652#issuecomment-99'),
          body: 'relates to #77',
        },
        'repos/Stvad/knowledge-medium/issues/77': { title: 'Referenced', state: 'open' },
      },
    })
    const cmd = 'gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=x'
    const out = JSON.stringify({ html_url: url('pull/652#issuecomment-99'), body: 'relates to #77' })
    const r = hook(cmd, out)
    expect(r.status).toBe(0)
    expect(shimCalls()).toContain('gh api repos/Stvad/knowledge-medium/issues/comments/99')
    expect(context(r)).toContain('#77 → "Referenced" (issue, open)')
  })

  // An api-published review's html_url carries the #pullrequestreview
  // fragment — the REVIEW is the object read back, not its parent PR.
  it('verifies a review target through the reviews API, never the parent PR', () => {
    const { hook, shimCalls } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652/reviews/77': {
          html_url: url('pull/652#pullrequestreview-77'),
          body: 'tracks km-abc',
        },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const cmd = 'gh api repos/Stvad/knowledge-medium/pulls/652/reviews -f body=x'
    const out = JSON.stringify({ html_url: url('pull/652#pullrequestreview-77'), body: 'tracks km-abc' })
    const r = hook(cmd, out)
    expect(r.status).toBe(0)
    expect(shimCalls()).toContain('gh api repos/Stvad/knowledge-medium/pulls/652/reviews/77')
    expect(context(r)).toContain('km-abc → #12')
    expect(shimCalls()).not.toContain('gh api repos/Stvad/knowledge-medium/pulls/652 ')
  })

  // Releases are read by TAG and carry their title in `name`.
  it('reads a release name and body through the releases API', () => {
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/releases/tags/v1.2.0': {
          id: 9,
          html_url: url('releases/tag/v1.2.0'),
          name: 'km-abc ships',
          body: 'relates to #12',
        },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook('gh release edit v1.2.0 --notes-file /tmp/x.md', url('releases/tag/v1.2.0'))
    expect(r.status).toBe(0)
    // the name field is scanned too, not just the body
    expect(context(r)).toContain('km-abc → #12')
    expect(context(r)).toContain('#12 → "Tracked issue" (issue, open)')
  })

  // PostToolUseFailure delivers the output inside `error`, with no
  // tool_response at all (measured 2026-08-20) — a compound command that
  // publishes and then fails must still be verified, under that event name.
  it('verifies publishes from PostToolUseFailure payloads and echoes the event name', () => {
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/issues/643': { html_url: url('issues/643'), title: 'T', body: 'relates to #12' },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
    })
    const r = hook('gh issue edit 643 -F /tmp/x.md; false', null, {
      hook_event_name: 'PostToolUseFailure',
      error: `Exit code 1\n${url('issues/643')}`,
    })
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('#12 → "Tracked issue" (issue, open)')
  })

  it('verifies only the first five targets and says how many were dropped', () => {
    const fixtures: Record<string, object> = { 'repos/Stvad/knowledge-medium/issues/12': { title: 'X', state: 'open' } }
    for (let i = 1; i <= 6; i++)
      fixtures[`repos/Stvad/knowledge-medium/issues/comments/${i}`] = {
        html_url: url(`pull/1#issuecomment-${i}`),
        body: 'clean',
      }
    const { hook, shimCalls } = makeRepo({ fixtures })
    const out = Array.from({ length: 6 }, (_, i) => url(`pull/1#issuecomment-${i + 1}`)).join('\n')
    const r = hook('gh pr comment 1 -F /tmp/x.md', out)
    expect(r.status).toBe(0)
    expect(context(r)).toContain('only the first 5 of 6')
    expect(shimCalls().match(/issues\/comments\//g)?.length).toBe(5)
  })

  // Pins the whole deadline plumbing: with a zero budget every fetch is
  // skipped and the hook says so instead of dying mid-flight.
  it('skips all verification work when the time budget is exhausted', () => {
    const { hook, shimCalls } = makeRepo({
      budgetMs: 0,
      fixtures: { 'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'clean' } },
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('out of time budget')
    expect(shimCalls()).not.toContain('gh api')
  })

  // A rebase merge lands each PR commit directly — their messages carry the
  // acted close keywords, not merge_commit_sha alone.
  it('scans the PR commits landed by a rebase merge, not just the head commit', () => {
    const sha = 'def4567890def4567890def4567890def4567890'
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': {
          html_url: url('pull/652'),
          merged: true,
          merge_commit_sha: sha,
          base: { ref: 'master', repo: { default_branch: 'master' } },
        },
        [`repos/Stvad/knowledge-medium/commits/${sha}`]: { commit: { message: 'feat B (#652)' } },
        'repos/Stvad/knowledge-medium/pulls/652/commits?per_page=100': [
          { commit: { message: 'feat A\n\nCloses #701' } },
          { commit: { message: 'feat B (#652)' } },
        ],
        'repos/Stvad/knowledge-medium/issues/701': { title: 'Closed by rebase', state: 'closed' },
      },
    })
    const r = hook('gh pr merge 652 --rebase', '✓ Merged pull request #652 (feat)')
    expect(r.status).toBe(0)
    expect(context(r)).toContain('#701 → "Closed by rebase"')
    // only the head commit is known landed under every strategy — a squash
    // with custom text does not land PR commits, so their keywords get the
    // strategy-conditional line, never the reopen prompt
    expect(context(r)).not.toContain('ALREADY acted')
    expect(context(r)).toContain('acted only if this was a merge or rebase')
  })

  it('reports merged PRs dropped by the read-back cap and the 100-commit page limit', () => {
    const sha = 'aaa1111222233334444555566667777888899990'
    const manyCommits = Array.from({ length: 100 }, (_, i) => ({ commit: { message: `c${i}\n\nrefs #7${i % 10}` } }))
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/650': { html_url: url('pull/650'), merged: true, merge_commit_sha: sha },
        [`repos/Stvad/knowledge-medium/commits/${sha}`]: { commit: { message: 'head (#650)' } },
        'repos/Stvad/knowledge-medium/pulls/650/commits?per_page=100': manyCommits,
      },
    })
    const out = ['✓ Merged pull request #650 (a)', '✓ Merged pull request #651 (b)', '✓ Merged pull request #653 (c)'].join('\n')
    const r = hook('gh pr merge 650 --rebase; gh pr merge 651 --rebase; gh pr merge 653 --rebase', out)
    expect(r.status).toBe(0)
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
    expect(ctx).toContain('1 additional merged PR(s) not read back')
    expect(ctx).toContain('only the first 100 landed commits were scanned')
  })

  it('reports an unmapped bead id it could not mint instead of failing', () => {
    const { hook } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-zzzz' },
      },
      shows: [[], []],
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('km-zzzz')
    expect(context(r)).toContain('no GitHub issue')
  })

  // A failed read-back is the STRONGEST unkeepable coverage claim: the gate
  // skipped this text on the promise of a read-back, an object is known to
  // have been published, and it could not be examined. Silence would be the
  // same hole the no-target branch exists to close.
  it('reports a covered publish whose read-back fetch fails', () => {
    const { hook } = makeRepo({}) // no fixtures: every gh api GET 404s
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('could not read back')
    expect(context(r)).toContain('references in what it published are unchecked')
  })

  it('never spawns bd in a DB-less clone even with bead ids published', () => {
    const { hook, shimCalls } = makeRepo({
      dbReady: false,
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-zzzz' },
      },
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(shimCalls()).not.toContain('bd show')
    expect(shimCalls()).not.toContain('bd github sync')
    expect(context(r)).toContain('km-zzzz')
  })
})
