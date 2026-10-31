// @vitest-environment happy-dom

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, screen} from '@testing-library/react'
import type {ReactNode} from 'react'
import {ChangeScope} from '@/data/api'
import type {Block} from '@/data/block'
import {PAGE_TYPE} from '@/data/blockTypes'
import {topLevelBlockIdProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {BlockContextProvider} from '@/context/block'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets'
import {DefaultBlockRenderer} from '@/components/renderer/DefaultBlockRenderer'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {defaultRenderersExtension} from '@/extensions/defaultRenderers'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {ActiveContextsProvider} from '@/shortcuts/ActiveContexts'
import {outlineRenderScopeId} from '@/utils/renderScope'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {referencesPlugin} from '@/plugins/references'
import {annotationsPlugin} from './index'
import {readSelectionTarget} from './actions'
import {mapReadSelection, type SelectionEnds} from './readSelection'

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
    useUIStateProperty: <T,>(schema: import('@/data/api').PropertySchema<T>): [T, (value: T) => void] => [
      uiStateBlock().peekProperty(schema) ?? schema.defaultValue,
      (value: T) => { void uiStateBlock().set(schema, value) },
    ],
    useInFocus: (blockId: string): boolean => properties.isFocusedBlock(uiStateBlock(), blockId),
    useInEditMode: (): boolean => false,
    useIsSelected: (): boolean => false,
  }
})

vi.mock('@/components/util/LazyViewportMount.tsx', () => ({
  LazyViewportMount: ({children}: {children: ReactNode}) => <>{children}</>,
}))

const WS = 'ws'
const REFERENCED = '33333333-3333-4333-8333-333333333333'
const RICH = `Some **bold** text, see [[Launch plan]] and ((${REFERENCED})) after https://example.com then end.`
// The referenced block's `ab` sits at the same offsets, 4–6, as the host's.
const SAME_OFFSETS = '44444444-4444-4444-8444-444444444444'
// A block shown inside itself: its copy's `bar` sits at its own `bar`'s offsets.
const SELF = '55555555-5555-4555-8555-555555555555'

describe('a read-mode selection, mapped to raw offsets', () => {
  let db: TestDb
  let repo: Repo

  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.cleanup() })

  beforeEach(async () => {
    await resetTestDb(db.db)
    repo = createTestRepo({
      db: db.db,
      user: {id: 'alex', name: 'Alex'},
      extensions: [
        kernelPropertyUiExtension,
        kernelValuePresetsExtension,
        defaultEditorInteractionExtension,
        defaultRenderersExtension,
        plainOutlinerPlugin,
        referencesPlugin,
        annotationsPlugin,
      ],
    }).repo
    repo.setActiveWorkspaceId(WS)
    repoRef.current = repo
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes',
        properties: {[typesProp.name]: [PAGE_TYPE]}})
      await tx.create({id: 'rich', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: RICH})
      await tx.create({id: 'other', workspaceId: WS, parentId: 'page', orderKey: 'a1', content: 'Another block'})
      await tx.create({id: REFERENCED, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Referenced words'})
      await tx.create({id: 'escaped', workspaceId: WS, parentId: 'page', orderKey: 'a2', content: 'A \\*literal\\* star'})
      await tx.create({id: 'host', workspaceId: WS, parentId: 'page', orderKey: 'a3', content: `See ab ((${SAME_OFFSETS}))`})
      await tx.create({id: SAME_OFFSETS, workspaceId: WS, parentId: null, orderKey: 'a4', content: 'x **ab**'})
      await tx.create({id: SELF, workspaceId: WS, parentId: 'page', orderKey: 'a5', content: `**bar** ((${SELF}))`})
      await tx.create({id: 'list', workspaceId: WS, parentId: 'page', orderKey: 'a6', content: '- first item\n- second item'})
      await tx.create({id: 'trimmed', workspaceId: WS, parentId: 'page', orderKey: 'a7', content: 'first \nsecond line'})
      await tx.create({id: 'footnote', workspaceId: WS, parentId: 'page', orderKey: 'a8', content: 'see[^1]\n\n[^1]: note x'})
      await tx.create({id: 'ui-state', workspaceId: WS, parentId: null, orderKey: 'a2',
        properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('page')}})
    }, {scope: ChangeScope.BlockDefault})
    uiStateBlockRef.current = repo.block('ui-state')
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderBlocks = async (...ids: string[]) => {
    const settled = ids.includes('host') ? 'x' : ids.includes(SELF) ? 'bar' : 'Referenced words'
    render(
      <AppRuntimeContextProvider value={repo.facetRuntime!}>
        <BlockContextProvider initialValue={{panelId: 'panel', scopeRootId: 'page', renderScopeId: outlineRenderScopeId('page')}}>
          <ActiveContextsProvider>
            {ids.map(id => <DefaultBlockRenderer key={id} block={repo.block(id)}/>)}
          </ActiveContextsProvider>
        </BlockContextProvider>
      </AppRuntimeContextProvider>,
    )
    await screen.findAllByText(settled, {exact: false})
  }

  /** The text node holding `text` (its first occurrence, or the `nth`), and
   *  the offset of `text` in it. */
  const at = (text: string, nth = 0, root: ParentNode = document.body): {node: Text; offset: number} => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let seen = 0
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const offset = (node as Text).data.indexOf(text)
      if (offset >= 0 && seen++ === nth) return {node: node as Text, offset}
    }
    throw new Error(`no text node holds ${JSON.stringify(text)}`)
  }

  /** From the start of `from` to the end of `to`. */
  const ends = (from: string, to: string): SelectionEnds => {
    const start = at(from)
    const end = at(to)
    return {anchorNode: start.node, anchorOffset: start.offset, focusNode: end.node, focusOffset: end.offset + to.length}
  }

  const contentOf = (id: string) => repo.block(id).peek()?.content
  const quoteOf = (selection: ReturnType<typeof mapReadSelection>) =>
    selection?.kind === 'range' ? selection.content.slice(selection.from, selection.to) : selection

  it('maps plain text and formatted text to the raw text they render', async () => {
    await renderBlocks('rich')
    expect(mapReadSelection(ends('Some', 'Some'), contentOf)).toMatchObject({
      kind: 'range', blockId: 'rich', renderScopeId: expect.stringContaining('page'), from: 0, to: 4,
    })
    expect(quoteOf(mapReadSelection(ends('old', 'text'), contentOf))).toBe('old** text')
  })

  it('maps a selection made backwards', async () => {
    await renderBlocks('rich')
    const forwards = ends('bold', 'end.')
    const backwards = {
      anchorNode: forwards.focusNode, anchorOffset: forwards.focusOffset,
      focusNode: forwards.anchorNode, focusOffset: forwards.anchorOffset,
    }
    expect(mapReadSelection(backwards, contentOf)).toEqual(mapReadSelection(forwards, contentOf))
  })

  it('maps across a wikilink, a block ref and a bare URL, from the text beside them', async () => {
    await renderBlocks('rich')
    expect(quoteOf(mapReadSelection(ends('see', 'and'), contentOf))).toBe('see [[Launch plan]] and')
    expect(quoteOf(mapReadSelection(ends(' after', 'then'), contentOf)))
      .toBe(` after https://example.com then`)
    expect(quoteOf(mapReadSelection(ends('and', 'then'), contentOf)))
      .toBe(`and ((${REFERENCED})) after https://example.com then`)
  })

  it('refuses an endpoint inside a rendered reference', async () => {
    await renderBlocks('rich')
    expect(mapReadSelection(ends('see', 'Launch'), contentOf)).toEqual({kind: 'inexact'})
    expect(mapReadSelection(ends('Referenced', 'end.'), contentOf)).toEqual({kind: 'inexact'})
  })

  it('maps an end that sits between nodes through the text beside it', async () => {
    await renderBlocks('rich')
    const paragraph = at('Some').node.parentElement!
    const {node, offset} = at('text')
    const between = (child: number) => ({anchorNode: paragraph, anchorOffset: child, focusNode: node, focusOffset: offset + 4})
    expect(quoteOf(mapReadSelection(between(1), contentOf))).toBe('**bold** text')
    expect(quoteOf(mapReadSelection(between(2), contentOf))).toBe(' text')
  })

  it('refuses a selection that holds no text, rather than comment on the whole block', async () => {
    await renderBlocks('rich')
    const {node} = at('Some')
    // From the end of `Some ` to the point just after it: two DOM positions,
    // one raw offset.
    const ends = {anchorNode: node, anchorOffset: node.length, focusNode: node.parentElement!, focusOffset: 1}
    expect(mapReadSelection(ends, contentOf)).toMatchObject({kind: 'range', from: 5, to: 5})
    expect(readSelectionTarget(repo, ends)).toBe('Select some text first.')
  })

  it('refuses an end in text that is not its source', async () => {
    await renderBlocks('escaped', 'rich')
    expect(mapReadSelection(ends('A ', 'literal'), contentOf)).toEqual({kind: 'inexact'})
  })

  it('refuses an end in a referenced block’s text, even where its offsets would fit the host', async () => {
    await renderBlocks('host')
    const start = at('See')
    const end = at('ab', 1)
    expect(end.node.parentElement!.closest('.markdown-content-inline')).not.toBeNull()
    expect(mapReadSelection(
      {anchorNode: start.node, anchorOffset: start.offset, focusNode: end.node, focusOffset: end.offset + 2},
      contentOf,
    )).toEqual({kind: 'inexact'})
  })

  it('refuses a selection across two blocks', async () => {
    await renderBlocks('rich', 'other')
    expect(mapReadSelection(ends('Some', 'Another'), contentOf)).toEqual({kind: 'several'})
  })

  it('refuses an element holding text nodes it did not record', async () => {
    await renderBlocks('rich')
    const {node} = at('Some')
    node.parentElement!.append(document.createTextNode('injected'))
    expect(mapReadSelection(ends('Some', 'Some'), contentOf)).toEqual({kind: 'inexact'})
  })

  it('refuses a render the content has moved past, even where both ends still match', async () => {
    await renderBlocks('rich')
    // Same length, changed between the ends: each end's own text is intact.
    const moved = RICH.replace('**bold**', '**cold**')
    expect(mapReadSelection(ends('Some', 'text'), () => RICH)).toMatchObject({kind: 'range'})
    expect(mapReadSelection(ends('Some', 'text'), () => moved)).toEqual({kind: 'inexact'})
  })

  it('refuses an end in the copy of a block shown inside itself', async () => {
    await renderBlocks(SELF)
    const copy = at('bar', 1)
    expect(copy.node.parentElement!.closest('.markdown-content-inline')).not.toBeNull()
    const start = at('bar')
    expect(mapReadSelection(
      {anchorNode: start.node, anchorOffset: 0, focusNode: copy.node, focusOffset: 2},
      contentOf,
    )).toEqual({kind: 'inexact'})
  })

  it('maps text in a tight list item, whose paragraph the renderer unwraps', async () => {
    await renderBlocks('list', 'rich')
    expect(quoteOf(mapReadSelection(ends('second', 'second item'), contentOf))).toBe('second item')
  })

  it('refuses text changed in the page after it rendered', async () => {
    await renderBlocks('rich')
    at('Some').node.data = 'Sxme '
    expect(mapReadSelection(ends('Sxme', 'Sxme'), contentOf)).toEqual({kind: 'inexact'})
  })

  it('refuses an end in text the renderer extended, a footnote’s last text', async () => {
    await renderBlocks('footnote', 'rich')
    const {node} = at('note x')
    // The footer appends a space to the text node itself, so the counts agree.
    expect(node.data).toBe('note x ')
    expect(mapReadSelection({anchorNode: node, anchorOffset: 0, focusNode: node, focusOffset: 7}, contentOf))
      .toEqual({kind: 'inexact'})
  })

  it('refuses text the parser changed, a space dropped before a line break', async () => {
    await renderBlocks('trimmed', 'rich')
    expect(mapReadSelection(ends('second', 'line'), contentOf)).toEqual({kind: 'inexact'})
  })
})
