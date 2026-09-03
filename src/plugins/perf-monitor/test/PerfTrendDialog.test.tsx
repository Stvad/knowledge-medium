// @vitest-environment happy-dom
/**
 * The dialog is pinned to the workspace it opened on, but a fresh analysis
 * reads AMBIENT state — `repo.isReadOnly` describes whichever workspace is
 * active now, not the pinned one.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PerfTrendDialog } from '../PerfTrendDialog.tsx'
import { clearPerfAnalyses, publishPerfAnalysis, resetPerfAnalysisStore } from '../store'
import { resetMonitorRun, startMonitorRun } from '../monitorRun'
import { analysisFixture } from './fixtures'
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
  isReadOnly: false,
  onReadOnlyChange: () => () => {},
  onMetricsReset: () => () => {},
  db: { getAll: async () => [] as unknown[] },
}

const mocks = vi.hoisted(() => ({
  repo: {
    activeWorkspaceId: 'ws-A',
    user: { id: 'user-1', name: 'Alice' },
    isReadOnly: false,
    onReadOnlyChange: () => () => {},
    onMetricsReset: () => () => {},
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

const WS = 'ws-A'
const USER: User = { id: 'user-1', name: 'Alice' }

// ONE database for the file, reset between tests. Three groups here need a real
// repo, and opening a database per group multiplies the setup cost that makes
// these suites the long tail of the gate.
let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

/** A repo on the shared database, seeded with both recorders' schemas. */
const freshRepo = async (): Promise<void> => {
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
}

describe('PerfTrendDialog', () => {
  afterEach(() => { resetMonitorRun() })

  it('offers re-analysis for the workspace it is pinned to', async () => {
    startMonitorRun(mocks.repo, 'ws-A')
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId="ws-A" />)
    await waitFor(() => expect(reanalyze()).toBeEnabled())
  })

  // The monitor's own toggle can go off while this dialog stays mounted in the
  // shared DialogHost. Nothing can publish then, so the button would spin and
  // leave the panel saying there is no analysis — an advertised action with no
  // visible effect.
  it('refuses re-analysis once the monitor is switched off', async () => {
    startMonitorRun(mocks.repo, 'ws-A')
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId="ws-A" />)
    await waitFor(() => expect(reanalyze()).toBeEnabled())

    // The toggle going off, and the store notification its teardown sends.
    resetMonitorRun()
    act(() => { clearPerfAnalyses() })

    await waitFor(() => expect(reanalyze()).toBeDisabled())
    expect(screen.getByText(/monitoring is switched off/i)).toBeInTheDocument()
    await userEvent.click(reanalyze())
    expect(mocks.runNow).not.toHaveBeenCalled()
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
 * A stubbed reader makes every assertion here an assertion about the stub: a
 * test that never sees a row cannot tell an empty series from an unreadable
 * one, so it holds just as well when the dialog is addressing a property that
 * nothing writes. The rows must come from the production writers.
 */
describe('PerfTrendDialog tables', () => {
  beforeEach(freshRepo)

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
    // the test is a coin flip.
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
 * A refresh in flight when the Repo is swapped resolves afterwards, and must
 * not write the previous user's rows into the open dialog. Asserted on the
 * CAUSE — the reads never run — via the query count, because "the table did not
 * change" is also what a load that simply returned the same rows looks like.
 */
describe('a superseded refresh', () => {
  beforeEach(freshRepo)

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
    // `finally` AFTER the round trip, so it cannot prove a call did not happen —
    // watching it means waiting out a duration, and under load the continuation
    // outlives any window chosen here. A spy increments the instant the read is
    // issued, which is the event this asserts the absence of.
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
 * The blocker describes the PINNED workspace, or nothing.
 *
 * `repo.isReadOnly` follows whichever workspace is active, and the verdict
 * beside it describes the one this dialog opened on — so once those diverge the
 * blocker would speak for the wrong workspace.
 */
describe('the blocker on a dialog left behind', () => {
  beforeEach(freshRepo)
  afterEach(() => { resetPerfAnalysisStore(); resetMonitorRun() })

  it('says nothing about recording once the active workspace has moved on', async () => {
    startMonitorRun(repo, WS)
    publishPerfAnalysis(analysisFixture({ workspaceId: WS }))
    repo.setReadOnly(true)
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)
    // On its own workspace, the blocker is reported.
    await waitFor(() => expect(screen.getByText(/read-only/i)).toBeInTheDocument())

    // Now the user is somewhere else, and this read-only flag is that
    // workspace's, not the pinned one's.
    await act(async () => { repo.setActiveWorkspaceId('ws-elsewhere') })

    await waitFor(() => expect(screen.queryByText(/read-only/i)).toBeNull())
  })
})

/**
 * A refresh does not hold the next context's button hostage.
 *
 * `claimLoad` invalidates the superseded work, but the spinner is shared state
 * — a slow or hung analysis would otherwise leave re-analyze disabled for the
 * Repo that replaced it.
 */
describe('a refresh across a Repo swap', () => {
  beforeEach(freshRepo)
  afterEach(() => { resetPerfAnalysisStore(); resetMonitorRun() })

  // A superseded refresh settling must not clear state that the refresh which
  // REPLACED it now owns — that re-enables the button under a running analysis
  // and lets two overlap.
  it('does not let a superseded refresh clear the one that replaced it', async () => {
    startMonitorRun(mocks.repo, WS)
    let releaseFirst = (): void => {}
    mocks.runNow.mockImplementationOnce(
      () => new Promise<void>((resolve) => { releaseFirst = () => resolve() }))
    const view = render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)
    await waitFor(() => expect(reanalyze()).toBeEnabled())
    await userEvent.click(reanalyze())

    // The swap, then a second refresh that the new Repo owns.
    const replacement = createTestRepo({ db: sharedDb.db, user: USER }).repo
    replacement.setActiveWorkspaceId(WS)
    mocks.repo = replacement
    startMonitorRun(replacement, WS)
    view.rerender(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)
    await waitFor(() => expect(reanalyze()).toBeEnabled())
    mocks.runNow.mockImplementationOnce(() => new Promise<void>(() => {}))
    await userEvent.click(reanalyze())
    await waitFor(() => expect(reanalyze()).toBeDisabled())

    // The FIRST refresh finally settles.
    await act(async () => { releaseFirst() })

    // ...and the second one is still running, so the button stays disabled.
    expect(reanalyze()).toBeDisabled()
  })

  it('re-enables the button for the Repo that replaced it', async () => {
    startMonitorRun(mocks.repo, WS)
    // Never settles: the hung case this exists for.
    mocks.runNow.mockImplementationOnce(() => new Promise<void>(() => {}))
    const view = render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)
    await waitFor(() => expect(reanalyze()).toBeEnabled())
    await userEvent.click(reanalyze())
    await waitFor(() => expect(reanalyze()).toBeDisabled())

    // The swap, with a run for the new Repo.
    const replacement = createTestRepo({ db: sharedDb.db, user: USER }).repo
    replacement.setActiveWorkspaceId(WS)
    mocks.repo = replacement
    startMonitorRun(replacement, WS)
    view.rerender(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)

    await waitFor(() => expect(reanalyze()).toBeEnabled())
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
  beforeEach(freshRepo)

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
      isReadOnly: false,
      onReadOnlyChange: () => () => {},
      onMetricsReset: () => () => {},
      db: { getAll: async () => { throw new Error('gone') } },
    } as unknown as Repo
    view.rerender(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)

    await waitFor(() => expect(screen.queryAllByRole('table')).toHaveLength(0))
  })
})

/**
 * Rows belong to the publication they were read for.
 *
 * The dialog stays open through the scheduled cadence. The interaction recorder
 * rewrites its row as the session goes on and another tab can append, so a
 * newly published verdict beside the rows loaded at open time is a verdict its
 * own tables cannot explain.
 */
describe('rows after a new analysis publishes', () => {
  beforeEach(freshRepo)
  afterEach(() => { resetPerfAnalysisStore(); resetMonitorRun() })

  it('re-reads the history a fresh verdict was computed against', async () => {
    await writeInteractionSample(repo, WS)
    await writeStartupRecord(repo, WS)
    startMonitorRun(repo, WS)
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)
    await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(2))

    // Only the SERIES reads count: `getAll` is called for plenty of other
    // reasons, and asserting on it bare passes with the dependency removed.
    const reads = vi.spyOn(repo.db, 'getAll')
    const seriesReads = () => reads.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && sql.includes('properties_json')).length

    publishPerfAnalysis(analysisFixture({ workspaceId: WS, seq: 99 }))

    await waitFor(() => expect(seriesReads()).toBeGreaterThan(0))
    // ...and the tables come back, rather than staying hidden on a mismatch.
    await waitFor(() => expect(screen.getAllByRole('table')).toHaveLength(2))
  })
})

/**
 * The dialog follows a role change without a new analysis.
 *
 * It reads the recording blocker live, and `repo.isReadOnly` moves on a
 * server-pushed role change with nothing else moving — no publication, so the
 * analysis subscription never fires.
 */
describe('the dialog and a role change', () => {
  beforeEach(freshRepo)

  afterEach(() => { resetPerfAnalysisStore(); resetMonitorRun() })

  it('re-renders the blocker when read-only flips underneath it', async () => {
    // A verdict has to be on screen for the blocker to qualify anything.
    startMonitorRun(repo, WS)
    publishPerfAnalysis(analysisFixture({ workspaceId: WS }))
    render(<PerfTrendDialog resolve={() => {}} cancel={() => {}} workspaceId={WS} />)
    await waitFor(() => expect(reanalyze()).toBeEnabled())
    expect(screen.queryByText(/read-only/i)).toBeNull()

    // The demotion, with nothing published behind it.
    await act(async () => { repo.setReadOnly(true) })

    await waitFor(() => expect(screen.getByText(/read-only/i)).toBeInTheDocument())
  })
})

