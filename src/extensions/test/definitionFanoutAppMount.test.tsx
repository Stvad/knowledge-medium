// @vitest-environment happy-dom
/**
 * The surface a definition change puts up while it holds the writer.
 *
 * Driven through the STORE rather than by calling the component with props:
 * the mount reads a module store keyed by the active workspace, and the two
 * ways this fails in production are both about that wiring — a run opened for
 * one workspace showing over another, and a run that ends leaving the modal
 * behind.
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
    await waitFor(() => {
      expect(screen.getByTestId('shadowing').textContent).toBe('true')
    })

    report(1_000)
    expect(screen.getByText('1,000 of 4,000 blocks updated')).toBeTruthy()
    expect(bar().getAttribute('aria-valuenow')).toBe('1000')

    // The last consumer is NOT the end of the wait — the commit and the
    // post-commit walk are still to come — so the surface stays up and stops
    // counting rather than reading as finished.
    report(4_000)
    expect(screen.getByText('Saving the change…')).toBeTruthy()

    act(() => { run.end() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(screen.getByTestId('shadowing').textContent).toBe('false')
  })

  it('stays up for a change in a workspace the user has navigated away from', async () => {
    // The fan-out holds the DATABASE-WIDE writer, so the workspace the user
    // switches to is just as frozen as the one being renamed. A surface filed
    // under the changing workspace would take the only account of that with
    // it, which is what keying this store per workspace used to do.
    renderMount()
    await openRun('ws-somewhere-else')

    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/Updating blocks that use “status”/)).toBeTruthy()
  })

  it('ignores a report belonging to another workspace\'s change', async () => {
    // The run is found without the workspace now, so the workspace is what
    // matches a report to it: a fan-out in another workspace must not move
    // this one's numbers under this one's title.
    renderMount()
    await openRun(WS, 4_000)
    expect(await screen.findByRole('dialog')).toBeTruthy()

    report(500, 4_000, 'ws-somewhere-else')

    expect(screen.getByText('Starting…')).toBeTruthy()
  })

  it('ignores a report from a change to a DIFFERENT definition', async () => {
    // Only the gesture is serialised. A headless caller — the agent CLI, an
    // importer — can take the writer while a confirmation is open, and its
    // counts would otherwise pour into a modal titled for another property,
    // up to declaring it saved before its own transaction had started.
    renderMount()
    await openRun(WS, 4_000)
    expect(await screen.findByRole('dialog')).toBeTruthy()

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
    report(500)

    expect(screen.getByText(/Updating blocks that use “status”/)).toBeTruthy()
    expect(screen.getByText('500 of 4,000 blocks updated')).toBeTruthy()

    // The loser's `end` owns nothing, so it cannot close the live run either.
    act(() => { second.end() })
    expect(screen.queryByRole('dialog')).not.toBeNull()

    act(() => { first.end() })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })
})
