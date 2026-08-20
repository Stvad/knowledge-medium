import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { hasExplicitGetMethod, matchesApiPublish, repairableKinds } from './bd-github-sync.mjs'
import { apiPathFor, clipContext, planBeadIdRewrite, publishedTargets } from './bd-publish-verify.mjs'

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

  // Explicit-GET commands still MATCH (a compound can mix a GET segment
  // with a mutating one, so the look must happen) — the GET is a
  // command-wide REPAIR veto instead, via hasExplicitGetMethod.
  it('keeps looking at explicit-GET field commands; only plain no-field reads stay out', () => {
    expect(matchesApiPublish('gh api repos/Stvad/knowledge-medium/issues/652')).toBe(false)
    expect(matchesApiPublish('gh api --method GET repos/Stvad/knowledge-medium/issues -f state=open')).toBe(true)
  })

  it('ignores quoted prose and non-api gh commands', () => {
    expect(matchesApiPublish('git commit -m "reply via gh api -X POST later"')).toBe(false)
    expect(matchesApiPublish('gh pr view 652')).toBe(false)
  })
})

describe('hasExplicitGetMethod', () => {
  it('detects explicit GET/HEAD in plain, attached, and quoted forms', () => {
    expect(hasExplicitGetMethod('gh api --method GET repos/x -f q=1')).toBe(true)
    expect(hasExplicitGetMethod('gh api -XGET repos/x -f q=1')).toBe(true)
    expect(hasExplicitGetMethod('gh api -X "GET" repos/x -f q=1')).toBe(true)
    expect(hasExplicitGetMethod('gh api repos/x -f body=hi')).toBe(false)
    expect(hasExplicitGetMethod('gh api -X PATCH repos/x --input -')).toBe(false)
  })
})

describe('repairableKinds', () => {
  it('maps publish verbs to the kinds their output can name', () => {
    expect([...repairableKinds('gh pr create --title t')]).toEqual(['pr'])
    expect([...repairableKinds('gh issue close 9 -c done')].sort()).toEqual(['comment', 'issue'])
    expect([...repairableKinds('gh pr comment 1 -b x')]).toEqual(['comment'])
    expect([...repairableKinds('gh release create v1 --notes n')]).toEqual(['release'])
    expect([...repairableKinds(ALL_KINDS_CMD)].sort()).toEqual([
      'comment',
      'issue',
      'pr',
      'release',
      'review',
      'review-comment',
    ])
  })

  it('does not read verbs out of quoted prose', () => {
    expect([...repairableKinds('gh pr comment 1 -b "later run gh issue edit 2"')]).toEqual(['comment'])
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
  // target, else the verifier would fetch — and potentially rewrite — an
  // object this command never touched.
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
  // line would be output→command association. ALL object lines become
  // candidates, which the single-object repair gate then disqualifies.
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

describe('planBeadIdRewrite', () => {
  const map = new Map([
    ['km-abc', 12],
    ['km-abc-def', 34],
  ])

  it('substitutes mapped ids, reports each rewrite once, lists unmapped ids', () => {
    const { newText, rewrites, unmapped } = planBeadIdRewrite('km-abc then km-abc; also km-zzzz', map)
    expect(newText).toBe('#12 then #12; also km-zzzz')
    expect(rewrites).toEqual([{ id: 'km-abc', number: 12 }])
    expect(unmapped).toEqual(['km-zzzz'])
  })

  it('matches whole bead ids — a hyphenated suffix is part of the id, not a boundary', () => {
    expect(planBeadIdRewrite('see km-abc-def now', map).newText).toBe('see #34 now')
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
// is something to say), the read-back-then-repair loop, and the mint path.
// Measured ~200ms per spawn solo; budgeted for the 6x load stretch.
describe('bd-publish-verify process behavior', { timeout: 30_000 }, () => {
  const script = fileURLToPath(new URL('./bd-publish-verify.mjs', import.meta.url))
  const fixtureName = (apiPath: string) => `fixture-${apiPath.replaceAll('/', '_')}.json`
  const patchName = (apiPath: string) => `patch-input-${apiPath.replaceAll('/', '_')}.json`

  const makeRepo = (opts: {
    dbReady?: boolean
    fixtures?: Record<string, object>
    shows?: object[][]
    dry?: boolean
  }) => {
    const repo = mkdtempSync(join(tmpdir(), 'bd-publish-verify-'))
    spawnSync('git', ['init', '-q'], { cwd: repo })
    mkdirSync(join(repo, '.beads'))
    if (opts.dbReady !== false) mkdirSync(join(repo, '.beads', 'embeddeddolt'))
    const shimDir = join(repo, 'shim')
    mkdirSync(shimDir)
    const shimLog = join(repo, 'shim.log')
    writeFileSync(shimLog, '')
    for (const [apiPath, body] of Object.entries(opts.fixtures ?? {}))
      writeFileSync(join(repo, fixtureName(apiPath)), JSON.stringify(body))
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
        `  f="${repo}/fixture-$(echo "$2" | tr '/' '_').json"`,
        '  if [ -f "$f" ]; then cat "$f"; exit 0; fi',
        '  echo \'{"message":"Not Found"}\'; exit 1',
        'fi',
        'exit 0',
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'bd'), 0o755)
    chmodSync(join(shimDir, 'gh'), 0o755)
    // GH_TOKEN/GH_HOST: if a shim ever breaks, PATH search must not fall
    // through to the REAL gh with live credentials — this suite deliberately
    // runs with the dry valve off.
    const env: Record<string, string | undefined> = {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      GH_TOKEN: '',
      GH_HOST: '127.0.0.1',
    }
    delete env.BD_GITHUB_SYNC_DRY
    if (opts.dry) env.BD_GITHUB_SYNC_DRY = '1'
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
  // gate a plain file dump would trigger fetch-and-rewrite of a published
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

  it('rewrites a mapped bead id in the published body, PATCHing only the changed field', () => {
    const { hook, repo, shimCalls } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-abc' },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook(PR_CREATE, `some output\n${url('pull/652')}`)
    expect(r.status).toBe(0)
    expect(context(r)).toContain('rewrote km-abc → #12')
    const patched = JSON.parse(readFileSync(join(repo, patchName('repos/Stvad/knowledge-medium/pulls/652')), 'utf8'))
    // the unchanged title must NOT ride along: a concurrent edit between the
    // fetch and the PATCH would be overwritten by a stale copy
    expect(patched).toEqual({ body: 'tracks #12' })
    // the substituted number is then echoed with its ground truth
    expect(context(r)).toContain('#12 → "Tracked issue" (issue, open)')
    expect(shimCalls()).not.toContain('bd github sync')
  })

  it('mints the issue first when the published bead has none, then rewrites', () => {
    const { hook, repo, shimCalls } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-zzzz' },
        'repos/Stvad/knowledge-medium/issues/88': { title: 'Minted issue', state: 'open' },
      },
      shows: [[{ id: 'km-zzzz', external_ref: null }], [{ id: 'km-zzzz', external_ref: url('issues/88') }]],
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(shimCalls()).toContain('bd github sync --push-only --issues km-zzzz')
    expect(context(r)).toContain('rewrote km-zzzz → #88')
    expect(JSON.parse(readFileSync(join(repo, patchName('repos/Stvad/knowledge-medium/pulls/652')), 'utf8')).body).toBe(
      'tracks #88',
    )
  })

  // The pre-gate's escape marks the mention as a deliberate literal — the
  // verifier must not "repair" it back into a reference.
  it('honors KM_ALLOW_BEAD_IDS: no lookup, no rewrite, refs still echoed', () => {
    const { hook, repo, shimCalls } = makeRepo({
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
    expect(existsSync(join(repo, patchName('repos/Stvad/knowledge-medium/pulls/652')))).toBe(false)
    expect(context(r)).not.toContain('rewrote')
    expect(context(r)).toContain('#12 → "Tracked issue" (issue, open)')
  })

  // A stale external_ref (deleted or transferred issue) must not be written
  // into public text.
  it('leaves a bead id alone when its mapped issue does not resolve', () => {
    const { hook, repo } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-abc' },
        // no fixture for issues/12: the mapped issue 404s
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('does not resolve')
    expect(existsSync(join(repo, patchName('repos/Stvad/knowledge-medium/pulls/652')))).toBe(false)
  })

  // The uniqueness gate: two same-kind URLs in the output mean this hook
  // cannot tell which one the command published — repair neither.
  it('does not rewrite when the output names more than one object of the kind', () => {
    const { hook, repo } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/issues/comments/91': {
          html_url: url('pull/1#issuecomment-91'),
          body: 'tracks km-abc',
        },
        'repos/Stvad/knowledge-medium/issues/comments/92': { html_url: url('pull/1#issuecomment-92'), body: 'clean' },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook('gh pr comment 1 -F /tmp/x.md', `${url('pull/1#issuecomment-91')}\n${url('pull/1#issuecomment-92')}`)
    expect(r.status).toBe(0)
    expect(context(r)).toContain('NOT auto-rewriting')
    expect(existsSync(join(repo, patchName('repos/Stvad/knowledge-medium/issues/comments/91')))).toBe(false)
  })

  // The two round-4 repros: association is unrecoverable, so ONLY the
  // single-object case may write.
  it('never rewrites when a sibling command printed its own html_url object (api mode)', () => {
    const { hook, repo } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/issues/12': {
          html_url: url('issues/12'),
          title: 'Innocent', state: 'open',
          body: 'tracks km-abc',
        },
        'repos/Stvad/knowledge-medium/issues/comments/99': {
          html_url: url('pull/652#issuecomment-99'),
          body: 'the real publish',
        },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const cmd = 'printf x; gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=hi'
    const out = [
      JSON.stringify({ html_url: url('issues/12'), body: 'tracks km-abc' }),
      JSON.stringify({ html_url: url('pull/652#issuecomment-99'), body: 'the real publish' }),
    ].join('\n')
    const r = hook(cmd, out)
    expect(r.status).toBe(0)
    expect(context(r)).toContain('NOT auto-rewriting')
    expect(existsSync(join(repo, patchName('repos/Stvad/knowledge-medium/issues/12')))).toBe(false)
  })

  it('echoes but never rewrites when the command carries an explicit GET segment', () => {
    const { hook, repo } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/issues/comments/99': {
          html_url: url('pull/652#issuecomment-99'),
          body: 'tracks km-abc, relates to #77',
        },
        'repos/Stvad/knowledge-medium/issues/77': { title: 'Referenced', state: 'open' },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const cmd =
      'gh api --method GET repos/Stvad/knowledge-medium/issues -f state=open; gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=x'
    const out = JSON.stringify({ html_url: url('pull/652#issuecomment-99') })
    const r = hook(cmd, out)
    expect(r.status).toBe(0)
    expect(context(r)).toContain('explicit GET')
    expect(context(r)).toContain('#77 → "Referenced" (issue, open)')
    expect(existsSync(join(repo, patchName('repos/Stvad/knowledge-medium/issues/comments/99')))).toBe(false)
  })

  it('echoes the post-mode issue-reference table for published refs, with no PATCH', () => {
    const { hook, repo } = makeRepo({
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
    expect(existsSync(join(repo, patchName('repos/Stvad/knowledge-medium/issues/643')))).toBe(false)
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
  // fragment — the REVIEW is the object, not its parent PR, and its body
  // updates via PUT on the reviews resource.
  it('verifies and repairs a review target via PUT, never touching the parent PR', () => {
    const { hook, repo, shimCalls } = makeRepo({
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
    expect(shimCalls()).toContain('-X PUT repos/Stvad/knowledge-medium/pulls/652/reviews/77')
    expect(JSON.parse(readFileSync(join(repo, patchName('repos/Stvad/knowledge-medium/pulls/652/reviews/77')), 'utf8'))).toEqual({
      body: 'tracks #12',
    })
    expect(shimCalls()).not.toContain('gh api repos/Stvad/knowledge-medium/pulls/652 ')
  })

  // Releases carry their title in `name`, and PATCH by numeric id.
  it('reads and repairs a release name and body through the releases API', () => {
    const { hook, repo } = makeRepo({
      fixtures: {
        'repos/Stvad/knowledge-medium/releases/tags/v1.2.0': {
          id: 9,
          html_url: url('releases/tag/v1.2.0'),
          name: 'km-abc ships',
          body: 'tracks km-abc',
        },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook('gh release edit v1.2.0 --notes-file /tmp/x.md', url('releases/tag/v1.2.0'))
    expect(r.status).toBe(0)
    const patched = JSON.parse(readFileSync(join(repo, patchName('repos/Stvad/knowledge-medium/releases/9')), 'utf8'))
    expect(patched).toEqual({ body: 'tracks #12', name: '#12 ships' })
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

  it('suppresses writes under BD_GITHUB_SYNC_DRY=1 but still reports what it would do', () => {
    const { hook, repo, shimCalls } = makeRepo({
      dry: true,
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-abc' },
        'repos/Stvad/knowledge-medium/issues/12': { title: 'Tracked issue', state: 'open' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('would rewrite km-abc → #12')
    expect(existsSync(join(repo, patchName('repos/Stvad/knowledge-medium/pulls/652')))).toBe(false)
    expect(shimCalls()).not.toContain('bd github sync')
  })

  // Pins the dry gate on the MINT specifically: the bead is unmapped, so
  // without the gate the mint branch would run (`bd github sync` in the
  // shim log). The mapped-bead dry test above cannot pin this — its
  // `missing` list is empty and the branch never executes there.
  it('suppresses the mint itself under BD_GITHUB_SYNC_DRY=1', () => {
    const { hook, shimCalls } = makeRepo({
      dry: true,
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-zzzz' },
      },
      shows: [[{ id: 'km-zzzz', external_ref: null }]],
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(shimCalls()).not.toContain('bd github sync')
    expect(context(r)).toContain('mint suppressed')
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

  it('exits 0 silently when the ground-truth fetch fails', () => {
    const { hook } = makeRepo({}) // no fixtures: every gh api GET 404s
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
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
