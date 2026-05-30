import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncStatusHeaderItem } from '../SyncStatusHeaderItem.tsx'
import {
  uploadQueueCountCap,
  uploadQueueExactCountSql,
  uploadQueuePreviewCountSql,
} from '../queueCounts.ts'

const mocks = vi.hoisted(() => ({
  localOnly: false,
  queryCalls: [] as Array<{sql: string, params: unknown[], options: Record<string, unknown>}>,
  queryResponses: new Map<string, {data: Array<{count: number}>, error?: Error}>(),
  status: {
    connected: true,
    connecting: false,
    hasSynced: true,
    dataFlowStatus: {
      uploading: false,
      downloading: false,
      uploadError: null,
      downloadError: null,
    },
    downloadProgress: null,
    lastSyncedAt: undefined,
  },
}))

vi.mock('@powersync/react', () => ({
  useStatus: () => mocks.status,
  useQuery: (sql: string, params: unknown[] = [], options: Record<string, unknown> = {}) => {
    mocks.queryCalls.push({sql, params, options})
    return {
      data: mocks.queryResponses.get(sql)?.data ?? [],
      error: mocks.queryResponses.get(sql)?.error,
      isLoading: false,
      isFetching: false,
    }
  },
}))

vi.mock('@/components/Login.js', () => ({
  useIsLocalOnly: () => mocks.localOnly,
}))

vi.mock('../RejectionDialog.tsx', () => ({
  RejectionDialog: () => null,
}))

const rejectedCountSql = 'SELECT COUNT(*) AS count FROM ps_crud_rejected'

describe('SyncStatusHeaderItem', () => {
  beforeEach(() => {
    mocks.localOnly = false
    mocks.queryCalls = []
    mocks.queryResponses = new Map([
      [rejectedCountSql, {data: [{count: 0}]}],
      [uploadQueuePreviewCountSql, {data: [{count: uploadQueueCountCap + 1}]}],
      [uploadQueueExactCountSql, {data: [{count: 1032688}]}],
    ])
  })

  afterEach(() => {
    cleanup()
  })

  it('uses the capped queue count for the always-mounted remote indicator', () => {
    render(<SyncStatusHeaderItem/>)

    expect(screen.getByRole('button', {
      name: /1000\+ local changes queued for upload/,
    })).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueuePreviewCountSql)).toBe(true)
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(false)
  })

  it('runs the exact queue count only after opening the details', async () => {
    render(<SyncStatusHeaderItem/>)

    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(false)

    fireEvent.pointerDown(screen.getByRole('button', {
      name: /1000\+ local changes queued for upload/,
    }))

    expect(await screen.findByText('1,032,688 changes queued for upload')).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(true)
  })

  it('does not watch the upload queue for the local-only header state', async () => {
    mocks.localOnly = true

    render(<SyncStatusHeaderItem/>)

    expect(screen.getByRole('button', {name: 'Remote sync is disabled.'})).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueuePreviewCountSql)).toBe(false)
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(false)

    fireEvent.pointerDown(screen.getByRole('button', {name: 'Remote sync is disabled.'}))

    expect(await screen.findByText('1,032,688 changes stored locally')).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(true)
  })
})
