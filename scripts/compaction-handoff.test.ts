import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { injectHandoff } from './compaction-handoff.mjs'
import { contextOf, tempDirs } from './hook-test-support'

const tempDir = tempDirs()
// Claude Code inlines up to this many chars of one hook's context; past it the model sees a 2K preview.
const HOST_INLINE_LIMIT = 10_000

let scratchpad: string
let payload: Record<string, string>

const writeHandoff = (text: string) => {
  mkdirSync(scratchpad, { recursive: true })
  writeFileSync(join(scratchpad, 'handoff.md'), text)
}

beforeEach(() => {
  scratchpad = join(tempDir('compaction-handoff-'), 'scratchpad')
  payload = { session_id: 'session-1', scratchpad_dir: scratchpad, source: 'compact' }
})

describe('injectHandoff', () => {
  it('injects the handoff once, then moves it aside so a later compaction does not replay it', () => {
    writeHandoff('# Handoff\nNext: re-run the gate\n')
    const context = injectHandoff(payload)
    const consumed = join(scratchpad, 'handoff.consumed.md')
    expect(context).toContain('# Handoff\nNext: re-run the gate\n')
    expect(context).not.toContain('not shown')
    expect(context).toContain(consumed)
    expect(existsSync(join(scratchpad, 'handoff.md'))).toBe(false)
    expect(readFileSync(consumed, 'utf8')).toBe('# Handoff\nNext: re-run the gate\n')
    expect(injectHandoff(payload)).toBe('')
  })

  it('is silent when the session prepared no handoff', () => {
    expect(injectHandoff(payload)).toBe('')
    mkdirSync(scratchpad, { recursive: true })
    expect(injectHandoff(payload)).toBe('')
  })

  it('says how long before the compaction the handoff was written', () => {
    writeHandoff('state\n')
    const now = Date.now()
    utimesSync(join(scratchpad, 'handoff.md'), (now - 7 * 60_000) / 1000, (now - 7 * 60_000) / 1000)
    expect(injectHandoff(payload, now)).toMatch(/\b7 min before/)
  })

  it('clips a long handoff at a line boundary and says where the rest is', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(90)}`)
    writeHandoff(lines.join('\n'))
    const context = injectHandoff(payload)
    expect(context.length).toBeLessThan(HOST_INLINE_LIMIT)
    const shown = context.split('\n').filter(l => l.startsWith('line '))
    expect(shown.length).toBeGreaterThan(0)
    expect(shown.length).toBeLessThan(200)
    expect(shown.at(-1)).toBe(lines[shown.length - 1])
    expect(context).toContain(`${200 - shown.length} more lines not shown: read them at ${join(scratchpad, 'handoff.consumed.md')}`)
  })

  it('ignores a session that has no scratchpad', () => {
    writeHandoff('state\n')
    expect(injectHandoff({ session_id: 'session-1', source: 'compact' })).toBe('')
    expect(existsSync(join(scratchpad, 'handoff.md'))).toBe(true)
  })
})

describe('hook end-to-end', { timeout: 20_000 }, () => {
  const script = fileURLToPath(new URL('./compaction-handoff.mjs', import.meta.url))
  const run = (input: string) => spawnSync('node', [script], { input, encoding: 'utf8' })

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
