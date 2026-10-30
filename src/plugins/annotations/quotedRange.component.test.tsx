// @vitest-environment happy-dom

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {cleanup, render, waitFor} from '@testing-library/react'
import {ChangeScope} from '@/data/api'
import type {Block} from '@/data/block'
import {PAGE_TYPE} from '@/data/blockTypes'
import {topLevelBlockIdProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {kernelPropertyUiExtension} from '@/components/propertyEditors/typesPropertyUi'
import {kernelValuePresetsExtension} from '@/components/propertyEditors/kernelValuePresets'
import {BlockRef} from '@/components/references/BlockRef'
import {referenceLayoutContribution} from '@/components/references/referenceLayout'
import {BlockContextProvider} from '@/context/block'
import {defaultEditorInteractionExtension} from '@/editor/defaultInteractions'
import {blockLayoutFacet} from '@/extensions/blockInteraction'
import {defaultRenderersExtension} from '@/extensions/defaultRenderers'
import {AppRuntimeContextProvider} from '@/extensions/runtimeContext'
import {plainOutlinerPlugin} from '@/plugins/plain-outliner'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {ActiveContextsProvider} from '@/shortcuts/ActiveContexts'
import {captureAnchor} from './anchor'
import {annotationsPlugin} from './index'
import {createThread} from './threads'

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
    useInFocus: () => false,
    useInEditMode: () => false,
    useIsSelected: () => false,
  }
})

const WS = 'ws'
const B_TEXT = 'As planned, the launch moves to **Thursday**, and the demo moves too.'
const QUOTE = '**Thursday**'
const opts = {scope: ChangeScope.BlockDefault}

describe('a thread root rendered as a reference', () => {
  let db: TestDb
  let repo: Repo
  let threadId: string

  beforeAll(async () => { db = await createTestDb() })
  afterAll(async () => { await db.cleanup() })

  beforeEach(async () => {
    await resetTestDb(db.db)
    repo = createTestRepo({
      db: db.db, user: {id: 'alex'}, newId: () => crypto.randomUUID(),
      extensions: [
        kernelPropertyUiExtension, kernelValuePresetsExtension, defaultEditorInteractionExtension,
        defaultRenderersExtension, plainOutlinerPlugin, referencesDataExtension, annotationsPlugin,
        blockLayoutFacet.of(referenceLayoutContribution, {source: 'references'}),
      ],
    }).repo
    repo.setActiveWorkspaceId(WS)
    repoRef.current = repo
    await repo.tx(async tx => {
      await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'Notes',
        properties: {[typesProp.name]: [PAGE_TYPE]}})
      await tx.create({id: 'B', workspaceId: WS, parentId: 'page', orderKey: 'a0', content: B_TEXT})
      await tx.create({id: 'ui-state', workspaceId: WS, parentId: null, orderKey: 'a1',
        properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('page')}})
    }, opts)
    uiStateBlockRef.current = repo.block('ui-state')
    const from = B_TEXT.indexOf(QUOTE)
    ;({threadId} = await createThread(repo, {targetId: 'B', anchor: captureAnchor(B_TEXT, from, from + QUOTE.length)}))
  })

  afterEach(() => {
    cleanup()
    repoRef.current = undefined
    uiStateBlockRef.current = undefined
  })

  const renderReference = () => render(
    <AppRuntimeContextProvider value={repo.facetRuntime!}>
      <BlockContextProvider initialValue={{panelId: 'panel', scopeRootId: 'page'}}>
        <ActiveContextsProvider>
          <BlockRef blockId={threadId} sourceBlockId="X" occurrenceId="text:0"/>
        </ActiveContextsProvider>
      </BlockContextProvider>
    </AppRuntimeContextProvider>,
  )

  const quoteIn = (container: HTMLElement) => {
    const link = container.querySelector(`a.blockref[data-block-id="${threadId}"]`)
    const quote = link?.querySelector('[data-quote-state]')
    return quote ? {state: quote.getAttribute('data-quote-state'), text: quote.textContent, bold: quote.querySelector('strong')?.textContent} : null
  }

  it('shows the live range, then the stored quote marked once the text is gone', async () => {
    const {container} = renderReference()
    await waitFor(() => expect(quoteIn(container)).toEqual({state: 'exact', text: '“Thursday”', bold: 'Thursday'}))

    await repo.tx(tx => tx.update('B', {content: `Note to self: ${B_TEXT}`}), opts)
    await waitFor(() => expect(quoteIn(container)).toEqual({state: 'moved', text: '“Thursday”', bold: 'Thursday'}))

    await repo.tx(tx => tx.update('B', {content: B_TEXT.replace('Thursday', 'Friday')}), opts)
    await waitFor(() => expect(quoteIn(container)).toEqual({
      state: 'stale', text: '“Thursday”(quoted text changed)', bold: 'Thursday',
    }))
  })

  it('marks the quote when its block is deleted', async () => {
    const {container} = renderReference()
    await waitFor(() => expect(quoteIn(container)?.state).toBe('exact'))

    await repo.mutate.delete({id: 'B'})

    await waitFor(() => expect(quoteIn(container)).toEqual({
      state: 'deleted', text: '“Thursday”(source deleted)', bold: 'Thursday',
    }))
  })

  it('renders no controls inside the link', async () => {
    const {container} = renderReference()
    await waitFor(() => expect(quoteIn(container)?.state).toBe('exact'))
    const link = container.querySelector(`a.blockref[data-block-id="${threadId}"]`)!
    expect(link.querySelectorAll('button, input, textarea, [role="button"]')).toHaveLength(0)
  })
})
