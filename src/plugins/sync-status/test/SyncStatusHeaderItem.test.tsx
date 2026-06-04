import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SyncStatusHeaderItem } from '../SyncStatusHeaderItem.tsx'
import {
  materializeQueueCountSql,
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
      uploadError: null as {message: string} | null,
      downloadError: null as {message: string} | null,
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

const defaultStatus = () => ({
  connected: true,
  connecting: false,
  hasSynced: true,
  dataFlowStatus: {
    uploading: false,
    downloading: false,
    uploadError: null as {message: string} | null,
    downloadError: null as {message: string} | null,
  },
  downloadProgress: null,
  lastSyncedAt: undefined,
})

const setDeviceOnline = (online: boolean) => {
  Object.defineProperty(navigator, 'onLine', {configurable: true, value: online})
}

describe('SyncStatusHeaderItem', () => {
  beforeEach(() => {
    mocks.localOnly = false
    mocks.queryCalls = []
    mocks.status = defaultStatus()
    setDeviceOnline(true)
    mocks.queryResponses = new Map([
      [rejectedCountSql, {data: [{count: 0}]}],
      [uploadQueuePreviewCountSql, {data: [{count: uploadQueueCountCap + 1}]}],
      [uploadQueueExactCountSql, {data: [{count: 1032688}]}],
    ])
  })

  afterEach(() => {
    cleanup()
    setDeviceOnline(true)
  })

  it('uses the capped queue count for the always-mounted remote indicator', () => {
    render(<SyncStatusHeaderItem/>)

    expect(screen.getByRole('button', {
      name: /1000\+ blocks changed, queued for upload/,
    })).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueuePreviewCountSql)).toBe(true)
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(false)
  })

  it('runs the exact queue count only after opening the details', async () => {
    render(<SyncStatusHeaderItem/>)

    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(false)

    fireEvent.pointerDown(screen.getByRole('button', {
      name: /1000\+ blocks changed, queued for upload/,
    }))

    expect(await screen.findByText('1,032,688 blocks changed, queued for upload')).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(true)
  })

  it('does not watch the upload queue for the local-only header state', async () => {
    mocks.localOnly = true

    render(<SyncStatusHeaderItem/>)

    expect(screen.getByRole('button', {name: 'Remote sync is disabled.'})).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueuePreviewCountSql)).toBe(false)
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(false)

    fireEvent.pointerDown(screen.getByRole('button', {name: 'Remote sync is disabled.'}))

    expect(await screen.findByText('1,032,688 blocks changed, stored locally')).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(true)
  })

  it('surfaces the materialization backlog as a processing state with a count', async () => {
    // No pending uploads — just a staged backlog the observer hasn't applied yet.
    mocks.queryResponses.set(uploadQueuePreviewCountSql, {data: [{count: 0}]})
    mocks.queryResponses.set(materializeQueueCountSql, {data: [{count: 12_340}]})

    render(<SyncStatusHeaderItem/>)

    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).toContain('Applying 12340 blocks of synced data')

    fireEvent.pointerDown(button)
    expect(await screen.findByText('12,340 blocks')).toBeInTheDocument()
  })

  it('shows the materializing state over a pending upload backlog (content is still missing)', () => {
    // Default mock has a capped (1000+) pending-upload count → would be "pending";
    // an unapplied staged backlog is the more important signal.
    mocks.queryResponses.set(materializeQueueCountSql, {data: [{count: 5}]})

    render(<SyncStatusHeaderItem/>)

    expect(screen.getByRole('button').getAttribute('aria-label'))
      .toContain('Applying 5 blocks of synced data')
  })

  it('does not watch the materialization queue for the local-only header state', () => {
    mocks.localOnly = true

    render(<SyncStatusHeaderItem/>)

    expect(mocks.queryCalls.some(call => call.sql === materializeQueueCountSql)).toBe(false)
  })

  it('shows a calm "offline" state instead of the websocket error when the device is offline', () => {
    setDeviceOnline(false)
    mocks.status = {
      ...defaultStatus(),
      connected: false,
      dataFlowStatus: {
        uploading: false,
        downloading: false,
        uploadError: null,
        downloadError: {message: 'WebSocket connection failed: 1006'},
      },
    }
    mocks.queryResponses.set(uploadQueuePreviewCountSql, {data: [{count: 0}]})

    render(<SyncStatusHeaderItem/>)

    const label = screen.getByRole('button').getAttribute('aria-label') ?? ''
    expect(label.toLowerCase()).toContain('offline')
    expect(label).not.toContain('WebSocket')
  })

  it('surfaces a persistent sync error when the device is online but sync is disconnected', () => {
    // PowerSync flips connected:false during its retry loop after a real
    // failure (bad endpoint, 401/403, server stream error). With the device
    // online, that error is actionable and must surface — not be hidden
    // behind a generic Offline/Connecting chip.
    vi.useFakeTimers()
    try {
      setDeviceOnline(true)
      mocks.status = {
        ...defaultStatus(),
        connected: false,
        connecting: true,
        dataFlowStatus: {
          uploading: false,
          downloading: false,
          uploadError: null,
          downloadError: {message: 'PowerSync endpoint returned 401'},
        },
      }
      mocks.queryResponses.set(uploadQueuePreviewCountSql, {data: [{count: 0}]})

      render(<SyncStatusHeaderItem/>)

      // Still within the grace window — calm.
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .not.toMatch(/needs attention/i)

      act(() => vi.advanceTimersByTime(6_000))

      const label = screen.getByRole('button').getAttribute('aria-label') ?? ''
      expect(label).toMatch(/needs attention/i)
      expect(label).toContain('401')
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits out the grace window before surfacing a transient sync error', () => {
    vi.useFakeTimers()
    try {
      mocks.status = {
        ...defaultStatus(),
        connected: true,
        dataFlowStatus: {
          uploading: false,
          downloading: false,
          uploadError: {message: 'token refresh hiccup'},
          downloadError: null,
        },
      }
      mocks.queryResponses.set(uploadQueuePreviewCountSql, {data: [{count: 0}]})

      render(<SyncStatusHeaderItem/>)

      // Immediately after the blip the indicator stays calm — no error.
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .not.toMatch(/needs attention/i)

      // Once the error has persisted past the grace window it surfaces.
      act(() => {
        vi.advanceTimersByTime(6_000)
      })
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .toMatch(/needs attention/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-applies the grace window when an error clears and recurs', () => {
    vi.useFakeTimers()
    try {
      const erroring = {
        ...defaultStatus(),
        connected: true,
        dataFlowStatus: {
          uploading: false,
          downloading: false,
          uploadError: {message: 'token refresh hiccup'},
          downloadError: null,
        },
      }
      const healthy = {...defaultStatus(), connected: true}
      mocks.queryResponses.set(uploadQueuePreviewCountSql, {data: [{count: 0}]})

      // First occurrence rides out its grace window and surfaces.
      mocks.status = erroring
      const {rerender} = render(<SyncStatusHeaderItem/>)
      act(() => vi.advanceTimersByTime(6_000))
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .toMatch(/needs attention/i)

      // Error clears — indicator goes calm immediately.
      mocks.status = healthy
      rerender(<SyncStatusHeaderItem/>)
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .not.toMatch(/needs attention/i)

      // Same error recurs: it must NOT flash instantly — the grace window
      // applies afresh (this is the regression the debounce reset guards).
      mocks.status = erroring
      rerender(<SyncStatusHeaderItem/>)
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .not.toMatch(/needs attention/i)

      act(() => vi.advanceTimersByTime(6_000))
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .toMatch(/needs attention/i)
    } finally {
      vi.useRealTimers()
    }
  })
})
