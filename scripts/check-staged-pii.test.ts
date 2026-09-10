import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const A_UUID = '123e4567-e89b-42d3-a456-426614174000'

describe('check-staged-pii end-to-end', { timeout: 30_000 }, () => {
  const script = fileURLToPath(new URL('./check-staged-pii.mjs', import.meta.url))
  const git = (cwd: string, args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    expect(r.status, `git ${args.join(' ')}: ${r.stderr}`).toBe(0)
  }
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'pii-guard-')))
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 't@example.com'])
  git(repo, ['config', 'user.name', 't'])
  writeFileSync(join(repo, 'f.txt'), 'clean\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'base'])

  const hook = (command: string) => {
    const payload = JSON.stringify({ tool_name: 'Bash', cwd: repo, tool_input: { command } })
    return spawnSync('node', [script], { cwd: repo, input: payload, encoding: 'utf8' })
  }

  it('blocks a uuid in the -m message', () => {
    const r = hook(`git commit -m "touch block ${A_UUID}"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('(commit message)')
  })

  it('does NOT block a uuid that is only in a redirect path (scratchpad shape)', () => {
    expect(hook(`git commit -m "clean message" > /tmp/claude-1/${A_UUID}/scratchpad/out.log`).status).toBe(0)
  })

  it('blocks a uuid smuggled through a variable expansion', () => {
    const r = hook(`MSG="touch block ${A_UUID}"; git commit -m "$MSG"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('(command line)')
  })

  it('blocks a uuid beside a slash in a variable-expanded message', () => {
    const r = hook(`MSG="fix page/${A_UUID} rendering"; git commit -m "$MSG"`)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('(command line)')
  })

  it('blocks a uuid in a heredoc commit body (the $(cat <<EOF) shape)', () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nfix block ${A_UUID}\nEOF\n)"`
    expect(hook(cmd).status).toBe(2)
  })

  it('does not block printed prose that mentions git commit beside a uuid', () => {
    expect(hook(`printf '%s\\n' git commit -m ${A_UUID}`).status).toBe(0)
  })

  it('still blocks a staged uuid regardless of the command line', () => {
    writeFileSync(join(repo, 'g.txt'), `id: ${A_UUID}\n`)
    git(repo, ['add', 'g.txt'])
    const r = hook('git commit -m "clean message"')
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('g.txt')
    git(repo, ['reset', '-q', 'g.txt'])
  })
})
