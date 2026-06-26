import { describe, expect, it, vi } from 'vitest'
import { buildReport, REASONS } from './report.js'
import type { AuditResult } from './types.js'

// An OPAQUE fake redactor (does NOT echo the input) so a test can prove the raw
// path is genuinely stripped, and a spy so we can prove redact ran on each path.
const makeRedact = () => vi.fn((s: string) => `OPAQUE_${s.length}`)

describe('buildReport', () => {
  it('NOT ARMED → exit 1, an ::error:: (fails loud — media capture shipped, so a missing key is a misconfig)', () => {
    const r = buildReport({ armed: false }, makeRedact())
    expect(r.exitCode).toBe(1)
    expect(r.errors.join(' ')).toMatch(/NOT ARMED/)
    expect(r.warnings).toEqual([])
    expect(r.summary).toMatch(/NOT ARMED/)
  })

  it('clean scan → exit 0, a tally notice, no errors, ✅ summary', () => {
    const result: AuditResult = { workspaces: 2, scanned: 5, findings: [] }
    const r = buildReport({ armed: true, result }, makeRedact())
    expect(r.exitCode).toBe(0)
    expect(r.notices.join(' ')).toContain('2 E2EE workspace(s), 5 object(s) scanned, 0 finding(s)')
    expect(r.errors).toEqual([])
    expect(r.summary).toMatch(/✅/)
  })

  it('findings → exit 1, one REDACTED ::error:: per finding + an aggregate, ❌ summary', () => {
    const result: AuditResult = {
      workspaces: 1,
      scanned: 3,
      findings: [
        { kind: 'plaintext', path: 'ws1/secretkey' },
        { kind: 'nested', path: 'ws1/sub/' },
      ],
    }
    const redact = makeRedact()
    const r = buildReport({ armed: true, result }, redact)
    expect(r.exitCode).toBe(1)
    expect(r.errors).toHaveLength(3) // 2 findings + 1 aggregate
    // The load-bearing guarantee: redact ran on every finding path, the raw path
    // NEVER reaches the (public) log, and only the opaque form does.
    expect(redact).toHaveBeenCalledWith('ws1/secretkey')
    expect(redact).toHaveBeenCalledWith('ws1/sub/')
    const joined = r.errors.join('\n')
    expect(joined).not.toContain('ws1/secretkey')
    expect(joined).not.toContain('ws1/sub/')
    expect(r.errors[0]).toContain('OPAQUE_13') // 'ws1/secretkey'.length
    expect(r.errors[1]).toContain('OPAQUE_8') // 'ws1/sub/'.length
    expect(r.summary).toMatch(/❌/)
  })

  it('maps each finding kind to its reason text', () => {
    const result: AuditResult = {
      workspaces: 1,
      scanned: 1,
      findings: [
        { kind: 'plaintext', path: 'a/b' },
        { kind: 'nested', path: 'a/c/' },
        { kind: 'unreadable', path: 'a/d' },
      ],
    }
    const r = buildReport({ armed: true, result }, makeRedact())
    expect(r.errors[0]).toContain(REASONS.plaintext)
    expect(r.errors[1]).toContain(REASONS.nested)
    expect(r.errors[2]).toContain(REASONS.unreadable)
  })
})
