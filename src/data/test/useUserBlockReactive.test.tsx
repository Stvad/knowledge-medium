import { Suspense } from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useUserBlock } from '@/data/globalState.ts'
import { buildAppHash } from '@/utils/routing.ts'

// Regression for "the left sidebar doesn't update on workspace switch": the
// sidebar's shortcuts resolve through `useUserBlock()`, which must re-resolve
// the user-page block when the active workspace changes (tracked via the URL
// hash) instead of staying pinned to the previous workspace.

const mocks = vi.hoisted(() => ({
  // Pin deliberately lags the hash — the link/sidebar must follow the hash.
  repo: {activeWorkspaceId: 'ws-1', instanceId: 'inst'},
  user: {id: 'user-1', name: 'Alice'},
}))

vi.mock('@/context/repo.tsx', () => ({useRepo: () => mocks.repo}))
vi.mock('@/components/Login.tsx', () => ({useUser: () => mocks.user}))

// `use()` requires a stable promise per (workspace, user) across renders, so the
// stub memoizes exactly like the real `getUserBlock`. The block id encodes the
// workspace so the test can observe which workspace was resolved.
vi.mock('@/data/stateBlocks.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/data/stateBlocks.ts')>()
  const cache = new Map<string, Promise<{id: string}>>()
  return {
    ...actual,
    getUserBlock: (_repo: unknown, workspaceId: string, user: {id: string}) => {
      const key = `${workspaceId}:${user.id}`
      if (!cache.has(key)) cache.set(key, Promise.resolve({id: `userblock:${key}`}))
      return cache.get(key)!
    },
  }
})

function Probe() {
  const block = useUserBlock()
  return <span data-testid="user-block">{block.id}</span>
}

// `useUserBlock` suspends on the user-block promise, so each render/update is
// wrapped in `await act` to flush the suspense resolution before asserting.
const switchWorkspace = async (workspaceId: string) => {
  await act(async () => {
    window.location.hash = buildAppHash(workspaceId)
    window.dispatchEvent(new Event('hashchange'))
  })
}

describe('useUserBlock', () => {
  beforeEach(() => {
    window.location.hash = buildAppHash('ws-1')
  })
  afterEach(() => {
    window.location.hash = ''
  })

  it('re-resolves the user-page block when the workspace switches', async () => {
    await act(async () => {
      render(
        <Suspense fallback={<span>loading</span>}>
          <Probe/>
        </Suspense>,
      )
    })
    expect(screen.getByTestId('user-block')).toHaveTextContent('userblock:ws-1:user-1')

    await switchWorkspace('ws-2')

    expect(screen.getByTestId('user-block')).toHaveTextContent('userblock:ws-2:user-1')
  })
})
