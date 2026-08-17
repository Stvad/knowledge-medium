// @vitest-environment happy-dom

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  ChangeScope,
  codecs,
  defineProperty,
  seedType,
} from '@/data/api'
import { useEffect } from 'react'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { typeSeedsFacet } from '@/data/facets'
import { usePropertyValue } from '@/hooks/block'
import { aliasPageBulletContribution, aliasPageStylingContribution } from '@/plugins/alias/pageStyling'
import { aliasDataExtension } from '@/plugins/alias/dataExtension'
import { aliasesProp, focusedBlockLocationProp, isCollapsedProp, showPropertiesProp, topLevelBlockIdProp } from '@/data/properties'
import { outlineRenderScopeId } from '@/utils/renderScope'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { BlockContextProvider } from '@/context/block'
import { blockContentRendererFacet, blockLayoutFacet, type BlockLayout } from '@/extensions/blockInteraction'
import { defineVariant } from '@/facets/variantFacet'
import { defaultEditorInteractionExtension } from '@/editor/defaultInteractions'
import { type FacetRuntime } from '@/facets/facet'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import type { Block } from '@/data/block'
import type { BlockRendererProps } from '@/types'
import { pasteMultilineText } from '@/paste/operations'
import { DefaultBlockRenderer } from './DefaultBlockRenderer'
import { MarkdownContentRenderer } from './MarkdownContentRenderer'
import { BLOCK_TITLE_TEXT_CLASS } from './blockTitleText'

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

const propertyOnlyLayout: BlockLayout = ({Properties, Shell}) => (
  <Shell>
    {(shellProps) => (
      <div {...shellProps}>
        {Properties && <Properties />}
      </div>
    )}
  </Shell>
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

// ONE database for the whole file (AGENTS.md: share one DB per test file).
// The three describes below differ only in the extensions their repo is built
// with, not in storage, so they reset this handle rather than each standing up
// their own PowerSync instance — three per worker is exactly the kind of setup
// cost that turns into timeout flakes under full-gate parallelism.
let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

describe('DefaultBlockRenderer paste handling', () => {
  let h: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeEach(async () => {
    vi.mocked(pasteMultilineText).mockClear()

    await resetTestDb(sharedDb.db)
    h = sharedDb
    const extensions = [
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      defaultEditorInteractionExtension,
      typeSeedsFacet.of(
        seedType({seedKey: 'test/type/test-status-prop', revision: 1, id: 'test:status-prop', label: 'Test Status Prop', properties: [statusProp]}),
        {source: 'test'},
      ),
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
  let repo: Repo
  let runtime: FacetRuntime

  beforeEach(async () => {
    contentMountCount = 0
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      newId: () => crypto.randomUUID(),
      extensions: [
        defaultEditorInteractionExtension,
        // The real alias sync processor: a content edit on an aliased block
        // rewrites its `alias` property in the SAME tx, which is what makes
        // the page case below a live-data scenario and not a synthetic one.
        aliasDataExtension,
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
        id: 'page-1',
        workspaceId: 'ws-1',
        parentId: 'root',
        orderKey: 'a1',
        content: 'Page',
        properties: {[aliasesProp.name]: aliasesProp.codec.encode(['Page'])},
      })
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

  // A page's title edit rewrites its own `alias` in the same tx (alias.sync),
  // so `aliases` — which the resolve context carries for the alias plugin's
  // page styling — changes on EVERY debounced keystroke commit. If that churns
  // the content slot's identity, the editor is torn down and rebuilt mid-typing:
  // the caret jumps, an open autocomplete dies, and characters typed since the
  // commit are lost to the remount's `initialContent` snapshot.
  it('does not remount the content subtree when a title edit rewrites the block alias', async () => {
    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockContextProvider initialValue={{scopeRootId: 'root'}}>
          <ActiveContextsProvider>
            <DefaultBlockRenderer block={repo.block('page-1')} ContentRenderer={CountingContentRenderer} />
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

    await screen.findByText('page-1')
    await waitFor(() => expect(contentMountCount).toBe(1))

    await act(async () => {
      await repo.block('page-1').setContent('Page renamed')
    })

    // Precondition: the edit really did move the alias — otherwise this test
    // would pass without ever reaching the case it is about.
    await waitFor(() =>
      expect(repo.block('page-1').peekProperty(aliasesProp)).toEqual(['Page renamed']),
    )
    expect(contentMountCount).toBe(1)
  })
})

describe('page styling via the alias plugin contribution', () => {
  let repo: Repo
  let runtime: FacetRuntime

  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    // The alias plugin's contribution is registered explicitly: the styling is
    // ITS decision, so this asserts the whole seam (core reads `aliases`
    // reactively → plugin returns a class → the text renderer applies it),
    // not a class the renderer hardcodes.
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      newId: () => crypto.randomUUID(),
      extensions: [
        defaultEditorInteractionExtension,
        aliasPageStylingContribution,
        aliasPageBulletContribution,
      ],
    }).repo
    runtime = repo.facetRuntime!
    repo.setActiveWorkspaceId('ws-1')
    repoRef.current = repo

    await repo.tx(async tx => {
      await tx.create({
        id: 'page', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Inbox',
        properties: {[aliasesProp.name]: aliasesProp.codec.encode(['Inbox'])},
      })
      await tx.create({
        id: 'plain', workspaceId: 'ws-1', parentId: null, orderKey: 'a1', content: 'just a bullet',
      })
      await tx.create({
        id: 'ui-state', workspaceId: 'ws-1', parentId: null, orderKey: 'a2',
        properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('page')},
      })
    }, {scope: ChangeScope.BlockDefault, description: 'page styling fixture'})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  // No ContentRenderer override — the real markdown renderer is what applies
  // text classes, so a stub would make every assertion below vacuous.
  const renderBlock = (blockId: string) =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockContextProvider initialValue={{scopeRootId: blockId}}>
          <ActiveContextsProvider>
            <DefaultBlockRenderer block={repo.block(blockId)} />
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

  const textClasses = async (text: string): Promise<string> => {
    const node = await screen.findByText(text)
    // The class lands on the text container the renderer builds, which is the
    // node holding the text or its parent depending on the markdown wrapper.
    const carrier = node.closest('.page-name-text, .block-title-text')
    return carrier?.className ?? node.className
  }

  it('leaves the open page\'s title as a plain focal heading', async () => {
    renderBlock('page')

    const classes = await textClasses('Inbox')
    // The positive half is the non-vacuity fence: this asserts the title text
    // IS being classed (so the carrier lookup and the render both worked) and
    // that the page treatment is what's absent, not the whole mechanism.
    expect(classes).toContain(BLOCK_TITLE_TEXT_CLASS)
    expect(classes).not.toContain('page-name-text')
  })

  it('marks a named page seen in the hierarchy, not only when it is open', async () => {
    // 'page' is not the focal block here, so it renders as an ordinary row —
    // the case where page-ness was previously invisible. It gets the
    // weight-only marker, NOT the heading: it is one row among siblings.
    await act(async () => {
      await repo.block('ui-state').set(topLevelBlockIdProp, 'plain')
    })

    renderBlock('page')

    const classes = await textClasses('Inbox')
    expect(classes).toContain('page-name-text')
    expect(classes).not.toContain(BLOCK_TITLE_TEXT_CLASS)
  })

  it('leaves a plain block alone wherever it appears', async () => {
    await act(async () => {
      await repo.block('ui-state').set(topLevelBlockIdProp, 'page')
    })

    renderBlock('plain')

    const classes = await textClasses('just a bullet')
    expect(classes).not.toContain('page-name-text')
  })

  const bulletClasses = async (text: string): Promise<string> => {
    // Fence on the row's own text first: the bullet is a sibling of the
    // content, so querying it before the block has rendered would find
    // nothing and make an "absent" assertion pass vacuously.
    await screen.findByText(text)
    const bullet = document.querySelector('.bullet')
    expect(bullet).toBeTruthy()
    return bullet!.className
  }

  it('rings the bullet of a page in the hierarchy', async () => {
    await act(async () => {
      await repo.block('ui-state').set(topLevelBlockIdProp, 'plain')
    })

    renderBlock('page')

    expect(await bulletClasses('Inbox')).toContain('page-bullet')
  })

  it('leaves an ordinary block\'s bullet a plain dot', async () => {
    await act(async () => {
      await repo.block('ui-state').set(topLevelBlockIdProp, 'page')
    })

    renderBlock('plain')

    const classes = await bulletClasses('just a bullet')
    // Positive half: the bullet IS being classed, so what's absent is the page
    // mark rather than the whole mechanism.
    expect(classes).toContain('bullet')
    expect(classes).not.toContain('page-bullet')
  })

  it('re-marks the bullet in place when a block loses its alias', async () => {
    // Same reactivity contract as the text classes: `aliases` is read at the
    // bullet via the hook, so un-naming a block un-rings it without a remount.
    await act(async () => {
      await repo.block('ui-state').set(topLevelBlockIdProp, 'plain')
    })

    renderBlock('page')
    expect(await bulletClasses('Inbox')).toContain('page-bullet')

    await act(async () => {
      await repo.block('page').set(aliasesProp, [])
    })

    await vi.waitFor(async () =>
      expect(await bulletClasses('Inbox')).not.toContain('page-bullet'))
  })

  it('restyles in place when a block gains an alias', async () => {
    // `aliases` is read reactively in `useBlockTitleTextClass` precisely so
    // this works: a contribution resolved from frozen data would keep the
    // pre-rename styling until something unrelated invalidated it.
    await act(async () => {
      await repo.block('ui-state').set(topLevelBlockIdProp, 'plain')
    })

    renderBlock('page')
    expect(await textClasses('Inbox')).toContain('page-name-text')

    await act(async () => {
      await repo.block('page').set(aliasesProp, [])
    })

    await vi.waitFor(async () =>
      expect(await textClasses('Inbox')).not.toContain('page-name-text'))
  })
})

// A plugin surface that wins the content-renderer FACET rather than being
// passed as a prop — the shape a real content-renderer contribution takes.
// Gated on block id so one fixture serves both the facet and non-facet cases.
const FacetSurfaceRenderer = ({block}: BlockRendererProps) => (
  <div className="facet-surface">{block.id}</div>
)

// The recents-page shape: a custom content renderer that draws the real page
// title AND a surface below it (`RecentsPageBlockRenderer`).
const TitlePlusSurfaceRenderer = (props: BlockRendererProps) => (
  <div>
    <MarkdownContentRenderer {...props} />
    <div className="composed-surface">surface</div>
  </div>
)

describe('title typography', () => {
  let sharedDb: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
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
        blockContentRendererFacet.of(
          ctx => ctx.block.id === 'surface-root'
            ? defineVariant('test.surface', 'Surface', FacetSurfaceRenderer)
            : null,
          {source: 'test'},
        ),
      ],
    }).repo
    runtime = repo.facetRuntime!
    repo.setActiveWorkspaceId('ws-1')
    repoRef.current = repo

    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Page title'})
      await tx.create({id: 'block-1', workspaceId: 'ws-1', parentId: 'root', orderKey: 'a0', content: 'Body text'})
      await tx.create({id: 'surface-root', workspaceId: 'ws-1', parentId: null, orderKey: 'a2', content: 'Surface page'})
      await tx.create({
        id: 'ui-state', workspaceId: 'ws-1', parentId: null, orderKey: 'a1',
        properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root')},
      })
    }, {scope: ChangeScope.BlockDefault, description: 'title typography fixture'})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderBlock = (id: string, ContentRenderer?: typeof FacetSurfaceRenderer) =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockContextProvider initialValue={{scopeRootId: id}}>
          <ActiveContextsProvider>
            <DefaultBlockRenderer block={repo.block(id)} ContentRenderer={ContentRenderer} />
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

  const titleElement = () => document.querySelector(`.${BLOCK_TITLE_TEXT_CLASS}`)

  it('is carried by the focal block\'s own text', async () => {
    renderBlock('root')

    await screen.findByText('Page title')
    expect(titleElement()?.textContent).toBe('Page title')
  })

  it('is not carried by a non-focal block\'s text', async () => {
    renderBlock('block-1')

    // The positive is proven first, so the absence below can't be the text
    // simply not having rendered yet.
    await screen.findByText('Body text')
    expect(titleElement()).toBeNull()
  })

  it('does not reach a surface supplied as the ContentRenderer prop', async () => {
    // The Readwise-backlog bug: the slot's 1.5rem/600 was inherited by every
    // embedded block body, which sets no size of its own. 24px/600 where the
    // same block reads 16px/400 anywhere else.
    renderBlock('root', CountingContentRenderer)

    await waitFor(() => expect(document.querySelector('.counting-content')).not.toBeNull())
    expect(titleElement()).toBeNull()
  })

  it('does not reach a surface supplied through the content-renderer facet', async () => {
    // The facet is the other half of the same door, and the one a heuristic on
    // the prop cannot see: the caller passes nothing, the facet decides.
    await repo.block('ui-state').set(topLevelBlockIdProp, 'surface-root')
    renderBlock('surface-root')

    await waitFor(() => expect(document.querySelector('.facet-surface')).not.toBeNull())
    expect(titleElement()).toBeNull()
  })

  it('still reaches a surface that composes the text renderer', async () => {
    // The recents page renders the real page title above its list. Nothing is
    // declared for this to work — the title styling arrives with the title.
    renderBlock('root', TitlePlusSurfaceRenderer)

    await screen.findByText('Page title')
    const title = titleElement()
    expect(title?.textContent).toBe('Page title')
    // …and stops there: the list beside it is body text.
    expect(title?.contains(document.querySelector('.composed-surface'))).toBe(false)
  })
})

/** A layout that mounts `Shell` and then ignores its props — the mistake the
 *  dev-time check exists to make loud. */
const DroppedShellLayout: BlockLayout = ({Content, Shell}) => (
  <Shell>{() => <div className="dropped-shell"><Content /></div>}</Shell>
)

// Whether a content slot holds a VIEW (a review backlog, a deck, a recents
// list) or the block's own text. Only the slot can answer — it resolved the
// renderer — and callers reasoning about a row's geometry read the answer off
// the DOM instead of inferring it from what happens to be mounted inside.
describe('content-view marking', () => {
  let sharedDb: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      newId: () => crypto.randomUUID(),
      extensions: [
        defaultEditorInteractionExtension,
        blockContentRendererFacet.of(
          ctx => ctx.block.id === 'surface-root'
            ? defineVariant('test.surface', 'Surface', FacetSurfaceRenderer)
            : null,
          {source: 'test'},
        ),
      ],
    }).repo
    runtime = repo.facetRuntime!
    repo.setActiveWorkspaceId('ws-1')
    repoRef.current = repo

    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Page title'})
      await tx.create({id: 'surface-root', workspaceId: 'ws-1', parentId: null, orderKey: 'a2', content: 'Surface page'})
      await tx.create({
        id: 'ui-state', workspaceId: 'ws-1', parentId: null, orderKey: 'a1',
        properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('root')},
      })
    }, {scope: ChangeScope.BlockDefault, description: 'content-view fixture'})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderBlock = (id: string, ContentRenderer?: typeof FacetSurfaceRenderer) =>
    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockContextProvider initialValue={{scopeRootId: id}}>
          <ActiveContextsProvider>
            <DefaultBlockRenderer block={repo.block(id)} ContentRenderer={ContentRenderer} />
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

  const marked = () => document.querySelector('.block-content')?.hasAttribute('data-block-content-view')

  it('marks the shell element as the block boundary', async () => {
    // The outer half of the pair. It travels with `shellProps` rather than the
    // default layout's class so a layout styling its own wrapper still
    // declares it — which is exactly what the SRS review card does.
    renderBlock('root')

    await screen.findByText('Page title')
    const shell = document.querySelector('[data-block-shell]')
    expect(shell?.getAttribute('data-block-id')).toBe('root')
  })

  it('marks a slot whose renderer came as the ContentRenderer prop', async () => {
    renderBlock('root', FacetSurfaceRenderer)

    await waitFor(() => expect(document.querySelector('.facet-surface')).not.toBeNull())
    expect(marked()).toBe(true)
  })

  it('marks a slot whose renderer won the facet', async () => {
    // The half a check on the prop cannot see: the caller passes nothing.
    renderBlock('surface-root')

    await waitFor(() => expect(document.querySelector('.facet-surface')).not.toBeNull())
    expect(marked()).toBe(true)
  })

  it('leaves an ordinary block showing its own text unmarked', async () => {
    renderBlock('root')

    // Proven present before asserting the attribute is absent, so this cannot
    // pass on a slot that simply had not rendered yet.
    await screen.findByText('Page title')
    expect(marked()).toBe(false)
  })

  it('leaves a surface that composes the text renderer marked', async () => {
    // The recents shape: a real title above a list of other blocks' rows. It
    // is still a view — its row spans the list, which is what geometry callers
    // are asking about — even though a title renders through it.
    renderBlock('root', TitlePlusSurfaceRenderer)

    await screen.findByText('Page title')
    expect(marked()).toBe(true)
  })
})

describe('a layout that drops shellProps', () => {
  let sharedDb: TestDb
  let repo: Repo
  let runtime: FacetRuntime

  beforeAll(async () => { sharedDb = await createTestDb() })
  afterAll(async () => { await sharedDb.cleanup() })
  beforeEach(async () => {
    await resetTestDb(sharedDb.db)
    repo = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      newId: () => crypto.randomUUID(),
      extensions: [
        defaultEditorInteractionExtension,
        blockLayoutFacet.of(
          () => ({id: 'dropped', label: 'Dropped shell', render: DroppedShellLayout}),
          {source: 'test'},
        ),
      ],
    }).repo
    runtime = repo.facetRuntime!
    repo.setActiveWorkspaceId('ws-1')
    repoRef.current = repo
    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: 'ws-1', parentId: null, orderKey: 'a0', content: 'Page title'})
      await tx.create({id: 'ui-state', workspaceId: 'ws-1', parentId: null, orderKey: 'a1'})
    }, {scope: ChangeScope.BlockDefault, description: 'dropped shell fixture'})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  // Silent is the failure mode worth pinning: the block simply has no identity
  // in the DOM, and every consumer resolves to an ancestor instead. Nothing
  // threw when the SRS review card did this.
  it('is reported, rather than silently losing the block\'s identity', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(
      <AppRuntimeContextProvider value={runtime}>
        <BlockContextProvider initialValue={{scopeRootId: 'root'}}>
          <ActiveContextsProvider>
            <DefaultBlockRenderer block={repo.block('root')} />
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )

    await waitFor(() => expect(document.querySelector('.dropped-shell')).not.toBeNull())
    expect(document.querySelector('[data-block-shell]')).toBeNull()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('did not spread shellProps'))
    error.mockRestore()
  })
})
