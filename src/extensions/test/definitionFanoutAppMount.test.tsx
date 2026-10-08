// @vitest-environment happy-dom
/**
 * The surface a definition change puts up while it holds the writer.
 *
 * Driven through the STORE rather than by calling the component with props,
 * because the wiring is where this goes wrong. The slot is ONE per tab, not
 * one per workspace — a fan-out holds the database-wide writer, so the
 * workspace the user navigates to is as frozen as the one being changed and
 * the modal has to follow them there. What separates one run's reports from
 * another's is therefore not the workspace but the definition, plus the run's
 * own transaction being the one holding the writer; and a run that ends must
 * take the modal with it.
 */
import { Suspense, type ReactNode } from 'react'
import { vi } from 'vitest'

// The shortcut funnel injects a UI-state block into every activation, so even
// a dependency-free one reaches `useUser`. Mocked rather than provided: the
// subject here is the modal, not who is signed in.
vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1'})}))

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { RepoContext } from '@/context/repo.js'
import { ActiveContextsProvider, useActiveContextsState } from '@/shortcuts/ActiveContexts'
import { ActionContextTypes } from '@/shortcuts/types'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { actionContextsFacet } from '@/extensions/core'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  beginPropertyDefinitionFanout,
  markPropertyDefinitionFanoutRunning,
  reportPropertyDefinitionFanout,
  __resetPropertyDefinitionFanoutForTests,
  type PropertyDefinitionFanoutRun,
} from '@/data/propertyDefinitionFanout'
import { DefinitionFanoutProgress } from '../definitionFanoutAppMount.tsx'

const WS = 'ws-fanout-surface'
const FIELD_ID = 'field-status'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
})

afterEach(() => {
  cleanup()
  __resetPropertyDefinitionFanoutForTests()
})

/** Reads whether the surface underneath is shadowed — what stops a bare Enter
 *  reaching the editor behind a modal. */
const Shadowing = (): ReactNode => {
  const active = useActiveContextsState()
  return <div data-testid="shadowing">{String(active.has(ActionContextTypes.DIALOG))}</div>
}

/** The providers this sits inside in production — it is an app mount, so the
 *  shortcut runtime is always above it. Rendered bare, the modal could lose
 *  its keyboard shadowing with no test noticing. */
const renderMount = (): void => {
  const runtime = resolveFacetRuntimeSync(
    defaultActionContextConfigs.map(context => actionContextsFacet.of(context)),
  )
  render(
    <RepoContext.Provider value={repo}>
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <Suspense fallback={null}>
            <DefinitionFanoutProgress />
            <Shadowing />
          </Suspense>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>
    </RepoContext.Provider>,
  )
}

/** ASYNC act: mounting the dialog suspends on the shortcut funnel's UI-state
 *  read, and the resolution needs a flush the synchronous form does not give. */
const openRun = async (
  workspaceId = WS, total = 4_000, fieldId = FIELD_ID,
): Promise<PropertyDefinitionFanoutRun> => {
  let run!: PropertyDefinitionFanoutRun
  await act(async () => {
    run = beginPropertyDefinitionFanout(workspaceId, fieldId, 'status', total)
  })
  return run
}

const openRunNamed = async (
  propertyName: string, total: number,
): Promise<PropertyDefinitionFanoutRun> => {
  let run!: PropertyDefinitionFanoutRun
  await act(async () => {
    run = beginPropertyDefinitionFanout(WS, 'field-other', propertyName, total)
  })
  return run
}

/** A report is only accepted while the run's own transaction is running, so
 *  every progress test has to say that first — which is the point of it. */
const transactionStarts = (workspaceId = WS, fieldId = FIELD_ID): void => {
  act(() => { markPropertyDefinitionFanoutRunning(workspaceId, fieldId) })
}

const report = (
  done: number, total = 4_000, workspaceId = WS, fieldIds = [FIELD_ID],
): void => {
  act(() => { reportPropertyDefinitionFanout(workspaceId, fieldIds, done, total) })
}

const bar = () => screen.getByRole('progressbar')

describe('the fan-out progress surface', () => {
  it('shows nothing while no change is running', () => {
    renderMount()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('shadowing').textContent).toBe('false')
  })

  it('comes up on the run, follows it, and goes away with it', async () => {
    renderMount()
    const run = await openRun()

    // BEFORE any report: the transaction has not reached the consumers, and
    // the bar says so rather than sitting at a number it does not have.
    expect(await screen.findByText(/Updating blocks that use “status”/)).toBeTruthy()
    expect(screen.getByText('Starting…')).toBeTruthy()
    expect(bar().getAttribute('aria-valuenow')).toBeNull()
    expect(screen.getByText(/leaves the property as it was/)).toBeTruthy()
    await waitFor(() => {
      expect(screen.getByTestId('shadowing').textContent).toBe('true')
    })

    transactionStarts()
    report(1_000)
    expect(screen.getByText('1,000 of 4,000 blocks checked')).toBeTruthy()
    expect(bar().getAttribute('aria-valuenow')).toBe('1000')

    // The last consumer is NOT yet the uninterruptible part: the checks that
    // refuse a change which would lose stored values run after it, and a
    // rollback is not something to tell the user cannot be stopped.
    report(4_000)
    // NEUTRAL, not "saving": the remaining same-tx processors run in this
    // tail and a plugin's can still reject, so the change may yet be rolled
    // back whole and nothing here may claim otherwise.
    expect(screen.getByText('Finishing…')).toBeTruthy()
    expect(screen.getByText(/leaves the property as it was/)).toBeTruthy()

    act(() => { run.end() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.getByTestId('shadowing').textContent).toBe('false')
  })

  it('stays up for a change in a workspace the user has navigated away from', async () => {
    // The fan-out holds the DATABASE-WIDE writer, so the workspace the user
    // switches to is just as frozen as the one being renamed — and a surface
    // filed under the changing workspace would take the only account of that
    // with it.
    renderMount()
    await openRun('ws-somewhere-else')

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/Updating blocks that use “status”/)).toBeTruthy()
  })

  it('ignores a report belonging to another workspace\'s change', async () => {
    // The run is not found BY workspace, so the workspace is what
    // matches a report to it: a fan-out in another workspace must not move
    // this one's numbers under this one's title.
    renderMount()
    await openRun(WS, 4_000)
    expect(await screen.findByRole('dialog')).toBeTruthy()

    transactionStarts()
    report(500, 4_000, 'ws-somewhere-else')

    expect(screen.getByText('Starting…')).toBeTruthy()
  })

  it('ignores a report arriving before its own transaction starts', async () => {
    // Identity cannot separate this case: a headless change to the SAME
    // definition in the same workspace can hold the writer while the user
    // is still at the confirmation. What separates them is that the writer
    // is exclusive — so a report before this run's transaction is running
    // belongs to whatever else holds it.
    renderMount()
    await openRun(WS, 4_000)
    expect(await screen.findByRole('dialog')).toBeTruthy()

    report(500)

    expect(screen.getByText('Starting…')).toBeTruthy()

    // And once it IS running, the same report is this run's.
    transactionStarts()
    report(500)
    expect(screen.getByText('500 of 4,000 blocks checked')).toBeTruthy()
  })

  it('ignores a report from a change to a DIFFERENT definition', async () => {
    // Only the gesture is serialised. A headless caller — the agent CLI, an
    // importer — can take the writer while a confirmation is open, and its
    // counts would otherwise pour into a modal titled for another property,
    // up to declaring it saved before its own transaction had started.
    renderMount()
    await openRun(WS, 4_000)
    expect(await screen.findByRole('dialog')).toBeTruthy()

    transactionStarts()
    report(500, 4_000, WS, ['field-somebody-elses'])

    expect(screen.getByText('Starting…')).toBeTruthy()
  })

  it('keeps the first run when a second opens behind it', async () => {
    // A run opens when the user CONFIRMS, which is before its transaction has
    // the writer — so two confirmed gestures can both be waiting. If the
    // second replaced the first, the first transaction's reports would land
    // on the second property's name and the first `end` would take down a
    // surface the second still needs.
    renderMount()
    const first = await openRun(WS, 4_000)
    expect(await screen.findByRole('dialog')).toBeTruthy()

    const second = await openRunNamed('otherProperty', 9_000)
    transactionStarts()
    report(500)

    expect(screen.getByText(/Updating blocks that use “status”/)).toBeTruthy()
    expect(screen.getByText('500 of 4,000 blocks checked')).toBeTruthy()

    // The loser's `end` owns nothing, so it cannot close the live run either.
    act(() => { second.end() })
    expect(screen.queryByRole('dialog')).not.toBeNull()

    act(() => { first.end() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })
})
