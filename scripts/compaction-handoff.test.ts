import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { CONTEXT_BUDGET, injectHandoff } from './compaction-handoff.mjs'
import { contextOf, tempDirs } from './hook-test-support'

const tempDir = tempDirs()
const SESSION = '0a1b2c3d-0000-4000-8000-000000000001'
const SLUG = '-work-checkout'

let tmp: string
let env: Record<string, string>
// What Claude Code lays out for a session whose project directory is /work/checkout.
const scratchpad = () => join(tmp, `claude-${process.getuid?.() ?? 0}`, SLUG, SESSION, 'scratchpad')
const payload = { session_id: SESSION, transcript_path: `/home/u/.claude/projects/${SLUG}/${SESSION}.jsonl`, source: 'compact' }

const writeHandoff = (text: string) => {
  mkdirSync(scratchpad(), { recursive: true })
  writeFileSync(join(scratchpad(), 'handoff.md'), text)
}

beforeEach(() => {
  tmp = tempDir('compaction-handoff-')
  env = { CLAUDE_CODE_TMPDIR: tmp }
})

describe('injectHandoff', () => {
  it('injects the handoff once, then moves it aside so a later compaction does not replay it', () => {
    writeHandoff('# Handoff\nNext: re-run the gate\n')
    const context = injectHandoff(payload, env)
    const consumed = join(scratchpad(), 'handoff.consumed.md')
    expect(context).toContain('# Handoff\nNext: re-run the gate\n')
    expect(context).not.toContain('clipped')
    expect(context).toContain(consumed)
    expect(existsSync(join(scratchpad(), 'handoff.md'))).toBe(false)
    expect(readFileSync(consumed, 'utf8')).toBe('# Handoff\nNext: re-run the gate\n')
    expect(injectHandoff(payload, env)).toBe('')
  })

  it('is silent when the session prepared no handoff', () => {
    expect(injectHandoff(payload, env)).toBe('')
    mkdirSync(scratchpad(), { recursive: true })
    expect(injectHandoff(payload, env)).toBe('')
  })

  it('says how long before the compaction the handoff was written', () => {
    writeHandoff('state\n')
    const now = Date.now()
    utimesSync(join(scratchpad(), 'handoff.md'), (now - 7 * 60_000) / 1000, (now - 7 * 60_000) / 1000)
    expect(injectHandoff(payload, env, now)).toMatch(/\b7 min before/)
  })

  it('clips a long handoff at a line boundary and says where the rest is', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(90)}`)
    writeHandoff(lines.join('\n'))
    const context = injectHandoff(payload, env)
    expect(context.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
    const shown = context.split('\n').filter(l => l.startsWith('line '))
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(200)
    expect(shown.at(-1)).toBe(lines[shown.length - 1])
    expect(context).toContain(`read the rest at ${join(scratchpad(), 'handoff.consumed.md')}`)
  })

  it('clips a handoff with no line breaks at the budget', () => {
    writeHandoff('y'.repeat(20_000))
    const context = injectHandoff(payload, env)
    expect(context.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
    expect(context).toContain('clipped at')
  })

  it('ignores a payload that names no session or transcript', () => {
    writeHandoff('state\n')
    expect(injectHandoff({ source: 'compact' }, env)).toBe('')
    expect(injectHandoff({ session_id: SESSION, source: 'compact' }, env)).toBe('')
    expect(existsSync(join(scratchpad(), 'handoff.md'))).toBe(true)
  })
})

describe('hook end-to-end', { timeout: 20_000 }, () => {
  const script = fileURLToPath(new URL('./compaction-handoff.mjs', import.meta.url))
  const run = (input: string) => spawnSync('node', [script], { input, encoding: 'utf8', env: { ...process.env, ...env } })

  it('emits the handoff as SessionStart context', () => {
    writeHandoff('# Handoff\nNext: reply on the PR\n')
    const r = run(JSON.stringify({ ...payload, hook_event_name: 'SessionStart' }))
    expect(r.status).toBe(0)
    expect(contextOf(r.stdout, 'SessionStart')).toContain('Next: reply on the PR')
  })

  it('prints nothing and exits 0 on a garbled payload', () => {
    writeHandoff('state\n')
    const r = run('not json')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
  })
})
