// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SyncDrainStats } from '@/data/internals/syncObserver/observer'
import {
  buildDownloadRecord, buildDrainRecord, isWorthRecording,
  DRAIN_RECORD_MIN_ROWS, DRAIN_RECORD_MIN_WALL_MS, DRAIN_RECORD_SLOW_MIN_ROWS,
} from '../record'

const header = { recordedAt: 1700, appVersion: '2026.11.19', appSha: 'abc123', clientId: 'client-9', deviceLabel: 'installed:MacIntel' }

const stats: SyncDrainStats = {
  source: 'queue', completed: true, endedAtMs: 5000.4, wallMs: 1234.6, windows: 3, rows: 2500,
  applied: 2400, deferred: 50, skippedStale: 30, quarantined: 10, deleted: 10,
  readMs: 100.4, decodeMs: 200.5, writeMs: 700.49, invalidateMs: 50.2, bookkeepingMs: 9.9, deferredIndexRows: 3, deferredIndexMs: 40.6,
}

describe('buildDrainRecord', () => {
  it('carries every stat field and rounds ms to integers', () => {
    expect(buildDrainRecord(stats, header)).toEqual({
      ...header,
      kind: 'drain',
      source: 'queue', completed: true, windows: 3, rows: 2500,
      applied: 2400, deferred: 50, skippedStale: 30, quarantined: 10, deleted: 10,
      endedAtMs: 5000, wallMs: 1235, readMs: 100, decodeMs: 201, writeMs: 700, invalidateMs: 50, bookkeepingMs: 10, deferredIndexRows: 3, deferredIndexMs: 41,
    })
  })

  it('does not carry a field the record does not list', () => {
    const withExtra = { ...stats, futureField: 7 } as SyncDrainStats
    expect(buildDrainRecord(withExtra, header)).not.toHaveProperty('futureField')
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
  it.each([
    ['a backlog-sized drain, however fast', DRAIN_RECORD_MIN_ROWS, 0, true],
    ['a slow drain with enough rows', DRAIN_RECORD_SLOW_MIN_ROWS, DRAIN_RECORD_MIN_WALL_MS, true],
    ['a slow drain below the row floor (an upload echo under lock contention)', DRAIN_RECORD_SLOW_MIN_ROWS - 1, DRAIN_RECORD_MIN_WALL_MS, false],
    ['a small fast drain', DRAIN_RECORD_SLOW_MIN_ROWS, 0, false],
  ])('%s', (_name, rows, wallMs, expected) => {
    expect(isWorthRecording({ rows, wallMs })).toBe(expected)
  })
})
