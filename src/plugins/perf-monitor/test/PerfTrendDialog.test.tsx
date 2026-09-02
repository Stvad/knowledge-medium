// @vitest-environment happy-dom
/**
 * The dialog is pinned to the workspace it opened on, but a fresh analysis
 * reads AMBIENT state — `repo.isReadOnly` describes whichever workspace is
 * active now, not the pinned one.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PerfTrendDialog } from '../PerfTrendDialog.tsx'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import type { User } from '@/data/api'
import {
  interactionRecordProp,
  interactionRecordType,
  writeInteractionSample,
} from '@/plugins/interaction-metrics/record'
import {
  startupRecordProp,
  startupRecordType,
  writeStartupRecord,
} from '@/plugins/startup-metrics/record'

/** The stub the workspace-pinning tests use: they never read the series, and a
 *  real Repo would make them slow for nothing. `mocks.repo` is swapped for a
 *  real one by the rendering tests below. */
const STUB = {
  activeWorkspaceId: 'ws-A',
  user: { id: 'user-1', name: 'Alice' },
  db: { getAll: async () => [] as unknown[] },
}

const mocks = vi.hoisted(() => ({
  repo: {
    activeWorkspaceId: 'ws-A',
    user: { id: 'user-1', name: 'Alice' },
    db: { getAll: async () => [] as unknown[] },
  } as unknown as Repo,
  runNow: vi.fn(async () => {}),
}))

vi.mock('@/context/repo.tsx', () => ({ useRepo: () => mocks.repo }))
vi.mock('../schedule.ts', () => ({ runPerfAnalysisNow: mocks.runNow }))

afterEach(() => {
  vi.clearAllMocks()
  mocks.repo = STUB as unknown as Repo
})

const reanalyze = () => screen.getByRole('button', { name: /re-analyze/i })

beforeEach(() => { STUB.activeWorkspaceId = 'ws-A' })

describe('PerfTrendDialog', () => {
  it('offers re-analysis for the workspace it is pinned to', async () => {
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId="ws-A" />)
    await waitFor(() => expect(reanalyze()).toBeEnabled())
  })

  // Analyzing the pinned workspace from inside another reports the ACTIVE
  // workspace's blocker as the pinned one's: an editable workspace shown as
  // recording-disabled, or a read-only one shown as fine.
  it('refuses re-analysis once the active workspace has moved on', async () => {
    STUB.activeWorkspaceId = 'ws-B'
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId="ws-A" />)

    await waitFor(() => expect(reanalyze()).toBeDisabled())
    expect(screen.getByText(/switched workspace/i)).toBeInTheDocument()
    expect(mocks.runNow).not.toHaveBeenCalled()
  })
})

/**
 * The tables against a REAL repo and real written records.
 *
 * These exist because the surface they cover was broken and green: the reader
 * takes a property NAME and derives the JSON path itself, and this dialog was
 * handing it an already-derived PATH — so both tables silently rendered their
 * empty state while the analysis, which passed the name, read the same history
 * fine. Nothing caught it, because the only repo this file had was a stub whose
 * `db.getAll` returned `[]`: every assertion about the tables was an assertion
 * about a mock. A test that never sees a row cannot tell an empty series from
 * an unreadable one.
 */
describe('PerfTrendDialog tables', () => {
  const WS = 'ws-A'
  const USER: User = { id: 'user-1', name: 'Alice' }
  let sharedDb: TestDb
  let repo: Repo

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({
      db: sharedDb.db,
      user: USER,
      extensions: [
        definitionSeedsFacet.of(interactionRecordProp, { source: 'test' }),
        typeSeedsFacet.of(interactionRecordType, { source: 'test' }),
        definitionSeedsFacet.of(startupRecordProp, { source: 'test' }),
        typeSeedsFacet.of(startupRecordType, { source: 'test' }),
      ],
    }).repo
    repo.setActiveWorkspaceId(WS)
    mocks.repo = repo
  })

  // Written with the production writers, not hand-built rows: a fixture shaped
  // by hand agrees with whatever the reader expects by construction, which is
  // exactly the agreement under test.
  it('renders what the recorders wrote', async () => {
    expect(await writeInteractionSample(repo, WS)).toBeTruthy()
    expect(await writeStartupRecord(repo, WS)).toBeTruthy()

    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)

    // Wait for the LOADED state on each table rather than for the absence of
    // the empty-state text: absence is also what a pending load looks like.
    await waitFor(() => {
      expect(screen.queryByText(/no interaction records/i)).toBeNull()
      expect(screen.queryByText(/no startup records/i)).toBeNull()
    })
    expect(screen.queryByText(/loading/i)).toBeNull()
    expect(screen.getAllByRole('table')).toHaveLength(2)
  })

  // The empty state has to be reachable too, or the assertion above proves only
  // that something rendered.
  it('says so when the device has no history', async () => {
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)
    await waitFor(() => {
      expect(screen.getByText(/no startup records/i)).toBeInTheDocument()
      expect(screen.getByText(/no interaction records/i)).toBeInTheDocument()
    })
  })
})
