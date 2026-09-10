// @vitest-environment happy-dom
/** Both ways into the Recents page — the header button and the global
 *  command — against a real repo whose bootstrap SKIPPED the page.
 *
 *  `ensureSystemPages` reports a failing `ensure` and carries on (#589), so
 *  the page's row is not guaranteed to be there when a consumer wants it.
 *  These pin that each consumer get-or-creates at its point of use, like the
 *  Journal and Locations pages do, rather than navigating to a derived id
 *  with no row behind it (issue #931). The navigation layer itself is a
 *  recording stub — its modifier matrix is navigation.ts's contract. */
import { Suspense } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MouseEvent } from 'react'
import { ChangeScope, type BlockData } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { recentsPageBlockId } from '@/data/recentsPage'
import type { Repo } from '@/data/repo'

const WS = 'ws-recents-open'
/** Measured ~200ms; budgeted for the gate's ~6x p99.9 stretch under load. */
const TIMEOUT_MS = 20_000
const ENSURE_TIMEOUT_MS = 5_000

const repoRef = vi.hoisted(() => ({current: undefined as unknown}))
const openCalls = vi.hoisted(() => ({current: [] as string[]}))
const commandCalls = vi.hoisted(() => ({current: [] as string[]}))

vi.mock('@/context/repo.js', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

// Both navigation entry points stand in for the real ones: they record the
// target and run its `ensure`. The ORDERING — resolve the policy, skip a
// vetoed or retargeted gesture, then materialize — is navigation.ts's, pinned
// there. What is under test HERE is what each consumer hands over: the id, and
// an ensure that materializes the page.
vi.mock('@/utils/navigation.js', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/navigation')>(),
  useBlockOpener: () => (
    event: MouseEvent,
    target: {blockId: string; ensure?: () => Promise<unknown>},
  ) => {
    event.preventDefault()
    void (target.ensure?.() ?? Promise.resolve()).then(() => {
      openCalls.current.push(target.blockId)
    })
  },
  navigateFromGlobalCommand: (
    _repo: unknown,
    input: {blockId: string; ensure?: () => Promise<unknown>},
  ) => (input.ensure?.() ?? Promise.resolve()).then(() => {
    commandCalls.current.push(input.blockId)
    return null
  }),
}))

const { RecentsHeaderItem } = await import('./HeaderItem.tsx')
const { openRecentsAction } = await import('./index.ts')

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

const setup = async (): Promise<Repo> => {
  await resetTestDb(sharedDb.db)
  openCalls.current = []
  commandCalls.current = []
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  repoRef.current = repo
  return repo
}

afterEach(() => {
  cleanup()
  repoRef.current = undefined
})

/** The Recents row as the DB holds it — `null` while the page has never been
 *  created, which is the state `ensureSystemPages` leaves behind when it
 *  skips this page. */
const recentsRow = (repo: Repo): Promise<BlockData | null> =>
  repo.load(recentsPageBlockId(WS))

/** The action's handler ignores its dependencies and event — the command has
 *  no surface to read — so the harness supplies neither. */
const runOpenRecentsCommand = (repo: Repo): unknown =>
  openRecentsAction(repo).handler({} as never, {} as never)

const clickRecents = (): void => {
  render(<Suspense fallback={null}><RecentsHeaderItem/></Suspense>)
  fireEvent.click(screen.getByLabelText('Open recents'))
}

describe('opening Recents when bootstrap skipped the page', () => {
  it('the header button creates the page, then navigates to it', async () => {
    const repo = await setup()
    expect(await recentsRow(repo)).toBeNull()

    clickRecents()

    await vi.waitFor(
      () => { expect(openCalls.current).toEqual([recentsPageBlockId(WS)]) },
      {timeout: ENSURE_TIMEOUT_MS},
    )
    expect((await recentsRow(repo))?.content).toBe('Recents')
  }, TIMEOUT_MS)

  it('the global command creates the page, then navigates to it', async () => {
    const repo = await setup()
    expect(await recentsRow(repo)).toBeNull()

    await runOpenRecentsCommand(repo)

    expect((await recentsRow(repo))?.content).toBe('Recents')
    expect(commandCalls.current).toEqual([recentsPageBlockId(WS)])
  }, TIMEOUT_MS)

  it('creating the page lazily does not discard a pending redo', async () => {
    const repo = await setup()
    const blockId = 'b-edited'
    await repo.tx(
      async tx => {
        await tx.create({id: blockId, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'original'})
      },
      {scope: ChangeScope.BlockDefault, description: 'seed', skipUndo: true},
    )
    await repo.tx(
      async tx => { await tx.update(blockId, {content: 'edited'}) },
      {scope: ChangeScope.BlockDefault, description: 'edit'},
    )
    expect(await repo.undo()).toBe(true)

    // The click that materializes the page runs against a LIVE undo stack, and
    // `UndoManager.record` clears the redo branch on every push — so an
    // unattended create here silently discards a redo the user still wanted.
    await runOpenRecentsCommand(repo)
    expect((await recentsRow(repo))?.content).toBe('Recents')

    expect(await repo.redo()).toBe(true)
    expect((await repo.load(blockId))?.content).toBe('edited')
  }, TIMEOUT_MS)

  it('a second open reuses the page rather than minting a rival', async () => {
    const repo = await setup()
    // Compares the row SET, not a count: the ids name which block appeared
    // late, and whether the newcomer is a rival claiming the alias or a
    // duplicate of the page itself.
    const liveRows = async (): Promise<string[]> => (
      await sharedDb.db.getAll<{ id: string; content: string }>(
        'SELECT id, content FROM blocks WHERE deleted = 0 ORDER BY id',
      )
    ).map(r => `${r.content} (${r.id})`)

    await runOpenRecentsCommand(repo)
    const before = await liveRows()

    await runOpenRecentsCommand(repo)
    clickRecents()
    await vi.waitFor(
      () => { expect(openCalls.current).toHaveLength(1) },
      {timeout: ENSURE_TIMEOUT_MS},
    )

    expect(await liveRows()).toEqual(before)
    expect(before).toEqual([`Recents (${recentsPageBlockId(WS)})`])
  }, TIMEOUT_MS)
})
