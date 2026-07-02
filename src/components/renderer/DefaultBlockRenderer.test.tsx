// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ChangeScope,
  codecs,
  defineProperty,
} from '@/data/api'
import { useEffect } from 'react'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { propertySchemasFacet } from '@/data/facets'
import { usePropertyValue } from '@/hooks/block'
import { focusedBlockLocationProp, isCollapsedProp, showPropertiesProp, topLevelBlockIdProp } from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { BlockContextProvider } from '@/context/block'
import { blockLayoutFacet, type BlockLayout } from '@/extensions/blockInteraction'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { blockRenderersFacet } from '@/extensions/core'
import type { Block } from '@/data/block'
import type { BlockRendererProps } from '@/types'
import { pasteMultilineText } from '@/paste/operations'
import { useChildIds } from '@/hooks/block'
import { DefaultBlockRenderer } from './DefaultBlockRenderer'
import { FieldBlockRenderer } from './FieldBlockRenderer'
import { PropertyValueBlockRenderer } from './PropertyValueBlockRenderer'

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

vi.mock('@/paste/operations.ts', () => ({
  pasteMultilineText: vi.fn(async () => []),
  pasteFromClipboard: vi.fn(async () => []),
  // The renderer resolves the decision (+ any media capture) through this; for a
  // plain text paste it returns the split decision and the text unchanged.
  resolvePasteWithMediaCapture: vi.fn(async (_runtime: unknown, request: { text: string }) => ({
    decision: { kind: 'split' as const },
    text: request.text,
  })),
}))

const statusProp = defineProperty<string>('test:status', {
  codec: codecs.string,
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
})

const priorityProp = defineProperty<number>('test:priority', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

const propertyOnlyLayout: BlockLayout = ({Properties, Shell}) => (
  <Shell>
    {(shellProps) => (
      <div {...shellProps}>
        {Properties && <Properties />}
      </div>
    )}
  </Shell>
)

const contentOnlyLayout: BlockLayout = ({Content, Shell}) => (
  <Shell>
    {(shellProps) => (
      <div {...shellProps}>
        <Content />
      </div>
    )}
  </Shell>
)

const controlsAndContentLayout: BlockLayout = ({Controls, Content, Shell}) => (
  <Shell>
    {(shellProps) => (
      <div {...shellProps}>
        <Controls />
        <Content />
      </div>
    )}
  </Shell>
)

const TestContentRenderer = ({block}: BlockRendererProps) => (
  <div>{block.id}</div>
)

const ChildIdsProbe = ({
  block,
  includeHiddenPropertyChildren = false,
  testId = 'child-ids',
}: {
  block: Block
  includeHiddenPropertyChildren?: boolean
  testId?: string
}) => {
  const ids = useChildIds(block, {includeHiddenPropertyChildren})
  return <div data-testid={testId}>{ids.join('|')}</div>
}

const dispatchPaste = (target: Element, text: string): Event => {
  const event = new Event('paste', {bubbles: true, cancelable: true})
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
  })
  target.dispatchEvent(event)
  return event
}

describe('DefaultBlockRenderer paste handling', () => {
  let sharedDb: TestDb
  let h: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    vi.mocked(pasteMultilineText).mockClear()
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    })
    Element.prototype.scrollIntoView = vi.fn()

    await resetTestDb(sharedDb.db)
    h = sharedDb
    const extensions = [
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      defaultEditorInteractionExtension,
      propertySchemasFacet.of(statusProp, {source: 'test'}),
      propertySchemasFacet.of(priorityProp, {source: 'test'}),
      blockLayoutFacet.of(
        () => ({id: 'property-only', label: 'Property only', render: propertyOnlyLayout}),
        {source: 'test'},
      ),
    ]
    repo = createTestRepo({
      db: h.db,
      user: {id: 'user-1'},
      newId: () => crypto.randomUUID(),
      extensions,
    }).repo
    runtime = repo.facetRuntime!
    repo.setActiveWorkspaceId('ws-1')
    repoRef.current = repo

    await repo.tx(async tx => {
      await tx.create({
        id: 'root',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a0',
        content: 'Root',
      })
      await tx.create({
        id: 'block-1',
        workspaceId: 'ws-1',
        parentId: 'root',
        orderKey: 'a0',
        content: 'Block',
        properties: {
          [showPropertiesProp.name]: showPropertiesProp.codec.encode(true),
          [statusProp.name]: statusProp.codec.encode('open'),
        },
      })
      await tx.create({
        id: 'ui-state',
        workspaceId: 'ws-1',
        parentId: null,
        orderKey: 'a1',
        properties: {
          [focusedBlockLocationProp.name]: focusedBlockLocationProp.codec.encode({
            blockId: 'block-1',
            renderScopeId: outlineRenderScopeId('root'),
          }),
          [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root'),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create default renderer paste fixture'})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(async () => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderBlock = () =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        {/* The scope root is normally set by the panel/top-level surface
            that mounts the block; provide it here so the paste path
            resolves the same scopeRootId production would. */}
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

  it('leaves paste inside property inputs to the input instead of block paste', () => {
    renderBlock()

    const input = screen.getByDisplayValue('open')
    let event: Event | undefined
    act(() => {
      event = dispatchPaste(input, 'done\nnext')
    })

    expect(event?.defaultPrevented).toBe(false)
    expect(pasteMultilineText).not.toHaveBeenCalled()
  })

  it('still handles paste on the focused block shell', async () => {
    renderBlock()

    const shell = document.querySelector<HTMLElement>('[data-block-id="block-1"][data-editing="false"]')
    expect(shell).toBeTruthy()

    let event: Event | undefined
    act(() => {
      event = dispatchPaste(shell!, 'first\nsecond')
    })

    // preventDefault is synchronous; the apply now runs after the async
    // paste-verb decision, so wait for the call.
    expect(event?.defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(pasteMultilineText).toHaveBeenCalledTimes(1))
    expect(pasteMultilineText).toHaveBeenCalledWith(
      'first\nsecond',
      repo.block('block-1'),
      repo,
      {scopeRootId: 'root', asSingleBlock: false},
    )
  })

  it('applies the default focused-block shell highlight without visual navigation', () => {
    renderBlock()

    const shell = document.querySelector<HTMLElement>('[data-block-id="block-1"][data-editing="false"]')
    expect(shell?.className).toContain('bg-accent/40')
  })

  it('restores DOM focus to a focused normal-mode block shell after remount', async () => {
    const renderTree = (version: number) => (
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <DefaultBlockRenderer
            key={version}
            block={repo.block('block-1')}
            ContentRenderer={TestContentRenderer}
          />
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>
    )

    const view = render(renderTree(1))
    const firstShell = document.querySelector<HTMLElement>('[data-block-id="block-1"][data-editing="false"]')
    await waitFor(() => expect(document.activeElement).toBe(firstShell))

    act(() => {
      view.rerender(renderTree(2))
    })

    const remountedShell = document.querySelector<HTMLElement>('[data-block-id="block-1"][data-editing="false"]')
    expect(remountedShell).not.toBe(firstShell)
    await waitFor(() => expect(document.activeElement).toBe(remountedShell))
  })

  it('keeps hidden-field reveal in the bullet context menu instead of an inline child row', async () => {
    render(
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <DefaultBlockRenderer
            block={repo.block('block-1')}
            ContentRenderer={TestContentRenderer}
            LayoutRenderer={controlsAndContentLayout}
          />
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )

    const bullet = document.querySelector<HTMLElement>('.bullet-link')
    expect(bullet).toBeTruthy()

    fireEvent.contextMenu(bullet!)
    expect(await screen.findByRole('menuitem', {name: 'Show Hidden Fields'})).toBeTruthy()
    expect(screen.queryByRole('button', {name: /Show hidden fields/i})).toBeNull()
  })

  it('hides fields declared hidden by property UI unless the caller opts into all children', async () => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'probe-parent',
        workspaceId: 'ws-1',
        parentId: 'root',
        orderKey: 'b0',
        content: 'Probe parent',
      })
      await tx.create({
        id: 'visible-status-field',
        workspaceId: 'ws-1',
        parentId: 'probe-parent',
        referenceTargetId: statusProp.fieldId,
        orderKey: 'a0',
        content: '[[test:status]]',
      })
      await tx.create({
        id: 'hidden-show-properties-field',
        workspaceId: 'ws-1',
        parentId: 'probe-parent',
        referenceTargetId: showPropertiesProp.fieldId,
        orderKey: 'a1',
        content: '[[show-properties]]',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create field child probe'})

    render(
      <AppRuntimeContextProvider value={runtime}>
        <ChildIdsProbe
          block={repo.block('probe-parent')}
          testId="visible-child-ids"
        />
        <ChildIdsProbe
          block={repo.block('probe-parent')}
          includeHiddenPropertyChildren
          testId="all-child-ids"
        />
      </AppRuntimeContextProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('visible-child-ids').textContent).toBe('visible-status-field')
      expect(screen.getByTestId('all-child-ids').textContent).toBe('visible-status-field|hidden-show-properties-field')
    })
  })

  it('renders property field rows without echoing their definition reference content', async () => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'status-field-display',
        workspaceId: 'ws-1',
        parentId: 'block-1',
        referenceTargetId: statusProp.fieldId,
        orderKey: 'c0',
        content: '[[test:status]]',
      })
      await tx.create({
        id: 'status-value-display',
        workspaceId: 'ws-1',
        parentId: 'status-field-display',
        orderKey: 'a0',
        content: 'open',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create property field renderer fixture'})

    const valueRuntime = resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      defaultEditorInteractionExtension,
      propertySchemasFacet.of(statusProp, {source: 'test'}),
      propertySchemasFacet.of(priorityProp, {source: 'test'}),
      blockRenderersFacet.of({id: 'default', renderer: DefaultBlockRenderer}, {source: 'test'}),
      blockRenderersFacet.of({id: 'field', renderer: FieldBlockRenderer}, {source: 'test'}),
      blockRenderersFacet.of({id: 'propertyValue', renderer: PropertyValueBlockRenderer}, {source: 'test'}),
      blockLayoutFacet.of(
        () => ({id: 'content-only', label: 'Content only', render: contentOnlyLayout}),
        {source: 'test'},
      ),
    ])

    render(
      <AppRuntimeContextProvider value={valueRuntime}>
        <ActiveContextsProvider>
          <FieldBlockRenderer block={repo.block('status-field-display')} />
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )

    const definitionLink = screen.getByRole('link', {name: 'test:status'})
    expect(definitionLink).toHaveAttribute('data-property-definition-link', 'true')
    expect(definitionLink).toHaveAttribute(
      'href',
      expect.stringContaining(statusProp.fieldId),
    )
    expect(screen.queryByText('[[test:status]]')).toBeNull()
    expect(document.querySelector('[data-property-field-table-row="true"]')).toBeTruthy()
    await waitFor(() => expect(screen.getByDisplayValue('open')).toBeTruthy())
  })

  it('renders property value rows through the schema editor and projects edits', async () => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'priority-field',
        workspaceId: 'ws-1',
        parentId: 'block-1',
        referenceTargetId: priorityProp.fieldId,
        orderKey: 'c0',
        content: '[[test:priority]]',
      })
      await tx.create({
        id: 'priority-value',
        workspaceId: 'ws-1',
        parentId: 'priority-field',
        orderKey: 'a0',
        content: '3',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'create property value renderer fixture'})

    expect(PropertyValueBlockRenderer.canRender?.({block: repo.block('priority-value')})).toBe(true)
    expect(PropertyValueBlockRenderer.canRender?.({block: repo.block('priority-field')})).toBe(false)

    const valueRuntime = resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      defaultEditorInteractionExtension,
      propertySchemasFacet.of(statusProp, {source: 'test'}),
      propertySchemasFacet.of(priorityProp, {source: 'test'}),
      blockLayoutFacet.of(
        () => ({id: 'content-only', label: 'Content only', render: contentOnlyLayout}),
        {source: 'test'},
      ),
    ])

    render(
      <AppRuntimeContextProvider value={valueRuntime}>
        <ActiveContextsProvider>
          <PropertyValueBlockRenderer block={repo.block('priority-value')} />
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )

    const input = screen.getByDisplayValue('3')
    expect(input).toHaveAttribute('type', 'number')

    fireEvent.change(input, {target: {value: '5'}})
    fireEvent.blur(input)

    await waitFor(() => {
      expect(repo.cache.getSnapshot('block-1')?.properties[priorityProp.name]).toBe(5)
    })
    await expect(h.db.getOptional<{content: string}>(
      `SELECT content FROM blocks WHERE id = ?`,
      ['priority-value'],
    )).resolves.toEqual({content: '5'})
  })
})

// Counts every mount of the content so a remount (vs a re-render) is visible.
let contentMountCount = 0
const CountingContentRenderer = ({block}: BlockRendererProps) => {
  useEffect(() => {
    contentMountCount += 1
  }, [])
  return <div className="counting-content">{block.id}</div>
}

// A layout that wraps Content in the opt-in Shell and re-renders on a reactive
// prop (isCollapsed) — i.e. the exact shape the default layout has. Toggling the
// prop recreates the layout's `<Shell>` render-prop closure; the content must
// NOT remount as a result (stable-identity invariant).
const ContentShellLayout: BlockLayout = ({Content, Shell, block}) => {
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)
  return (
    <Shell>
      {(shellProps) => (
        <div {...shellProps} data-collapsed={String(isCollapsed)}>
          <Content />
        </div>
      )}
    </Shell>
  )
}

describe('DefaultBlockRenderer slot identity', () => {
  let sharedDb: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    contentMountCount = 0
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      newId: () => crypto.randomUUID(),
      extensions: [
        defaultEditorInteractionExtension,
        blockLayoutFacet.of(
          () => ({id: 'content-shell', label: 'Content + shell', render: ContentShellLayout}),
          {source: 'test'},
        ),
      ],
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
    }, {scope: ChangeScope.BlockDefault, description: 'slot-identity fixture'})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  it('does not remount the content subtree when a collapse toggle re-renders the layout', async () => {
    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockContextProvider initialValue={{scopeRootId: 'root'}}>
          <ActiveContextsProvider>
            <DefaultBlockRenderer block={repo.block('block-1')} ContentRenderer={CountingContentRenderer} />
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

    await screen.findByText('block-1')
    await waitFor(() => expect(contentMountCount).toBe(1))

    // Toggle a prop the layout reads → the layout re-renders and hands Shell a
    // fresh render-prop closure. The content must re-render, not remount.
    await act(async () => {
      await repo.block('block-1').set(isCollapsedProp, true)
    })

    await waitFor(() =>
      expect(document.querySelector('[data-collapsed="true"]')).toBeTruthy(),
    )
    expect(contentMountCount).toBe(1)
  })
})
