// @vitest-environment happy-dom
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { LazyBlockEntry } from '../BlockEntry.tsx'

/** `parents` is what the stubbed `useParents` hands back — one array
 *  instance per test, since the hook is called on every render. */
const NO_PARENTS: unknown[] = []

const mocks = vi.hoisted(() => {
  const state = {
    openBlock: vi.fn(),
    bodyMounts: [] as string[],
    parents: [] as unknown[],
    useParents: vi.fn(() => state.parents),
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
  useParents: mocks.useParents,
}))

// Surfaces the ambient block context so tests can assert what the entry
// declares to the blocks it renders, not just what it renders.
vi.mock('@/components/BlockComponent.tsx', async () => {
  const {useBlockContext} = await import('@/context/block')
  const {useEffect} = await import('react')
  return {
    // Records MOUNTS, not renders: the entry keys this on the shown id so
    // a promote gets a fresh instance (and so a fresh ErrorBoundary).
    BlockComponent: ({blockId}: {blockId: string}) => {
      const {scopeRootId, isBreadcrumb} = useBlockContext()
      // Empty deps on purpose: this must record a MOUNT, not an effect
      // re-run. With `blockId` in the deps it fires on a plain prop change
      // too, and then it cannot tell a fresh instance from a reconciled
      // one — which is the whole distinction under test. Breadcrumb
      // segments render one of these as well; only the BODY counts.
      useEffect(() => {
        if (!isBreadcrumb) mocks.bodyMounts.push(blockId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])
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
  mocks.useParents.mockClear()
  mocks.parents = NO_PARENTS
  mocks.bodyMounts.length = 0
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
    expect(mocks.useParents).toHaveBeenCalledWith({id: 'source-block'})
    mocks.useParents.mockClear()

    // A plain primary click on a breadcrumb promotes that segment.
    fireEvent.click(screen.getByTestId('block-parent-block'))

    expect(mocks.useParents).toHaveBeenCalledWith({id: 'parent-block'})
  })

  it('keeps the supplied chain even after its own walk answers', () => {
    // A supplied chain is the caller's answer, not a placeholder: the
    // grouped panel freezes its snapshot while paused, so a walk that
    // overrode it would move the breadcrumb while the grouping it was
    // built from stayed put. It also outranks a STALE cached walk, which
    // `peek()` serves without saying so — `HandleStatus` has no 'stale'.
    const source = {id: 'source-block'} as Block
    const supplied = [{id: 'supplied-parent'}] as Block[]
    mocks.parents = [{id: 'walked-parent'}]

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} initialParents={supplied} scopeId="test:supplied" />
      </BlockContextProvider>,
    )

    expect(screen.getByTestId('block-supplied-parent')).toBeTruthy()
    expect(screen.queryByTestId('block-walked-parent')).toBeNull()
  })

  it('honours a supplied EMPTY chain as "no ancestors", not "no opinion"', () => {
    // The two say different things. Reading `[]` as "nothing supplied"
    // would paint a breadcrumb the caller said does not exist.
    const source = {id: 'source-block'} as Block
    mocks.parents = [{id: 'walked-parent'}]

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} initialParents={[]} scopeId="test:empty-supplied" />
      </BlockContextProvider>,
    )

    expect(screen.queryByRole('link')).toBeNull()
  })

  it('walks for itself when the caller supplied nothing', () => {
    const source = {id: 'source-block'} as Block
    mocks.parents = [{id: 'walked-parent'}]

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} scopeId="test:no-supply" />
      </BlockContextProvider>,
    )

    expect(screen.getByTestId('block-walked-parent')).toBeTruthy()
  })

  it('drops the supplied chain once the user promotes past the block it described', () => {
    // It describes the block the caller handed over. A promoted ancestor
    // sits higher up a different chain the caller never saw, so only the
    // walk can answer for it.
    const source = {id: 'source-block'} as Block
    const supplied = [{id: 'supplied-parent'}] as Block[]

    render(
      <BlockContextProvider initialValue={{panelId: 'panel-a'}}>
        <LazyBlockEntry block={source} initialParents={supplied} scopeId="test:supplied-promote" />
      </BlockContextProvider>,
    )

    fireEvent.click(screen.getByTestId('block-supplied-parent'))

    expect(mocks.useParents).toHaveBeenCalledWith({id: 'supplied-parent'})
    // A fresh body instance, which is what clears `BlockComponent`'s
    // ErrorBoundary — it carries no `resetKeys`, so a source whose
    // renderer threw would otherwise stay on its fallback after the user
    // clicked a breadcrumb out of it.
    expect(mocks.bodyMounts).toEqual(['source-block', 'supplied-parent'])
    // The promoted block is now the BODY, so its testid is still on screen —
    // assert on the breadcrumb, which is the only thing rendered as a link.
    expect(screen.getByTestId('block-supplied-parent').dataset.scopeRoot).toBe('supplied-parent')
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
