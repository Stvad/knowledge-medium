import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SIGNATURE, signedBody } from './pr-reply.mjs'

describe('signedBody', () => {
  it('appends the Autofix signature once, after a blank line', () => {
    expect(signedBody('Fixed in abc123.\n')).toBe(`Fixed in abc123.\n\n${SIGNATURE}`)
    expect(signedBody(`Fixed.\n\n${SIGNATURE}\n`)).toBe(`Fixed.\n\n${SIGNATURE}`)
  })
})

describe('pr-reply process behavior', { timeout: 20_000 }, () => {
  const script = fileURLToPath(new URL('./pr-reply.mjs', import.meta.url))

  // One review thread as the GraphQL thread query returns it: id, state, and the
  // fullDatabaseId of its top-level comment, a BigInt GitHub sends as a decimal string.
  const thread = (id: string, rootCommentId: number, isResolved = false) => ({
    id,
    isResolved,
    comments: { nodes: [{ fullDatabaseId: String(rootCommentId) }] },
  })

  const setup = (
    opts: {
      ghFails?: boolean
      ghAnswer?: string
      issues?: Record<number, object>
      lookupSleep?: number
      // pages of the thread query, in order; with none the shim fails every graphql call
      threads?: object[][]
      mutation?: object
    } = {},
  ) => {
    const dir = mkdtempSync(join(tmpdir(), 'pr-reply-'))
    const shimDir = join(dir, 'shim')
    mkdirSync(shimDir)
    const log = join(dir, 'gh.log')
    writeFileSync(log, '')
    writeFileSync(
      join(shimDir, 'gh'),
      [
        '#!/bin/sh',
        `echo "gh $@" >> "${log}"`,
        'case "$2" in',
        '  */replies)',
        `    cat > "${dir}/stdin.json"`,
        opts.ghFails
          ? `    echo 'HTTP 404: Not Found' >&2; exit 1;;`
          : `    echo '${opts.ghAnswer ?? '{"id":42,"html_url":"https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42","body":"x"}'}';;`,
        '  graphql)',
        '    case "$*" in',
        `      *resolveReviewThread*) f="${dir}/mutation.json";;`,
        `      *after=*) f="${dir}/threads-2.json";;`,
        `      *) f="${dir}/threads-1.json";;`,
        '    esac',
        '    if [ -f "$f" ]; then cat "$f"; exit 0; fi',
        `    echo 'HTTP 502: Bad Gateway' >&2; exit 1;;`,
        '  */issues/*)',
        ...(opts.lookupSleep ? [`    sleep ${opts.lookupSleep}`] : []),
        '    n=$(basename "$2")',
        `    if [ -f "${dir}/issue-$n.json" ]; then cat "${dir}/issue-$n.json"; exit 0; fi`,
        `    echo '{"message":"Not Found"}'; exit 1;;`,
        'esac',
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'gh'), 0o755)
    for (const [n, issue] of Object.entries(opts.issues ?? {})) writeFileSync(join(dir, `issue-${n}.json`), JSON.stringify(issue))
    opts.threads?.forEach((nodes, i, pages) => {
      const pageInfo = { hasNextPage: i < pages.length - 1, endCursor: `cursor-${i + 1}` }
      const reviewThreads = { pageInfo, nodes }
      writeFileSync(join(dir, `threads-${i + 1}.json`), JSON.stringify({ data: { repository: { pullRequest: { reviewThreads } } } }))
    })
    const resolved = { data: { resolveReviewThread: { thread: { id: 'resolved-thread', isResolved: true } } } }
    writeFileSync(join(dir, 'mutation.json'), JSON.stringify(opts.mutation ?? resolved))
    // GH_TOKEN/GH_HOST: a broken shim must not fall through to the real gh.
    // INIT_CWD is dropped: a test run under `pnpm run` inherits pnpm's own.
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GH_TOKEN: '', GH_HOST: '127.0.0.1' }
    delete env.INIT_CWD
    const run = (...args: string[]) => spawnSync('node', [script, ...args], { cwd: dir, env, encoding: 'utf8' })
    // how pnpm runs it: from the package root, with the caller's directory in INIT_CWD
    const runViaPnpm = (callerDir: string, ...args: string[]) =>
      spawnSync('node', [script, ...args], {
        cwd: tmpdir(),
        env: { ...env, INIT_CWD: callerDir, npm_lifecycle_event: 'pr:reply' },
        encoding: 'utf8',
      })
    const runWith = (extra: NodeJS.ProcessEnv, ...args: string[]) =>
      spawnSync('node', [script, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' })
    return { dir, run, runViaPnpm, runWith, ghCalls: () => readFileSync(log, 'utf8'), sent: () => JSON.parse(readFileSync(join(dir, 'stdin.json'), 'utf8')) }
  }

  it('posts the file verbatim plus the signature and prints the reply URL', () => {
    const { dir, run, ghCalls, sent } = setup()
    writeFileSync(join(dir, 'body.md'), 'Real — fixed in `abc123`; see #77.\n')
    const r = run('652', '41', 'body.md')
    expect(r.status).toBe(0)
    expect(r.stdout.split('\n')[0]).toBe('https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42')
    expect(ghCalls()).toContain('gh api repos/Stvad/knowledge-medium/pulls/652/comments/41/replies --method POST --input -')
    expect(ghCalls()).not.toContain('graphql')
    expect(sent()).toEqual({ body: `Real — fixed in \`abc123\`; see #77.\n\n${SIGNATURE}` })
  })

  it('reads a relative body path against the directory pnpm was called from', () => {
    const { dir, runViaPnpm, sent } = setup()
    writeFileSync(join(dir, 'body.md'), 'from the caller')
    expect(runViaPnpm(dir, '652', '41', 'body.md').status).toBe(0)
    expect(sent().body.startsWith('from the caller')).toBe(true)
  })

  // Outside a pnpm run of this script, an inherited INIT_CWD is some other
  // run's directory and would post a different file.
  it('ignores an INIT_CWD pnpm did not set for this script', () => {
    const { dir, runWith, sent } = setup()
    const elsewhere = mkdtempSync(join(tmpdir(), 'pr-reply-elsewhere-'))
    writeFileSync(join(elsewhere, 'body.md'), 'the wrong file')
    writeFileSync(join(dir, 'body.md'), 'the right file')
    expect(runWith({ INIT_CWD: elsewhere }, '652', '41', 'body.md').status).toBe(0)
    expect(sent().body.startsWith('the right file')).toBe(true)
  })

  // The hooks may not have recognized the invocation, so the script refuses
  // bead ids itself, with the gate's own escape.
  it('refuses a body with a bead id before posting, unless the escape is set', () => {
    const { dir, run, runWith, ghCalls } = setup()
    writeFileSync(join(dir, 'body.md'), 'tracked in km-abcd')
    const r = run('652', '41', 'body.md')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('km-abcd')
    expect(ghCalls()).toBe('')
    expect(runWith({ KM_ALLOW_BEAD_IDS: '1' }, '652', '41', 'body.md').status).toBe(0)
  })

  // Once gh reports success the reply exists; a failed exit would tell the
  // read-back that nothing was published.
  it('exits 0 and prints gh’s answer when a successful post names no URL', () => {
    const { dir, run } = setup({ ghAnswer: '{"id":42}' })
    writeFileSync(join(dir, 'body.md'), 'text')
    const r = run('652', '41', 'body.md')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('{"id":42}')
  })

  // The publisher checks its own text, so a spelling of the invocation the
  // hooks do not recognize is checked all the same: every #N the reply
  // published comes back with its real title.
  it('echoes the real title of every number the posted reply carries', () => {
    const answer = JSON.stringify({ id: 42, html_url: 'https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42', body: 'see #77 and #78' })
    const { dir, run } = setup({ ghAnswer: answer, issues: { 77: { title: 'Referenced', state: 'open' } } })
    writeFileSync(join(dir, 'body.md'), 'see #77 and #78')
    const r = run('652', '41', 'body.md')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('#77 → "Referenced" (issue, open)')
    expect(r.stdout).toContain('#78 → NO SUCH ISSUE OR PR')
  })

  const many = Array.from({ length: 20 }, (_, i) => `#${100 + i}`).join(' ')
  const manyAnswer = JSON.stringify({ id: 42, html_url: 'https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42', body: many })

  // The reply is already posted, so the echo must not run long enough to
  // look like a failed post: it looks up only as many references as its
  // budget fits full lookups of, and counts the rest.
  it('bounds the reference echo by a cap and a time budget', () => {
    const capped = setup({ ghAnswer: manyAnswer })
    writeFileSync(join(capped.dir, 'body.md'), many)
    const r = capped.run('652', '41', 'body.md')
    expect(r.status).toBe(0)
    // the default budget fits five lookups of the full lookup timeout
    expect(capped.ghCalls().match(/\/issues\//g)).toHaveLength(5)
    expect(r.stdout).toContain('…and 15 more references not echoed')
    const broke = setup({ ghAnswer: manyAnswer })
    writeFileSync(join(broke.dir, 'body.md'), many)
    const none = broke.runWith({ KM_PR_REPLY_ECHO_BUDGET_MS: '0' }, '652', '41', 'body.md')
    expect(none.status).toBe(0)
    expect(broke.ghCalls()).not.toContain('/issues/')
    expect(none.stdout).toContain('20 issue references in the reply not echoed (out of time budget)')
  })

  // On a loaded runner the clock moves between any two reads of it. The cap
  // is the budget divided into lookups, so it must not move with the clock.
  it('sizes the echo from the budget alone, however the clock moves meanwhile', () => {
    const { dir, runWith, ghCalls } = setup({ ghAnswer: manyAnswer })
    writeFileSync(join(dir, 'body.md'), many)
    const clock = join(dir, 'ticking-clock.mjs')
    writeFileSync(clock, 'let t = Date.now()\nDate.now = () => ++t\n')
    const r = runWith({ NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(clock).href}` }, '652', '41', 'body.md')
    expect(r.status).toBe(0)
    expect(ghCalls().match(/\/issues\//g)).toHaveLength(5)
  })

  // The URL is what the read-back needs; a kill during the lookups that
  // follow must not take it with them.
  it('has written the reply URL before the lookups start', () => {
    const answer = JSON.stringify({ id: 42, html_url: 'https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42', body: 'see #77' })
    const { dir } = setup({ ghAnswer: answer, lookupSleep: 10 })
    writeFileSync(join(dir, 'body.md'), 'see #77')
    const r = spawnSync('node', [script, '652', '41', 'body.md'], {
      cwd: dir,
      env: { ...process.env, PATH: `${join(dir, 'shim')}:${process.env.PATH}`, GH_TOKEN: '', GH_HOST: '127.0.0.1', INIT_CWD: '' },
      encoding: 'utf8',
      timeout: 2_500,
    })
    expect(r.signal).toBe('SIGTERM')
    expect(r.stdout).toContain('https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42')
  })

  // What GitHub stored is the ground truth, not the file as it was read.
  it('echoes the numbers from the body GitHub answered with', () => {
    const answer = JSON.stringify({ id: 42, html_url: 'https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42', body: 'stored #78' })
    const { dir, run } = setup({ ghAnswer: answer })
    writeFileSync(join(dir, 'body.md'), 'sent #77')
    const r = run('652', '41', 'body.md')
    expect(r.stdout).toContain('#78 →')
    expect(r.stdout).not.toContain('#77 →')
  })

  // Each refusal is a shape the read-back cannot cover or a post that would
  // fail anyway; none of them may reach gh.
  it('refuses what it cannot post as one covered reply, without calling gh', () => {
    const { dir, run, ghCalls } = setup()
    writeFileSync(join(dir, 'body.md'), 'text')
    writeFileSync(join(dir, 'empty.md'), '  \n')
    mkdirSync(join(dir, 'a-dir'))
    // a file that exists: only the flag check keeps it from being posted
    writeFileSync(join(dir, '--force'), 'text')
    for (const args of [
      ['652', '41'],
      ['652', '41', 'body.md', 'extra'],
      ['#652', '41', 'body.md'],
      ['652', 'r41', 'body.md'],
      ['652', '41', '-'],
      ['652', '41', 'a-dir'],
      ['652', '41', 'missing.md'],
      ['652', '41', 'empty.md'],
      ['652', '41', '--force'],
      ['652', '--force', '41', 'body.md'],
      ['652', '41', 'body.md', '--resolv'],
      ['652', '41', '--resolve'],
      ['652', '41', 'body.md', '--resolve', 'extra'],
    ]) {
      const r = run(...args)
      expect(r.status, args.join(' ')).toBe(1)
      expect(r.stdout, args.join(' ')).toBe('')
    }
    expect(ghCalls()).toBe('')
    // a directory is refused by what it is, not by a read crashing on it
    expect(run('652', '41', 'a-dir').stderr).toContain('a-dir: is not a regular file')
    expect(run('652', '41', '--force').stderr).toContain('usage: pnpm pr:reply <pr> <comment-id> <body-file> [--resolve]')
  })

  describe('--resolve', () => {
    const replyUrl = 'https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42'
    const answer = (extra: object = {}) => JSON.stringify({ id: 42, html_url: replyUrl, body: 'x', ...extra })
    const mutationCalls = (calls: string) => calls.split('\n').filter(line => line.includes('resolveReviewThread'))
    const queryCalls = (calls: string) => calls.split('\n').filter(line => line.includes('gh api graphql') && line.includes('reviewThreads'))

    it('resolves the thread whose first comment matches, after the URL and before the reference echo', () => {
      const { dir, run, ghCalls } = setup({
        ghAnswer: answer({ body: 'see #77' }),
        issues: { 77: { title: 'Referenced', state: 'open' } },
        threads: [[thread('T_other', 5), thread('T_target', 41)]],
      })
      writeFileSync(join(dir, 'body.md'), 'see #77')
      const r = run('652', '--resolve', '41', 'body.md')
      expect(r.status).toBe(0)
      expect(r.stdout.split('\n')[0]).toBe(replyUrl)
      expect(r.stdout).toContain('resolved review thread T_target')
      expect(r.stdout.indexOf('resolved review thread')).toBeLessThan(r.stdout.indexOf('#77 →'))
      expect(r.stderr).toBe('')
      expect(queryCalls(ghCalls())).toHaveLength(1)
      expect(queryCalls(ghCalls())[0]).toContain('-f owner=Stvad -f name=knowledge-medium -F pr=652')
      const mutations = mutationCalls(ghCalls())
      expect(mutations).toHaveLength(1)
      expect(mutations[0]).toMatch(/ -f id=T_target$/)
    })

    // review comment ids are past 2^31 now
    it('finds the thread of a comment whose id needs more than 32 bits', () => {
      const { dir, run, ghCalls } = setup({ threads: [[thread('T_big', 4352048164)]] })
      writeFileSync(join(dir, 'body.md'), 'text')
      const r = run('652', '4352048164', 'body.md', '--resolve')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('resolved review thread T_big')
      expect(mutationCalls(ghCalls())[0]).toMatch(/ -f id=T_big$/)
    })

    it('pages through the threads until it finds the one it wants', () => {
      const { dir, run, ghCalls } = setup({ threads: [[thread('T_first_page', 5)], [thread('T_second_page', 41)]] })
      writeFileSync(join(dir, 'body.md'), 'text')
      const r = run('652', '41', 'body.md', '--resolve')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('resolved review thread T_second_page')
      const queries = queryCalls(ghCalls())
      expect(queries).toHaveLength(2)
      expect(queries[0]).not.toContain('after=')
      expect(queries[1]).toContain('-f after=cursor-1')
      expect(mutationCalls(ghCalls())[0]).toMatch(/ -f id=T_second_page$/)
    })

    // A reply to a non-root comment lands in the root's thread; the thread is found by its root.
    it('takes the thread root from the reply GitHub answered with, not from the argument', () => {
      const { dir, run, ghCalls } = setup({
        ghAnswer: answer({ in_reply_to_id: 7 }),
        threads: [[thread('T_by_argument', 41), thread('T_by_root', 7)]],
      })
      writeFileSync(join(dir, 'body.md'), 'text')
      expect(run('652', '41', 'body.md', '--resolve').status).toBe(0)
      expect(mutationCalls(ghCalls())).toHaveLength(1)
      expect(mutationCalls(ghCalls())[0]).toMatch(/ -f id=T_by_root$/)
    })

    it('says so and sends no mutation when the thread is already resolved', () => {
      const { dir, run, ghCalls } = setup({ threads: [[thread('T_done', 41, true)]] })
      writeFileSync(join(dir, 'body.md'), 'text')
      const r = run('652', '41', 'body.md', '--resolve')
      expect(r.status).toBe(0)
      expect(r.stdout).toContain('review thread T_done was already resolved')
      expect(mutationCalls(ghCalls())).toHaveLength(0)
    })

    // The reply exists once gh answered; a failed exit would tell the read-back it does not.
    it('reports a failure on one stderr line, exits 0, and still echoes the references', () => {
      const { dir, run, ghCalls } = setup({
        ghAnswer: answer({ body: 'see #77' }),
        issues: { 77: { title: 'Referenced', state: 'open' } },
        threads: [[thread('T_elsewhere', 5)]],
      })
      writeFileSync(join(dir, 'body.md'), 'see #77')
      const r = run('652', '41', 'body.md', '--resolve')
      expect(r.status).toBe(0)
      expect(r.stdout.split('\n')[0]).toBe(replyUrl)
      expect(r.stdout).toContain('#77 → "Referenced" (issue, open)')
      expect(r.stderr.trim().split('\n')).toHaveLength(1)
      expect(r.stderr).toContain('--resolve: could not resolve the review thread')
      expect(mutationCalls(ghCalls())).toHaveLength(0)
    })

    // a GitHub that pages forever, or hangs, cannot hold the echo behind it
    it('gives up on the resolve when its time budget is spent, and still exits 0', () => {
      const { dir, runWith, ghCalls } = setup({ threads: [[thread('T_target', 41)]] })
      writeFileSync(join(dir, 'body.md'), 'text')
      const r = runWith({ KM_PR_REPLY_RESOLVE_BUDGET_MS: '0' }, '652', '41', 'body.md', '--resolve')
      expect(r.status).toBe(0)
      expect(r.stdout.trim()).toBe(replyUrl)
      expect(r.stderr).toContain('--resolve: could not resolve the review thread: out of time')
      expect(queryCalls(ghCalls())).toHaveLength(0)
    })

    it('reports a gh failure and a mutation that left the thread unresolved the same way', () => {
      const broken = setup()
      writeFileSync(join(broken.dir, 'body.md'), 'text')
      const failed = broken.run('652', '41', 'body.md', '--resolve')
      expect(failed.status).toBe(0)
      expect(failed.stdout.trim()).toBe(replyUrl)
      expect(failed.stderr).toContain('--resolve: could not resolve the review thread: HTTP 502: Bad Gateway')
      const stuck = setup({
        threads: [[thread('T_target', 41)]],
        mutation: { data: { resolveReviewThread: { thread: { id: 'T_target', isResolved: false } } } },
      })
      writeFileSync(join(stuck.dir, 'body.md'), 'text')
      const left = stuck.run('652', '41', 'body.md', '--resolve')
      expect(left.status).toBe(0)
      expect(left.stdout).not.toContain('resolved review thread')
      expect(left.stderr).toContain('--resolve: could not resolve the review thread')
    })
  })

  it('exits non-zero with gh’s own error and prints no URL when the post fails', () => {
    const { dir, run } = setup({ ghFails: true })
    writeFileSync(join(dir, 'body.md'), 'text')
    const r = run('652', '41', 'body.md')
    expect(r.status).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('HTTP 404: Not Found')
  })
})
