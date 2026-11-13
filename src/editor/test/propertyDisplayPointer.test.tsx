// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChangeScope, seedProperty, type User } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { focusBlock, selectionStateProp } from '@/data/properties'
import type { PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import { PropertyDisplayScopeContext } from '@/context/propertyDisplay'
import { actionContextsFacet, actionsFacet } from '@/extensions/core'
import { extendBlockSelectionAction } from '@/extensions/blockSelectionAction'
import type { BlockResolveContext, BlockShellState } from '@/extensions/blockInteraction'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet'
import { ActiveContextsProvider } from '@/shortcuts/ActiveContexts'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler'
import { BlockSelectionShellDecorator } from '../defaultInteractions'

const USER: User = {id: 'user-1'}
const WS = 'ws-1'
const SCOPE: PropertyDisplayScopeLevels = {childBacked: true, workspace: 'non-hidden', panel: 'inherit'}
const statusProp = seedProperty({
  seedKey: 'test/property/pointer-status', revision: 1, name: 'pointer:status',
  preset: 'string', defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
let db: TestDb
let repo: Repo
let runtime: FacetRuntime
let fieldId: string
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(cleanup)
beforeEach(async () => {
  await resetTestDb(db.db)
  await db.db.execute(
    `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
       encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'test ws', ?, 1, 1, 'none', NULL, 'children')`, [WS, USER.id])
  repo = createTestRepo({db: db.db, user: USER}).repo
  runtime = resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(statusProp, {source: 'test'}),
    actionsFacet.of(extendBlockSelectionAction, {source: 'test'}),
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config, {source: 'test'})),
  ])
  repo.setFacetRuntime(runtime)
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({id: 'panel', workspaceId: WS, parentId: null, orderKey: 'a0'})
    await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a1'})
    await tx.create({id: 'before', workspaceId: WS, parentId: 'root', orderKey: 'a0', content: 'before'})
    await tx.create({id: 'after', workspaceId: WS, parentId: 'root', orderKey: 'a2', content: 'after'})
  }, {scope: ChangeScope.BlockDefault})
  await vi.waitFor(() => expect(repo.propertySchemas.has(statusProp.name)).toBe(true))
  await repo.block('root').set(statusProp, 'draft')
  const fields = await repo.query.children({id: 'root', propertyChildren: 'all'}).load()
  fieldId = fields.find(row => row.isFieldForm)!.id
  await repo.tx(tx => tx.move(fieldId, {parentId: 'root', orderKey: 'a1'}), {scope: ChangeScope.BlockDefault})
})

it('shift-click ranges through the clicked surface property scope and follows scope changes', async () => {
  const panel = repo.block('panel')
  const context: BlockResolveContext = {
    block: repo.block('after'), repo, uiStateBlock: panel, types: [],
    topLevelBlockId: 'root', scopeRootId: 'root', isTopLevel: false,
  }
  const state: BlockShellState = {
    shellProps: {'data-block-shell': 'true', 'data-block-id': 'after', 'data-editing': 'false', tabIndex: 0},
    shortcutSurfaceOptions: {},
  }
  const mount = (scope: PropertyDisplayScopeLevels) => (
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        <PropertyDisplayScopeContext value={scope}>
          <BlockSelectionShellDecorator resolveContext={context} state={state}
            shellRef={{current: null}} contentRef={{current: null}}>
            {next => <div {...next.shellProps}>after</div>}
          </BlockSelectionShellDecorator>
        </PropertyDisplayScopeContext>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  )
  const view = render(mount(SCOPE))
  await focusBlock(panel, 'before')
  fireEvent.click(screen.getByText('after'), {shiftKey: true, detail: 1})
  await vi.waitFor(() => expect(panel.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['before', fieldId, 'after']))

  view.rerender(mount({...SCOPE, workspace: 'none'}))
  await panel.set(selectionStateProp, {selectedBlockIds: [], anchorBlockId: null})
  await focusBlock(panel, 'before')
  fireEvent.click(screen.getByText('after'), {shiftKey: true, detail: 1})
  await vi.waitFor(() => expect(panel.peekProperty(selectionStateProp)?.selectedBlockIds).toEqual(['before', 'after']))
})
