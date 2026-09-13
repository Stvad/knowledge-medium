// @vitest-environment happy-dom
/**
 * `useRetainParents` at the hook seam, over a REAL repo — a fake `Handle`
 * cannot show either property, because both are about the store's
 * ref-counted GC and about which handles a load is started for.
 *
 * The panel repro (`plugins/backlinks/test/linkedReferencesRefresh`)
 * covers what the user sees on collapse; this pins the two halves that
 * make it work without warming rows nobody scrolled to.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { useParents, useRetainParents } from './block.ts'

const WS = 'ws-1'

const state = vi.hoisted(() => ({repo: undefined as unknown}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!state.repo) throw new Error('test repo not initialised')
    return state.repo
  },
}))

let sharedDb: TestDb
let repo: Repo

const create = async (id: string, parentId: string | null = null) => {
  await repo.tx(async tx => {
    await tx.create({
      id, workspaceId: WS, parentId, orderKey: `key-${id}`, content: id,
    })
  }, {scope: ChangeScope.BlockDefault})
}

/** A block nested under its own parent, so it HAS a chain to hold. */
const createNested = async (id: string) => {
  await create(`${id}-parent`)
  await create(id, `${id}-parent`)
}

const ancestorsHandle = (id: string) => repo.query.ancestors({id})

/** Observes `observed`'s chain (so that one handle is warm) while
 *  retaining every id in `retained`. */
const Panel = ({observed, retained}: {observed?: string; retained: string[]}) => {
  useRetainParents(retained.map(id => repo.block(id)))
  return observed ? <Observer id={observed}/> : null
}

const Observer = ({id}: {id: string}) => {
  const parents = useParents(repo.block(id))
  return <span data-testid={`chain-${id}`}>{parents.map(p => p.id).join(',')}</span>
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
  state.repo = repo
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useRetainParents', () => {
  it('starts no ancestor walk for a retained block nothing observes', async () => {
    await createNested('watched')
    await createNested('unwatched')

    const rendered = render(<Panel observed="watched" retained={['watched', 'unwatched']}/>)

    // PRIME the positive case in the same window: one chain is demonstrably
    // resolved through the same mount, so "the other never loaded" cannot
    // be a first-render timing artifact.
    await waitFor(() => {
      expect(rendered.getByTestId('chain-watched').textContent).toBe('watched-parent')
    })

    expect(ancestorsHandle('unwatched').status()).toBe('idle')
    expect(ancestorsHandle('unwatched').peek()).toBeUndefined()
  })

  it('holds an observed chain past the GC window after its observer goes', async () => {
    await createNested('watched')

    const rendered = render(<Panel observed="watched" retained={['watched']}/>)
    await waitFor(() => {
      expect(rendered.getByTestId('chain-watched').textContent).toBe('watched-parent')
    })
    const held = ancestorsHandle('watched')
    const key = held.key

    // Fake timers from here so the release the unmount causes schedules its
    // GC sweep on a clock this test controls.
    vi.useFakeTimers()
    // The collapse: the entry goes, the retaining panel stays.
    rendered.rerender(<Panel retained={['watched']}/>)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

    expect(repo.handleStore.peekHandle(key)).toBe(held)
    expect(held.status()).toBe('ready')
  })
})
