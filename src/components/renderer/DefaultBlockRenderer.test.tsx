// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  ChangeScope,
  codecs,
  defineProperty,
} from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { propertySchemasFacet } from '@/data/facets'
import { focusedBlockLocationProp, showPropertiesProp, topLevelBlockIdProp } from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { BlockContextProvider } from '@/context/block'
import { blockLayoutFacet, type BlockLayout } from '@/extensions/blockInteraction'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions'
import { type FacetRuntime } from '@/facets/facet'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import type { Block } from '@/data/block'
import type { BlockRendererProps } from '@/types'
import { pasteMultilineText } from '@/paste/operations'
import { DefaultBlockRenderer } from './DefaultBlockRenderer'

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
}))

const statusProp = defineProperty<string>('test:status', {
  codec: codecs.string,
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
})

const propertyOnlyLayout: BlockLayout = ({Properties, shellProps}) => (
  <div {...shellProps}>
    {Properties && <Properties />}
  </div>
)

const TestContentRenderer = ({block}: BlockRendererProps) => (
  <div>{block.id}</div>
)

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

    await resetTestDb(sharedDb.db)
    h = sharedDb
    const extensions = [
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      defaultEditorInteractionExtension,
      propertySchemasFacet.of(statusProp, {source: 'test'}),
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
})
