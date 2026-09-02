// @vitest-environment happy-dom
/**
 * The dialog is pinned to the workspace it opened on, but a fresh analysis
 * reads AMBIENT state — `repo.isReadOnly` describes whichever workspace is
 * active now, not the pinned one.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
vi.mock('@/utils/toast.js', () => ({ showError: vi.fn(), showProgress: vi.fn() }))

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
    // Clicked, not merely observed: asserting `not.toHaveBeenCalled()` without
    // a click passes under every implementation, including one with no guard.
    await userEvent.click(reanalyze())
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

    // Wait on the POSITIVE — both tables present — and only then assert the
    // empty states are gone. Waiting on their absence instead settles on the
    // first tick, because a table that is still LOADING shows neither its rows
    // nor its empty state; the assertions then run against a pending load and
    // the test is a coin flip. (Measured at this exact mistake: ~1 run in 8.)
    await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(2))
    expect(screen.queryByText(/no interaction records/i)).toBeNull()
    expect(screen.queryByText(/no startup records/i)).toBeNull()
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

/**
 * A refresh the dialog has moved past must not publish its history.
 *
 * The manual path used to hard-code its load as alive, so a refresh in flight
 * when the Repo was swapped resolved afterwards and wrote the previous user's
 * rows into the open dialog. Asserted on the CAUSE — the reads never run — via
 * the query count, because "the table did not change" is also what a load that
 * simply returned the same rows looks like.
 */
describe('a superseded refresh', () => {
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

  it('reads no history once the dialog it belonged to is gone', async () => {
    await writeInteractionSample(repo, WS)
    await writeStartupRecord(repo, WS)
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)
    await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(2))

    // Hold the analysis open so the refresh is mid-flight when we supersede it.
    let release = (): void => {}
    mocks.runNow.mockImplementationOnce(
      () => new Promise<void>((resolve) => { release = () => resolve() }))
    await userEvent.click(screen.getByRole('button', { name: /re-analyze/i }))

    // The dialog goes away — the same invalidation a Repo swap performs.
    cleanup()
    // Counted at CALL time. `repo.metrics().db.getAll.calls` increments in a
    // `finally` after the round trip, so watching it means waiting for a
    // duration — which is what an earlier version of this test did, and it
    // could not fail: under load the continuation outlives any window chosen
    // here. A spy increments the instant the read is issued.
    const reads = vi.spyOn(repo.db, 'getAll')
    release()

    // One event-loop TURN, not a duration. The refresh resumes in a microtask
    // off the promise just resolved and issues its reads synchronously from
    // there, so a macrotask boundary — after which every pending microtask has
    // run — is a language guarantee rather than a bet on timing. It neither
    // slows a passing run nor weakens under gate load.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(reads).not.toHaveBeenCalled()
  })
})

/**
 * Rows belong to the Repo they were read from.
 *
 * A local sign-out swaps the Repo without a reload. Held in bare state the
 * previous user's rows keep rendering until the new read finishes — and forever
 * if it fails, since the catch path writes no state. Deriving what is shown
 * from the data's owner makes that unrepresentable rather than cleared.
 */
describe('rows after a Repo swap', () => {
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

  it('stops showing them when the new Repo cannot read', async () => {
    await writeInteractionSample(repo, WS)
    await writeStartupRecord(repo, WS)
    const view = render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)
    await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(2))

    // The swap, with a Repo whose reads FAIL — the case bare state cannot
    // recover from, because the catch path writes nothing.
    mocks.repo = {
      activeWorkspaceId: WS,
      user: USER,
      db: { getAll: async () => { throw new Error('gone') } },
    } as unknown as Repo
    view.rerender(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)

    await waitFor(() => expect(screen.queryAllByRole('table')).toHaveLength(0))
  })
})
