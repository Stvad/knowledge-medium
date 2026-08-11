// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { topLevelBlockIdProp } from '@/data/properties'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { BlockContextProvider } from '@/context/block'
import { blockContextMenuItemsFacet } from '@/extensions/blockInteraction'
import type { AppExtension } from '@/facets/facet'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import type { Block } from '@/data/block'
import type { BlockRendererProps } from '@/types'
import { DefaultBlockRenderer } from './DefaultBlockRenderer'

// This suite exercises `blockContextMenuItemsFacet` — the extensibility seam
// on the bullet's context menu. It mirrors the render harness
// `DefaultBlockRenderer.test.tsx` already uses (same repo/UI-state mocks),
// trimmed to just what the bullet's menu needs.

const repoRef = vi.hoisted(() => ({
  current: undefined as Repo | undefined,
}))
const uiStateBlockRef = vi.hoisted(() => ({
  current: undefined as Block | undefined,
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/data/globalState.ts', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState.js')>('@/data/globalState.ts')
  const properties = await vi.importActual<typeof import('@/data/properties')>('@/data/properties')

  const uiStateBlock = () => {
    if (!uiStateBlockRef.current) throw new Error('test UI state block not initialised')
    return uiStateBlockRef.current
  }

  return {
    ...actual,
    useUIStateBlock: uiStateBlock,
    useUIStateProperty: <T,>(schema: import('@/data/api').PropertySchema<T>): [T, (value: T) => void] => {
      const block = uiStateBlock()
      return [
        block.peekProperty(schema) ?? schema.defaultValue,
        (value: T) => { void block.set(schema, value) },
      ]
    },
    useInFocus: (blockId: string): boolean =>
      properties.isFocusedBlock(uiStateBlock(), blockId),
    useInEditMode: (blockId: string): boolean =>
      properties.isFocusedBlock(uiStateBlock(), blockId) &&
      Boolean(uiStateBlock().peekProperty(properties.isEditingProp)),
    useIsSelected: (): boolean => false,
  }
})

const TestContentRenderer = ({block}: BlockRendererProps) => (
  <div>{block.id}</div>
)

// A component contributed as an item's `icon` that throws on render — the
// shape a broken plugin contribution actually takes, since the only render
// surface a `BlockContextMenuItem` hands the plugin is its icon component.
const ThrowingIcon = () => {
  throw new Error('icon boom')
}

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

describe('blockContextMenuItemsFacet', () => {
  let repo: Repo
  let runtime: NonNullable<Repo['facetRuntime']>

  const setup = async (extensions: readonly AppExtension[] = []) => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      newId: () => crypto.randomUUID(),
      extensions,
    }).repo
    runtime = repo.facetRuntime!
    repo.setActiveWorkspaceId('ws-1')
    repoRef.current = repo

    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Root'})
      await tx.create({id: 'block-1', workspaceId: 'ws-1', parentId: 'root', orderKey: 'a0', content: 'Block'})
      await tx.create({
        id: 'ui-state', workspaceId: 'ws-1', parentId: null, orderKey: 'a1',
        properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root')},
      })
    }, {scope: ChangeScope.BlockDefault, description: 'context-menu-items fixture'})
    uiStateBlockRef.current = repo.block('ui-state')
  }

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderBlock = () =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockContextProvider initialValue={{scopeRootId: 'root'}}>
          <ActiveContextsProvider>
            <DefaultBlockRenderer
              block={repo.block('block-1')}
              ContentRenderer={TestContentRenderer}
            />
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

  // `block-1` is a child of the focal `root`, so `ControlsSlot` mounts the
  // bullet (a focal block renders no bullet at all).
  const openBulletContextMenu = async () => {
    renderBlock()
    const bulletLink = document.querySelector<HTMLElement>('.bullet-link')
    expect(bulletLink).toBeTruthy()
    fireEvent.contextMenu(bulletLink!)
    // A core item that's always present anchors the wait — the menu renders
    // through a portal, asynchronously relative to the trigger event.
    await screen.findByText('Copy ID')
  }

  it('renders a contributed item and fires its onSelect', async () => {
    const onSelect = vi.fn()
    await setup([
      blockContextMenuItemsFacet.of(
        () => ({id: 'test.item-a', label: 'Item A', onSelect}),
        {source: 'test'},
      ),
    ])

    await openBulletContextMenu()

    const item = screen.getByRole('menuitem', {name: 'Item A'})
    fireEvent.click(item)

    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('shows contributions from multiple sources together', async () => {
    const onSelectA = vi.fn()
    const onSelectB = vi.fn()
    await setup([
      blockContextMenuItemsFacet.of(
        () => ({id: 'test.item-a', label: 'Item A', onSelect: onSelectA}),
        {source: 'test-plugin-a'},
      ),
      blockContextMenuItemsFacet.of(
        () => [{id: 'test.item-b', label: 'Item B', onSelect: onSelectB}],
        {source: 'test-plugin-b'},
      ),
    ])

    await openBulletContextMenu()

    expect(screen.getByRole('menuitem', {name: 'Item A'})).toBeTruthy()
    expect(screen.getByRole('menuitem', {name: 'Item B'})).toBeTruthy()

    fireEvent.click(screen.getByRole('menuitem', {name: 'Item B'}))
    expect(onSelectB).toHaveBeenCalledTimes(1)
    expect(onSelectA).not.toHaveBeenCalled()
  })

  it('omits the trailing separator when nothing is contributed', async () => {
    await setup([])

    await openBulletContextMenu()

    const showProperties = screen.getByRole('menuitem', {name: 'Show Properties'})
    // Core's last hardcoded item — with no contributions, nothing should
    // follow it in the menu.
    expect(showProperties.nextElementSibling).toBeNull()
  })

  it('adds exactly one separator before the contributed items', async () => {
    await setup([
      blockContextMenuItemsFacet.of(
        () => ({id: 'test.item-a', label: 'Item A', onSelect: vi.fn()}),
        {source: 'test'},
      ),
    ])

    await openBulletContextMenu()

    const showProperties = screen.getByRole('menuitem', {name: 'Show Properties'})
    const separator = showProperties.nextElementSibling
    expect(separator?.getAttribute('role')).toBe('separator')
    expect(separator?.nextElementSibling).toBe(screen.getByRole('menuitem', {name: 'Item A'}))
  })

  it('contains a throwing contribution to its own row without breaking the rest of the menu', async () => {
    const onSelectGood = vi.fn()
    await setup([
      blockContextMenuItemsFacet.of(
        () => ({id: 'test.broken', label: 'Broken Item', icon: ThrowingIcon, onSelect: vi.fn()}),
        {source: 'test-broken'},
      ),
      blockContextMenuItemsFacet.of(
        () => ({id: 'test.good', label: 'Good Item', onSelect: onSelectGood}),
        {source: 'test-good'},
      ),
    ])

    await openBulletContextMenu()

    // The broken row's boundary caught the throw and rendered the fallback
    // in its place, rather than taking out the whole menu.
    expect(screen.getByText(/Something went wrong: icon boom/)).toBeTruthy()

    // The rest of the menu, including the other contribution, still works.
    expect(screen.getByRole('menuitem', {name: 'Copy ID'})).toBeTruthy()
    const goodItem = screen.getByRole('menuitem', {name: 'Good Item'})
    fireEvent.click(goodItem)
    expect(onSelectGood).toHaveBeenCalledTimes(1)
  })
})
