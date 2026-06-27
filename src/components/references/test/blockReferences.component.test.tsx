// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import {
  focusedBlockLocationProp,
  isEditingProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { BlockContextProvider } from '@/context/block'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import {
  blockLayoutFacet,
  blockShellDecoratorsFacet,
  shortcutSurfaceActivationsFacet,
  type BlockShellDecoratorProps,
} from '@/extensions/blockInteraction'
import { referenceLayoutContribution } from '@/components/references/referenceLayout'
import { type FacetRuntime } from '@/facets/facet'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import type { Block } from '@/data/block'
import { BlockRefAncestorsProvider } from '../cycleGuard'
import { BlockRef } from '../BlockRef'
import { BlockEmbed } from '../BlockEmbed'

const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const uiStateBlockRef = vi.hoisted(() => ({current: undefined as Block | undefined}))

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

// Mount lazily-deferred children eagerly so the embedded subtree renders
// synchronously under jsdom (no IntersectionObserver scroll simulation).
vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
}))

// Spies that record which blocks actually ran the interactive shell — the
// shell decorators and the shortcut-surface activations only fire when a layout
// mounts the `Shell` slot, so a read-only reference layout leaves them empty.
const shellDecoratorRuns: string[] = []
const shortcutActivationRuns: string[] = []

const SpyShellDecorator = ({resolveContext, state, children}: BlockShellDecoratorProps) => {
  shellDecoratorRuns.push(resolveContext.block.id)
  return <>{children(state)}</>
}

const extensions = [
  kernelPropertyUiExtension,
  kernelValuePresetsExtension,
  defaultEditorInteractionExtension,
  defaultRenderersExtension,
  plainOutlinerPlugin,
  blockLayoutFacet.of(referenceLayoutContribution, {source: 'references'}),
  blockShellDecoratorsFacet.of(() => SpyShellDecorator, {source: 'test-spy'}),
  shortcutSurfaceActivationsFacet.of((ctx) => {
    shortcutActivationRuns.push(ctx.block.id)
    return null
  }, {source: 'test-spy'}),
]

describe('block reference / embed rendering through the unified pipeline', () => {
  let sharedDb: TestDb
  let repo: Repo
  let runtime: FacetRuntime
  let originalMatchMedia: typeof window.matchMedia

  beforeAll(async () => {
    sharedDb = await createTestDb()
    // jsdom lacks matchMedia; the embed renders the full default layout, whose
    // controls call `useIsMobile()` → `matchMedia`. Stub desktop (no match).
    originalMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  })
  afterAll(async () => {
    window.matchMedia = originalMatchMedia
    await sharedDb.cleanup()
  })

  beforeEach(async () => {
    shellDecoratorRuns.length = 0
    shortcutActivationRuns.length = 0
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
      await tx.create({
        id: 'source', workspaceId: 'ws-1', parentId: null, orderKey: 'a0',
        content: 'Source block',
      })
      await tx.create({
        id: 'target', workspaceId: 'ws-1', parentId: null, orderKey: 'a1',
        content: 'Hello world',
      })
      await tx.create({
        id: 'target-child', workspaceId: 'ws-1', parentId: 'target', orderKey: 'a0',
        content: 'Child content',
      })
      await tx.create({
        id: 'ui-state', workspaceId: 'ws-1', parentId: null, orderKey: 'a2',
        properties: {
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('source'),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create reference fixture'})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderInSource = (node: ReactNode) =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockContextProvider initialValue={{panelId: 'panel', scopeRootId: 'source'}}>
          <ActiveContextsProvider>
            {node}
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

  it('renders the target content through the reference layout, read-only', async () => {
    renderInSource(<BlockRef blockId="target" sourceBlockId="source" occurrenceId="occ-1"/>)

    const content = await screen.findByText('Hello world')

    // Wrapped in the navigating reference link...
    const link = content.closest('a.blockref')
    expect(link).toBeTruthy()
    expect(link?.getAttribute('data-block-id')).toBe('target')

    // ...and NOT in the editable content surface / block shell. The reference
    // layout renders neither the `block-content` div nor the shell props, so
    // no editor, no `data-editing` shell, no focusable tabindex attaches.
    expect(content.closest('.block-content')).toBeNull()
    expect(document.body.querySelector('[data-editing]')).toBeNull()
    expect(document.body.querySelector('textarea, [contenteditable="true"], .cm-editor')).toBeNull()
  })

  it('renders an alias as a link WITHOUT mounting the target', async () => {
    renderInSource(
      <BlockRef blockId="target" sourceBlockId="source" occurrenceId="occ-1">Alias text</BlockRef>,
    )

    const link = await screen.findByText('Alias text')
    expect(link.closest('a.blockref')).toBeTruthy()
    // Target never mounted: its content is absent from the DOM.
    expect(screen.queryByText('Hello world')).toBeNull()
  })

  it('shows the cycle placeholder when the target already appears in the ref chain', async () => {
    renderInSource(
      <BlockRefAncestorsProvider ancestor="target">
        <BlockRef blockId="target" sourceBlockId="source" occurrenceId="occ-1"/>
      </BlockRefAncestorsProvider>,
    )

    await waitFor(() => {
      expect(document.querySelector('.blockref--cycle')).toBeTruthy()
    })
    // The target's content is not rendered when a cycle short-circuits.
    expect(screen.queryByText('Hello world')).toBeNull()
  })

  it('shows the unresolved placeholder for a not-loaded / missing target', async () => {
    renderInSource(<BlockRef blockId="missing-block" sourceBlockId="source" occurrenceId="occ-1"/>)

    await waitFor(() => {
      expect(document.querySelector('.blockref--unresolved')).toBeTruthy()
    })
    expect(screen.getByText(/missing-/)).toBeTruthy()
  })

  it('does NOT become editable when the target block is in edit mode elsewhere', async () => {
    // Put the target into edit mode (focused + editing) as if its home
    // location were being edited on the same page.
    await repo.tx(async tx => {
      await tx.update('ui-state', {
        properties: {
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('source'),
          [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({
            blockId: 'target',
            renderScopeId: outlineRenderScopeId('source'),
          }),
          [isEditingProp.name]: isEditingProp.codec.encode(true),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'put target in edit mode'})

    renderInSource(<BlockRef blockId="target" sourceBlockId="source" occurrenceId="occ-1"/>)

    const content = await screen.findByText('Hello world')
    expect(content.closest('a.blockref')).toBeTruthy()
    // Read content despite edit mode: no editor surface in the reference.
    expect(document.querySelector('textarea, [contenteditable="true"], .cm-editor')).toBeNull()
    expect(document.querySelector('[data-editing="true"]')).toBeNull()
  })

  it('renders an embed as the highlighted box with the full editable subtree', async () => {
    renderInSource(<BlockEmbed blockId="target" sourceBlockId="source" occurrenceId="occ-1"/>)

    // Box chrome present (now contributed by the embed layout).
    const box = await waitFor(() => {
      const el = document.querySelector('.blockembed')
      expect(el).toBeTruthy()
      return el!
    })

    // Root content + children both render inside the box.
    expect(await screen.findByText('Hello world')).toBeTruthy()
    expect(await screen.findByText('Child content')).toBeTruthy()

    // Stays editable: the editable content surface + block shell render
    // (unlike a reference, which renders only raw content).
    expect(box.querySelector('.block-content')).toBeTruthy()
    expect(box.querySelector('[data-block-id="target"][data-editing]')).toBeTruthy()
  })

  it('a reference skips the interactive shell — no shell decorators or shortcut activations run', async () => {
    renderInSource(<BlockRef blockId="target" sourceBlockId="source" occurrenceId="occ-1"/>)
    await screen.findByText('Hello world')

    // The reference layout renders only `RawContent`, never `Shell`, so the
    // upstream interactive machinery is never paid for.
    expect(shellDecoratorRuns).not.toContain('target')
    expect(shortcutActivationRuns).not.toContain('target')
  })

  it('an embed runs the interactive shell (decorators + shortcut activations)', async () => {
    renderInSource(<BlockEmbed blockId="target" sourceBlockId="source" occurrenceId="occ-1"/>)
    await screen.findByText('Hello world')

    // The embed renders the full default layout, which mounts `Shell`.
    await waitFor(() => expect(shellDecoratorRuns).toContain('target'))
    expect(shortcutActivationRuns).toContain('target')
  })
})
