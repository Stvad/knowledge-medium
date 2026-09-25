import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

  const setup = (opts: { ghFails?: boolean; ghAnswer?: string; issues?: Record<number, object> } = {}) => {
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
        '  */issues/*)',
        '    n=$(basename "$2")',
        `    if [ -f "${dir}/issue-$n.json" ]; then cat "${dir}/issue-$n.json"; exit 0; fi`,
        `    echo '{"message":"Not Found"}'; exit 1;;`,
        'esac',
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'gh'), 0o755)
    for (const [n, issue] of Object.entries(opts.issues ?? {})) writeFileSync(join(dir, `issue-${n}.json`), JSON.stringify(issue))
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
    for (const args of [
      ['652', '41'],
      ['652', '41', 'body.md', 'extra'],
      ['#652', '41', 'body.md'],
      ['652', 'r41', 'body.md'],
      ['652', '41', '-'],
      ['652', '41', 'a-dir'],
      ['652', '41', 'missing.md'],
      ['652', '41', 'empty.md'],
    ]) {
      const r = run(...args)
      expect(r.status, args.join(' ')).toBe(1)
      expect(r.stdout, args.join(' ')).toBe('')
    }
    expect(ghCalls()).toBe('')
    // a directory is refused by what it is, not by a read crashing on it
    expect(run('652', '41', 'a-dir').stderr).toContain('a-dir: is not a regular file')
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
