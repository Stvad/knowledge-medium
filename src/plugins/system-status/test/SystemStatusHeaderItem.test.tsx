// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  publishConsistencyAudit,
  resetConsistencyAuditStore,
} from '@/plugins/data-integrity/store'
import { SystemStatusHeaderItem } from '../SystemStatusHeaderItem.tsx'
import {
  materializeQueueCountSql,
  uploadQueueCountCap,
  uploadQueueExactCountSql,
  uploadQueuePreviewCountSql,
} from '../queueCounts.ts'

const mocks = vi.hoisted(() => ({
  localOnly: false,
  updateAvailable: false,
  runActionById: vi.fn(),
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

// The dropdown's diagnostic buttons (Inspect / Reload / Enable) dispatch by
// action id through runActionById; assert the id rather than the side effect.
vi.mock('@/shortcuts/runAction.js', () => ({
  runActionById: (...args: unknown[]) => mocks.runActionById(...args),
}))

vi.mock('../RejectionDialog.tsx', () => ({
  RejectionDialog: () => null,
}))

// The component scopes the audit result to the active workspace; the published
// test results below use workspaceId 'ws-1' to match.
vi.mock('@/context/repo.js', () => ({
  useRepo: () => ({activeWorkspaceId: 'ws-1'}),
}))

// The chip reads the diagnostics seam via useAppRuntime; expose a runtime whose
// diagnosticsFacet resolves to the real data-integrity source (which reads the
// audit store these tests publish to). Exercises the real seam, not a fake.
// A stable snapshot ref (useDiagnostics requires getSnapshot to be ref-stable).
const updateSnapshot = {
  severity: 'info',
  summary: 'A new version is available',
  actionId: 'app.reload',
  actionLabel: 'Reload',
  nudge: true,
}

vi.mock('@/extensions/runtimeContext.js', async () => {
  const {createDataIntegrityDiagnosticSource} = await import(
    '@/plugins/data-integrity/diagnosticsSource'
  )
  const {diagnosticsFacet} = await import('@/plugins/diagnostics/facet')
  const dataIntegrity = createDataIntegrityDiagnosticSource({activeWorkspaceId: 'ws-1'})
  // Mirror the real app-update diagnostic source (see appUpdateStatus.ts) so the
  // chip exercises the generic nudge+actionLabel path, driven by mocks.updateAvailable.
  const appUpdate = {
    id: 'app-update',
    label: 'App update',
    subscribe: () => () => {},
    getSnapshot: () => (mocks.updateAvailable ? updateSnapshot : null),
  } as unknown as typeof dataIntegrity
  const sources = new Map([[dataIntegrity.id, dataIntegrity], [appUpdate.id, appUpdate]])
  return {
    useAppRuntime: () => ({
      read: (facet: {id: string}) => (facet.id === diagnosticsFacet.id ? sources : new Map()),
    }),
  }
})

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

describe('SystemStatusHeaderItem', () => {
  beforeEach(() => {
    mocks.localOnly = false
    mocks.updateAvailable = false
    mocks.runActionById = vi.fn()
    mocks.queryCalls = []
    mocks.status = defaultStatus()
    setDeviceOnline(true)
    resetConsistencyAuditStore()
    mocks.queryResponses = new Map([
      [rejectedCountSql, {data: [{count: 0}]}],
      [uploadQueuePreviewCountSql, {data: [{count: uploadQueueCountCap + 1}]}],
      [uploadQueueExactCountSql, {data: [{count: 1032688}]}],
    ])
  })

  afterEach(() => {
    cleanup()
    setDeviceOnline(true)
    resetConsistencyAuditStore()
  })

  it('uses the capped queue count for the always-mounted remote indicator', () => {
    render(<SystemStatusHeaderItem/>)

    expect(screen.getByRole('button', {
      name: /1000\+ blocks changed, queued for upload/,
    })).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueuePreviewCountSql)).toBe(true)
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(false)
  })

  it('runs the exact queue count only after opening the details', async () => {
    render(<SystemStatusHeaderItem/>)

    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(false)

    fireEvent.pointerDown(screen.getByRole('button', {
      name: /1000\+ blocks changed, queued for upload/,
    }))

    expect(await screen.findByText('1,032,688 blocks changed, queued for upload')).toBeInTheDocument()
    expect(mocks.queryCalls.some(call => call.sql === uploadQueueExactCountSql)).toBe(true)
  })

  it('does not watch the upload queue for the local-only header state', async () => {
    mocks.localOnly = true

    render(<SystemStatusHeaderItem/>)

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

    render(<SystemStatusHeaderItem/>)

    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).toContain('Applying 12340 blocks of synced data')

    fireEvent.pointerDown(button)
    expect(await screen.findByText('12,340 blocks')).toBeInTheDocument()
  })

  it('shows the materializing state over a pending upload backlog (content is still missing)', () => {
    // Default mock has a capped (1000+) pending-upload count → would be "pending";
    // an unapplied staged backlog is the more important signal.
    mocks.queryResponses.set(materializeQueueCountSql, {data: [{count: 5}]})

    render(<SystemStatusHeaderItem/>)

    expect(screen.getByRole('button').getAttribute('aria-label'))
      .toContain('Applying 5 blocks of synced data')
  })

  it('does not watch the materialization queue for the local-only header state', () => {
    mocks.localOnly = true

    render(<SystemStatusHeaderItem/>)

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

    render(<SystemStatusHeaderItem/>)

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

      render(<SystemStatusHeaderItem/>)

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

      render(<SystemStatusHeaderItem/>)

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
      const {rerender} = render(<SystemStatusHeaderItem/>)
      act(() => vi.advanceTimersByTime(6_000))
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .toMatch(/needs attention/i)

      // Error clears — indicator goes calm immediately.
      mocks.status = healthy
      rerender(<SystemStatusHeaderItem/>)
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .not.toMatch(/needs attention/i)

      // Same error recurs: it must NOT flash instantly — the grace window
      // applies afresh (this is the regression the debounce reset guards).
      mocks.status = erroring
      rerender(<SystemStatusHeaderItem/>)
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .not.toMatch(/needs attention/i)

      act(() => vi.advanceTimersByTime(6_000))
      expect(screen.getByRole('button').getAttribute('aria-label'))
        .toMatch(/needs attention/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalates the chip to an integrity error and names the source in the details', async () => {
    // Settled (synced) base so the integrity escalation applies, not a spinner.
    mocks.queryResponses.set(uploadQueuePreviewCountSql, {data: [{count: 0}]})
    publishConsistencyAudit({
      workspaceId: 'ws-1',
      checkedAt: 1,
      anomalies: 2,
      checks: {
        references_index_mirror: {status: 'anomaly'},
        property_ref_at_rest: {status: 'anomaly'},
        local_server_divergence: {status: 'ok'},
      },
    })

    render(<SystemStatusHeaderItem/>)

    const button = screen.getByRole('button')
    // Generic diagnostics escalation: "<label>: <summary>".
    expect(button.getAttribute('aria-label')).toContain('Data integrity: 2 issues found')

    fireEvent.pointerDown(button)
    expect(await screen.findByText('Data integrity: 2 issues found')).toBeInTheDocument()
    // The flagged check names are the detail; the full per-check breakdown lives
    // in the audit dialog (opened via Inspect).
    expect(screen.getByText(/references_index_mirror/)).toBeInTheDocument()
    expect(screen.getByRole('button', {name: 'Inspect'})).toBeInTheDocument()
  })

  it('leaves the chip clean when the audit reports no anomalies', () => {
    mocks.queryResponses.set(uploadQueuePreviewCountSql, {data: [{count: 0}]})
    publishConsistencyAudit({
      workspaceId: 'ws-1',
      checkedAt: 2,
      anomalies: 0,
      checks: {
        references_index_mirror: {status: 'ok'},
      },
    })

    render(<SystemStatusHeaderItem/>)

    expect(screen.getByRole('button').getAttribute('aria-label')).not.toContain('Data integrity')
  })

  it('surfaces a sub-threshold finding as muted info without reddening the chip', async () => {
    mocks.queryResponses.set(uploadQueuePreviewCountSql, {data: [{count: 0}]})
    publishConsistencyAudit({
      workspaceId: 'ws-1',
      checkedAt: 3,
      anomalies: 0, // below the alert floor → not an anomaly, but a benign baseline
      checks: {
        property_ref_at_rest: {status: 'ok', total: 3},
      },
    })

    render(<SystemStatusHeaderItem/>)

    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).not.toContain('Data integrity') // chip stays calm

    fireEvent.pointerDown(button)
    // Restored "below alert threshold" band — shown as muted info, dot not reddened.
    expect(await screen.findByText('Data integrity: 1 below-threshold finding')).toBeInTheDocument()
  })

  it('a fully clean audit surfaces nothing in the dropdown', async () => {
    mocks.queryResponses.set(uploadQueuePreviewCountSql, {data: [{count: 0}]})
    publishConsistencyAudit({
      workspaceId: 'ws-1',
      checkedAt: 4,
      anomalies: 0,
      checks: {references_index_mirror: {status: 'ok'}},
    })

    render(<SystemStatusHeaderItem/>)

    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-label')).not.toContain('Data integrity')
    fireEvent.pointerDown(button)
    expect(screen.queryByText(/Data integrity/)).not.toBeInTheDocument()
  })

  it('surfaces an app-update nudge with a Reload action when a new build is ready', async () => {
    mocks.updateAvailable = true

    render(<SystemStatusHeaderItem/>)

    // The header chip carries the dot, exposed to assistive tech via the label.
    expect(screen.getByRole('button').getAttribute('aria-label'))
      .toMatch(/new version is available/i)

    fireEvent.pointerDown(screen.getByRole('button'))

    // Rendered generically from the diagnostics seam: "<label>: <summary>".
    expect(await screen.findByText('App update: A new version is available')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', {name: 'Reload'}))
    expect(mocks.runActionById).toHaveBeenCalledWith('app.reload', expect.anything())
  })
})
