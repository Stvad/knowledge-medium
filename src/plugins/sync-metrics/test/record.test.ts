// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SyncDrainStats } from '@/data/internals/syncObserver/observer'
import { buildDownloadRecord, buildDrainRecord, isWorthRecording } from '../record'

const header = { recordedAt: 1700, appVersion: '2026.11.19', appSha: 'abc123', clientId: 'client-9', deviceLabel: 'installed:MacIntel' }

const stats: SyncDrainStats = {
  source: 'queue', completed: true, wallMs: 1234.6, windows: 3, rows: 2500,
  applied: 2400, deferred: 50, skippedStale: 30, quarantined: 10, deleted: 10,
  readMs: 100.4, decodeMs: 200.5, writeMs: 700.49, invalidateMs: 50.2, queueMs: 9.9,
}

describe('buildDrainRecord', () => {
  it('carries every stat field, rounds ms to integers and adds the arrival context', () => {
    const record = buildDrainRecord(stats, { endedAtMs: 5000.4, sinceBootMs: 800.7, hasSynced: false }, header)
    expect(record).toEqual({
      ...header,
      kind: 'drain',
      endedAtMs: 5000,
      sinceBootMs: 801,
      hasSynced: false,
      source: 'queue', completed: true, windows: 3, rows: 2500,
      applied: 2400, deferred: 50, skippedStale: 30, quarantined: 10, deleted: 10,
      wallMs: 1235, readMs: 100, decodeMs: 201, writeMs: 700, invalidateMs: 50, queueMs: 10,
    })
  })
})

describe('buildDownloadRecord', () => {
  it('rounds the timings and keeps unobserved phases absent', () => {
    const record = buildDownloadRecord(
      { startedAtMs: 900.2, totalMs: 4000.5, totalOperations: 10 },
      header,
    )
    expect(record).toEqual({
      ...header, kind: 'download', startedAtMs: 900, totalMs: 4001, totalOperations: 10,
      downloadMs: undefined, applyMs: undefined, operationsAtStart: undefined,
    })
  })
})

describe('isWorthRecording', () => {
  it('records a backlog-sized drain even when it was fast', () => {
    expect(isWorthRecording({ rows: 1000, wallMs: 10 })).toBe(true)
  })
  it('records a slow drain even when it was small', () => {
    expect(isWorthRecording({ rows: 3, wallMs: 5000 })).toBe(true)
  })
  it('ignores a small fast drain', () => {
    expect(isWorthRecording({ rows: 999, wallMs: 4999 })).toBe(false)
  })
})
