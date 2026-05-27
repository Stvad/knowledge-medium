// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ChangeScope,
  codecs,
  defineProperty,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { propertySchemasFacet } from '@/data/facets'
import { focusedBlockLocationProp, showPropertiesProp, topLevelBlockIdProp } from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { blockLayoutFacet, type BlockLayout } from '@/extensions/blockInteraction'
import { defaultEditorInteractionExtension } from '@/extensions/defaultEditorInteractions'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/extensions/facet'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import type { Block } from '@/data/block'
import type { BlockRendererProps } from '@/types'
import { pasteMultilineText } from '@/utils/paste'
import { useChildIds } from '@/hooks/block'
import { DefaultBlockRenderer } from './DefaultBlockRenderer'
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

vi.mock('@/utils/paste.ts', () => ({
  pasteMultilineText: vi.fn(async () => []),
  pasteFromClipboard: vi.fn(async () => []),
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

const propertyOnlyLayout: BlockLayout = ({Properties, shellProps}) => (
  <div {...shellProps}>
    {Properties && <Properties />}
  </div>
)

const contentOnlyLayout: BlockLayout = ({Content, shellProps}) => (
  <div {...shellProps}>
    <Content />
  </div>
)

const TestContentRenderer = ({block}: BlockRendererProps) => (
  <div>{block.id}</div>
)

const ChildIdsProbe = ({block}: {block: Block}) => {
  const ids = useChildIds(block)
  return <div data-testid="child-ids">{ids.join('|')}</div>
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
  let h: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeEach(async () => {
    vi.mocked(pasteMultilineText).mockClear()

    h = await createTestDb()
    let now = 1700_000_000_000
    let txSeq = 0
    repo = new Repo({
      db: h.db,
      cache: new BlockCache(),
      user: {id: 'user-1'},
      now: () => ++now,
      newId: () => crypto.randomUUID(),
      newTxSeq: () => ++txSeq,
      startRowEventsTail: false,
    })
    runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      defaultEditorInteractionExtension,
      propertySchemasFacet.of(statusProp, {source: 'test'}),
      propertySchemasFacet.of(priorityProp, {source: 'test'}),
      blockLayoutFacet.of(
        () => ({id: 'property-only', label: 'Property only', render: propertyOnlyLayout}),
        {source: 'test'},
      ),
    ])
    repo.setFacetRuntime(runtime)
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
    await h.cleanup()
  })

  const renderBlock = () =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <ActiveContextsProvider>
          <DefaultBlockRenderer
            block={repo.block('block-1')}
            ContentRenderer={TestContentRenderer}
          />
        </ActiveContextsProvider>
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

  it('still handles paste on the focused block shell', () => {
    renderBlock()

    const shell = document.querySelector<HTMLElement>('[data-block-id="block-1"][data-editing="false"]')
    expect(shell).toBeTruthy()

    let event: Event | undefined
    act(() => {
      event = dispatchPaste(shell!, 'first\nsecond')
    })

    expect(event?.defaultPrevented).toBe(true)
    expect(pasteMultilineText).toHaveBeenCalledTimes(1)
    expect(pasteMultilineText).toHaveBeenCalledWith(
      'first\nsecond',
      repo.block('block-1'),
      repo,
      {topLevelBlockId: 'root'},
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

  it('treats visible fields as children while hiding internal fields from the outline', async () => {
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
        <ChildIdsProbe block={repo.block('probe-parent')} />
      </AppRuntimeContextProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('child-ids').textContent).toBe('visible-status-field')
    })
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

    await waitFor(() => {
      expect(repo.cache.getSnapshot('block-1')?.properties[priorityProp.name]).toBe(5)
    })
    await expect(h.db.getOptional<{content: string}>(
      `SELECT content FROM blocks WHERE id = ?`,
      ['priority-value'],
    )).resolves.toEqual({content: '5'})
  })
})
