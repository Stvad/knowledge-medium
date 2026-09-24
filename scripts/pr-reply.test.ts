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

  const setup = (opts: { ghFails?: boolean } = {}) => {
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
        `cat > "${dir}/stdin.json"`,
        opts.ghFails
          ? `echo 'HTTP 404: Not Found' >&2; exit 1`
          : `echo '{"id":42,"html_url":"https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42","body":"x"}'`,
      ].join('\n') + '\n',
    )
    chmodSync(join(shimDir, 'gh'), 0o755)
    // GH_TOKEN/GH_HOST: a broken shim must not fall through to the real gh.
    // INIT_CWD is dropped: a test run under `pnpm run` inherits pnpm's own.
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, GH_TOKEN: '', GH_HOST: '127.0.0.1' }
    delete env.INIT_CWD
    const run = (...args: string[]) => spawnSync('node', [script, ...args], { cwd: dir, env, encoding: 'utf8' })
    // how pnpm runs it: from the package root, with the caller's directory in INIT_CWD
    const runViaPnpm = (callerDir: string, ...args: string[]) =>
      spawnSync('node', [script, ...args], { cwd: tmpdir(), env: { ...env, INIT_CWD: callerDir }, encoding: 'utf8' })
    return { dir, run, runViaPnpm, ghCalls: () => readFileSync(log, 'utf8'), sent: () => JSON.parse(readFileSync(join(dir, 'stdin.json'), 'utf8')) }
  }

  it('posts the file verbatim plus the signature and prints the reply URL', () => {
    const { dir, run, ghCalls, sent } = setup()
    writeFileSync(join(dir, 'body.md'), 'Real — fixed in `abc123`; see #77.\n')
    const r = run('652', '41', 'body.md')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('https://github.com/Stvad/knowledge-medium/pull/652#discussion_r42')
    expect(ghCalls()).toContain('gh api repos/Stvad/knowledge-medium/pulls/652/comments/41/replies --method POST --input -')
    expect(sent()).toEqual({ body: `Real — fixed in \`abc123\`; see #77.\n\n${SIGNATURE}` })
  })

  it('reads a relative body path against the directory pnpm was called from', () => {
    const { dir, runViaPnpm, sent } = setup()
    writeFileSync(join(dir, 'body.md'), 'from the caller')
    expect(runViaPnpm(dir, '652', '41', 'body.md').status).toBe(0)
    expect(sent().body.startsWith('from the caller')).toBe(true)
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
