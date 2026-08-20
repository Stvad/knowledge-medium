import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { matchesApiPublish } from './bd-github-sync.mjs'
import { apiPathFor, clipContext, planBeadIdRewrite, publishedTargets } from './bd-publish-verify.mjs'

const PR_CREATE = 'gh pr create --title t --body-file /tmp/x.md'
const url = (path: string) => `https://github.com/Stvad/knowledge-medium/${path}`

describe('matchesApiPublish', () => {
  it('matches gh api mutations: explicit method, attached method, field flags', () => {
    expect(matchesApiPublish('gh api -X PATCH repos/Stvad/knowledge-medium/pulls/652 --input -')).toBe(true)
    expect(matchesApiPublish('gh api -XPATCH repos/Stvad/knowledge-medium/pulls/652 --input -')).toBe(true)
    expect(matchesApiPublish('gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=hi')).toBe(true)
    expect(matchesApiPublish('cat x | gh api graphql -f query=@-')).toBe(true)
  })

  it('ignores GETs, quoted prose, and non-api gh commands', () => {
    expect(matchesApiPublish('gh api repos/Stvad/knowledge-medium/issues/652')).toBe(false)
    expect(matchesApiPublish('git commit -m "reply via gh api -X POST later"')).toBe(false)
    expect(matchesApiPublish('gh pr view 652')).toBe(false)
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
    ].join('\n')
    expect(publishedTargets(PR_CREATE, out)).toEqual([
      { kind: 'pr', number: 652 },
      { kind: 'issue', number: 643 },
      { kind: 'release', tag: 'v1.2.0' },
      { kind: 'comment', id: 99 },
      { kind: 'review-comment', id: 41 },
    ])
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

  it('yields no targets for unparseable gh api output', () => {
    const cmd = 'gh api repos/Stvad/knowledge-medium/issues/652/comments -f body=hi'
    expect(publishedTargets(cmd, `posted!\n${url('pull/500')}`)).toEqual([])
  })
})

describe('apiPathFor', () => {
  it('maps each target kind to its REST resource', () => {
    expect(apiPathFor({ kind: 'pr', number: 5 })).toBe('repos/Stvad/knowledge-medium/pulls/5')
    expect(apiPathFor({ kind: 'issue', number: 5 })).toBe('repos/Stvad/knowledge-medium/issues/5')
    expect(apiPathFor({ kind: 'comment', id: 7 })).toBe('repos/Stvad/knowledge-medium/issues/comments/7')
    expect(apiPathFor({ kind: 'review-comment', id: 7 })).toBe('repos/Stvad/knowledge-medium/pulls/comments/7')
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
    const env: Record<string, string | undefined> = { ...process.env, PATH: `${shimDir}:${process.env.PATH}` }
    delete env.BD_GITHUB_SYNC_DRY
    if (opts.dry) env.BD_GITHUB_SYNC_DRY = '1'
    const hook = (command: string, stdout: string) => {
      const payload = JSON.stringify({
        tool_name: 'Bash',
        cwd: repo,
        tool_input: { command },
        tool_response: { stdout },
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

  it('stays silent when the published body is clean', () => {
    const { hook } = makeRepo({
      fixtures: { 'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'clean' } },
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })

  it('rewrites a mapped bead id in the published body and reports the repair', () => {
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
    expect(patched.body).toBe('tracks #12')
    expect(patched.title).toBe('T')
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

  it('suppresses writes under BD_GITHUB_SYNC_DRY=1 but still reports what it would do', () => {
    const { hook, repo, shimCalls } = makeRepo({
      dry: true,
      fixtures: {
        'repos/Stvad/knowledge-medium/pulls/652': { html_url: url('pull/652'), title: 'T', body: 'tracks km-abc' },
      },
      shows: [[{ id: 'km-abc', external_ref: url('issues/12') }]],
    })
    const r = hook(PR_CREATE, url('pull/652'))
    expect(r.status).toBe(0)
    expect(context(r)).toContain('would rewrite km-abc → #12')
    expect(existsSync(join(repo, patchName('repos/Stvad/knowledge-medium/pulls/652')))).toBe(false)
    expect(shimCalls()).not.toContain('bd github sync')
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
