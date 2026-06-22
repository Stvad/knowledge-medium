import { afterEach, describe, expect, it } from 'vitest'
import type { ConsistencyAuditResult } from '../audit'
import {
  publishConsistencyAudit,
  resetConsistencyAuditStore,
} from '../store'
import {
  createDataIntegrityDiagnosticSource,
  mapAuditToSnapshot,
} from '../diagnosticsSource'

const result = (overrides: Partial<ConsistencyAuditResult> = {}): ConsistencyAuditResult => ({
  workspaceId: 'ws-1',
  checkedAt: 1000,
  anomalies: 0,
  checks: {},
  ...overrides,
})

afterEach(() => resetConsistencyAuditStore())

describe('mapAuditToSnapshot', () => {
  it('maps a clean audit to ok', () => {
    const s = mapAuditToSnapshot(result())
    expect(s.severity).toBe('ok')
    expect(s.summary).toBe('All checks passed')
  })
  it('maps anomalies to error, with the flagged checks in detail', () => {
    const s = mapAuditToSnapshot(
      result({
        anomalies: 2,
        checks: {
          local_server_divergence: { status: 'anomaly' },
          references_index_mirror: { status: 'anomaly' },
        },
      }),
    )
    expect(s.severity).toBe('error')
    expect(s.summary).toBe('2 issues found')
    expect(s.detail).toContain('local_server_divergence')
  })
  it('maps a check that could not run to a warning (not an error)', () => {
    const s = mapAuditToSnapshot(result({ checks: { x: { status: 'error', error: 'boom' } } }))
    expect(s.severity).toBe('warning')
    expect(s.summary).toContain("couldn't run")
  })
})

describe('createDataIntegrityDiagnosticSource', () => {
  it('reports nothing until an audit for the active workspace publishes', () => {
    const source = createDataIntegrityDiagnosticSource({ activeWorkspaceId: 'ws-1' })
    expect(source.getSnapshot()).toBeNull()
    publishConsistencyAudit(
      result({ anomalies: 1, checks: { d: { status: 'anomaly' } } }),
    )
    expect(source.getSnapshot()?.severity).toBe('error')
  })
  it('ignores a result for a different workspace', () => {
    const source = createDataIntegrityDiagnosticSource({ activeWorkspaceId: 'ws-1' })
    publishConsistencyAudit(result({ workspaceId: 'ws-OTHER', anomalies: 5 }))
    expect(source.getSnapshot()).toBeNull()
  })
  it('returns a referentially stable snapshot between unchanged reads', () => {
    const source = createDataIntegrityDiagnosticSource({ activeWorkspaceId: 'ws-1' })
    publishConsistencyAudit(result())
    expect(source.getSnapshot()).toBe(source.getSnapshot())
  })
})
