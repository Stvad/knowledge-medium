// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { parseKeybinding } from 'tinykeys'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { focusBlock, peekFocusedBlockLocation, selectionStateProp } from '@/data/properties'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { actionContextsFacet, actionsFacet } from '@/extensions/core'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { ActiveContextsProvider, useActiveContextsDispatch, useActiveContextsState } from '@/shortcuts/ActiveContexts'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import { ActionContextTypes, type BlockShortcutDependencies } from '@/shortcuts/types'
import { disarmCut, getArmedCut } from '@/paste/armedCut'
import { getVimNormalModeActions } from '../actions'

const WS = 'ws-1'
let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
  disarmCut()
})
afterEach(() => {
  cleanup()
  disarmCut()
  vi.unstubAllGlobals()
})

const NormalMode = ({deps, onReady}: {deps: BlockShortcutDependencies; onReady: (blockId: string) => void}) => {
  const dispatch = useActiveContextsDispatch()
  const active = useActiveContextsState()
  useEffect(() => {
    dispatch.activate(ActionContextTypes.NORMAL_MODE, deps)
    return () => dispatch.deactivate(ActionContextTypes.NORMAL_MODE)
  }, [dispatch, deps])
  useEffect(() => {
    if (active.get(ActionContextTypes.NORMAL_MODE) === deps) onReady(deps.block.id)
  }, [active, deps, onReady])
  return null
}

it('the platform cut shortcut then p moves the focused subtree without selecting it', async () => {
  await repo.tx(async tx => {
    await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'ui', workspaceId: WS, parentId: null, orderKey: 'z0'})
  }, {scope: ChangeScope.BlockDefault})
  await repo.mutate.createChild({parentId: 'root', id: 'source', content: 'source'})
  await repo.mutate.createChild({parentId: 'source', id: 'child', content: 'child'})
  await repo.mutate.createChild({parentId: 'root', id: 'next', content: 'next'})
  const uiStateBlock = repo.block('ui')
  await focusBlock(uiStateBlock, 'source')
  expect(uiStateBlock.peekProperty(selectionStateProp)?.selectedBlockIds ?? []).toEqual([])

  let clipboardText = ''
  vi.stubGlobal('ClipboardItem', class {
    constructor(readonly data: Record<string, Blob>) {}
  })
  vi.stubGlobal('navigator', {clipboard: {
    write: vi.fn(async (items: {data: Record<string, Blob>}[]) => {
      clipboardText = await items[0].data['text/plain'].text()
    }),
    readText: vi.fn(async () => clipboardText),
  }})

  const runtime = resolveFacetRuntimeSync([
    ...defaultActionContextConfigs.map(config => actionContextsFacet.of(config)),
    ...[...getDefaultActions({repo}), ...getVimNormalModeActions({repo})]
      .map(action => actionsFacet.of(action)),
  ])
  const onReady = vi.fn()
  const tree = (blockId: string) => (
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        <NormalMode deps={{block: repo.block(blockId), uiStateBlock, scopeRootId: 'root'}} onReady={onReady}/>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  )
  const view = render(tree('source'))
  await vi.waitFor(() => expect(onReady).toHaveBeenLastCalledWith('source'))
  const modifiers = parseKeybinding('$mod+x')[0][0]
  const cut = new KeyboardEvent('keydown', {
    key: 'x', code: 'KeyX', bubbles: true, cancelable: true,
    metaKey: modifiers.includes('Meta'), ctrlKey: modifiers.includes('Control'),
  })
  act(() => { window.dispatchEvent(cut) })
  expect(cut.defaultPrevented).toBe(true)
  await vi.waitFor(() => {
    expect(getArmedCut()?.rootIds).toEqual(['source'])
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe('next')
  })
  expect(clipboardText).toBe('- source\n  - child')
  expect((await repo.query.children({id: 'root'}).load()).map(block => block.id))
    .toEqual(['source', 'next'])

  view.rerender(tree(peekFocusedBlockLocation(uiStateBlock)!.blockId))
  await vi.waitFor(() => expect(onReady).toHaveBeenLastCalledWith('next'))
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'p', code: 'KeyP', bubbles: true}))
  })
  await vi.waitFor(async () => {
    expect((await repo.query.children({id: 'root'}).load()).map(block => block.id))
      .toEqual(['next', 'source'])
    expect(peekFocusedBlockLocation(uiStateBlock)?.blockId).toBe('source')
  })
  expect((await repo.query.children({id: 'source'}).load()).map(block => block.id)).toEqual(['child'])
})
