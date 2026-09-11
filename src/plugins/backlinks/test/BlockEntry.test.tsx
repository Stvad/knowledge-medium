// @vitest-environment happy-dom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { LazyBlockEntry } from '../BlockEntry.tsx'

/** `parents` is what the stubbed `useResolvedParents` hands back — one
 *  array instance per test, since the hook is called on every render, and
 *  `undefined` for a walk that has not landed, which is the state the
 *  `initialParents` seed exists to cover. */
const mocks = vi.hoisted(() => {
  const state = {
    openBlock: vi.fn(),
    parents: undefined as unknown[] | undefined,
    useResolvedParents: vi.fn(() => state.parents),
    repo: {
      activeWorkspaceId: 'workspace',
      block: vi.fn((id: string) => ({id})),
    },
  }
  return state
})

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => mocks.repo,
}))

vi.mock('@/utils/navigation.ts', () => ({
  useBlockOpener: () => mocks.openBlock,
}))

// Partial: the breadcrumb list below pulls other hooks from this module, so
// only the ancestor fetch is stubbed — it's the thing under test.
vi.mock('@/hooks/block.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/block')>()),
  useResolvedParents: mocks.useResolvedParents,
}))

// Surfaces the ambient block context so tests can assert what the entry
// declares to the blocks it renders, not just what it renders.
vi.mock('@/components/BlockComponent.tsx', async () => {
  const {useBlockContext} = await import('@/context/block')
  return {
    BlockComponent: ({blockId}: {blockId: string}) => {
      const {scopeRootId} = useBlockContext()
      return (
        <span data-testid={`block-${blockId}`} data-scope-root={scopeRootId ?? ''}>
          {blockId}
        </span>
      )
    },
  }
})

vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
}))

afterEach(() => {
  cleanup()
  mocks.openBlock.mockClear()
  mocks.repo.block.mockClear()
  mocks.useResolvedParents.mockClear()
  mocks.parents = undefined
})

describe('BlockEntry breadcrumbs', () => {
  it('routes shift-clicks through the block opener', () => {
    const source = {id: 'source-block'} as Block
    mocks.parents = [{id: 'parent-block'}]

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} scopeId="test:source-block" />
      </BlockContextProvider>,
    )

    const event = createEvent.click(screen.getByTestId('block-parent-block'), {
      button: 0,
      shiftKey: true,
    })
    fireEvent(screen.getByTestId('block-parent-block'), event)

    expect(mocks.openBlock).toHaveBeenCalledOnce()
    const [forwardedEvent, ctx] = mocks.openBlock.mock.calls[0]
    expect(forwardedEvent.shiftKey).toBe(true)
    expect(ctx).toEqual({blockId: 'parent-block', workspaceId: 'workspace'})
  })
})

describe('BlockEntry ancestors', () => {
  it('re-keys its chain on the block it SHOWS, not the one it was given', () => {
    // The entry holds one `core.ancestors` handle, keyed by whatever it is
    // currently showing. Keying it on the block the list handed over would
    // leave a promoted entry wearing the crumbs of the block it unfurled
    // out of — the chain above the promoted parent is a different chain.
    const source = {id: 'source-block'} as Block
    mocks.parents = [{id: 'parent-block'}]

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} scopeId="test:own-chain" />
      </BlockContextProvider>,
    )
    expect(mocks.useResolvedParents).toHaveBeenCalledWith({id: 'source-block'})
    mocks.useResolvedParents.mockClear()

    // A plain primary click on a breadcrumb promotes that segment.
    fireEvent.click(screen.getByTestId('block-parent-block'))

    expect(mocks.useResolvedParents).toHaveBeenCalledWith({id: 'parent-block'})
  })

  it('shows the seed while the walk is pending, then the walk that lands', () => {
    // The seed is what keeps a caller that already holds the chain from
    // painting a breadcrumb-less first frame and then growing a line under
    // the rows below it.
    const source = {id: 'source-block'} as Block
    const seed = [{id: 'seed-parent'}] as Block[]

    const {rerender} = render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} initialParents={seed} scopeId="test:seed" />
      </BlockContextProvider>,
    )
    expect(screen.getByTestId('block-seed-parent')).toBeTruthy()

    mocks.parents = [{id: 'walked-parent'}]
    rerender(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} initialParents={seed} scopeId="test:seed" />
      </BlockContextProvider>,
    )

    // The walk wins the moment it has an answer — the seed is a stand-in,
    // not a second source of truth.
    expect(screen.getByTestId('block-walked-parent')).toBeTruthy()
    expect(screen.queryByTestId('block-seed-parent')).toBeNull()
  })

  it('drops the seed once the user promotes past the block it described', () => {
    // The seed is the chain above the block the caller handed over. A
    // promoted ancestor sits higher up a different one, so reusing it
    // would leave the entry wearing crumbs that are not its own.
    const source = {id: 'source-block'} as Block
    const seed = [{id: 'seed-parent'}] as Block[]

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} initialParents={seed} scopeId="test:seed-promote" />
      </BlockContextProvider>,
    )

    fireEvent.click(screen.getByTestId('block-seed-parent'))

    expect(mocks.useResolvedParents).toHaveBeenCalledWith({id: 'seed-parent'})
    // The promoted block is now the BODY, so its testid is still on screen —
    // assert on the breadcrumb, which is the only thing rendered as a link.
    expect(screen.getByTestId('block-seed-parent').dataset.scopeRoot).toBe('seed-parent')
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('BlockEntry structural-edit scope', () => {
  // The entry's shown block is the root of the only subtree this surface
  // renders, so it must declare itself the scope root. That single
  // override is what makes `resolveStructuralEditPolicy` treat `o` /
  // Enter / Tab here as scope-root gestures — without it the policy sees
  // an ordinary mid-tree block and `o` creates a sibling of the entry,
  // which lives outside the panel: present in the DB, nowhere to render.
  it('declares the shown block as the render-scope root for the blocks it renders', () => {
    const source = {id: 'source-block'} as Block

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} scopeId="test:source-block" />
      </BlockContextProvider>,
    )

    expect(screen.getByTestId('block-source-block').dataset.scopeRoot).toBe('source-block')
  })
})
