// @vitest-environment happy-dom
import { useLayoutEffect, useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { showPropertiesProp } from '@/data/properties'
import { propertyDisplayProp, type PropertyDisplayScopeLevels } from '@/data/propertyDisplayMode'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { actionContextsFacet, actionsFacet } from '@/extensions/core'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { ActiveContextsProvider, useActiveContextsDispatch, useActiveContextsState } from '@/shortcuts/ActiveContexts'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler'
import { actionDispatchVerb } from '@/shortcuts/actionDispatch'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import { keybindingOverridesFacet, type KeybindingOverride } from '@/shortcuts/keybindingOverrides'
import { ActionContextTypes, type ActionConfig, type BaseShortcutDependencies } from '@/shortcuts/types'
import { propertyDisplayActions } from '../actions'

let db: TestDb
let repo: Repo
const dispatched: string[] = []
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(cleanup)
beforeEach(async () => {
  dispatched.length = 0
  await resetTestDb(db.db)
  await db.db.execute(`INSERT INTO workspaces
    (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
    VALUES ('ws', 'test', 'user', 1, 1, 'none', 'children')`)
  repo = createTestRepo({db: db.db, user: {id: 'user', name: 'Test'}}).repo
  repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
  repo.setActiveWorkspaceId('ws')
  await repo.tx(async tx => {
    for (const id of ['panel', 'first', 'second']) {
      await tx.create({id, workspaceId: 'ws', parentId: null, orderKey: 'a0', content: id})
    }
  }, {scope: ChangeScope.BlockDefault})
})

const scope = (childBacked = true): PropertyDisplayScopeLevels => ({childBacked, workspace: 'inherit', panel: 'inherit'})

async function mount(propertyDisplay: PropertyDisplayScopeLevels | undefined, multi = false, overrides: KeybindingOverride[] = [], pluginFirst = false) {
  const context = multi ? ActionContextTypes.MULTI_SELECT_MODE : ActionContextTypes.NORMAL_MODE
  const deps = {
    uiStateBlock: repo.block('panel'), propertyDisplay,
    ...(multi ? {selectedBlocks: [repo.block('first'), repo.block('second')], anchorBlock: null} : {block: repo.block('first')}),
  }
  const coreActions = getDefaultActions({repo})
  const actions = pluginFirst ? [...propertyDisplayActions, ...coreActions] : [...coreActions, ...propertyDisplayActions]
  const runtime = resolveFacetRuntimeSync([
    kernelDataExtension,
    actions.map(action => actionsFacet.of(action)),
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config)),
    overrides.map(override => keybindingOverridesFacet.of(override)),
    actionDispatchVerb.before(({action}) => { dispatched.push(action.id) }),
  ])
  repo.setFacetRuntime(runtime)
  let ready = false
  function Activate() {
    const dispatch = useActiveContextsDispatch()
    const active = useActiveContextsState()
    useLayoutEffect(() => { dispatch.activate(context, deps as BaseShortcutDependencies) }, [dispatch])
    useEffect(() => { if (active.has(context)) ready = true }, [active])
    return null
  }
  render(<AppRuntimeContextProvider value={runtime}><ActiveContextsProvider>
    <HotkeyReconciler/><Activate/>
  </ActiveContextsProvider></AppRuntimeContextProvider>)
  await vi.waitFor(() => expect(ready).toBe(true))
}

async function press(key: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {key, code: `Key${key.toUpperCase()}`, bubbles: true}))
    window.dispatchEvent(new KeyboardEvent('keyup', {key, code: `Key${key.toUpperCase()}`, bubbles: true}))
  })
}
const setting = (id = 'first') => repo.block(id).peek()?.properties[propertyDisplayProp.name]

describe('property display keyboard actions', () => {
  it('child-backed t cycles rows without opening the property panel', async () => {
    await mount(scope())
    for (const next of ['non-hidden', 'all', 'inherit']) {
      await press('t')
      await vi.waitFor(() => expect(setting()).toBe(next))
      expect(repo.block('first').peekProperty(showPropertiesProp)).toBeUndefined()
    }
  })

  it.each([false, undefined])('cell-backed or absent scope t toggles only the panel (%s)', async childBacked => {
    await db.db.execute("UPDATE workspaces SET properties_migration = NULL WHERE id = 'ws'")
    await mount(childBacked === undefined ? undefined : scope(false), false, [], true)
    await press('t')
    await vi.waitFor(() => expect(repo.block('first').peekProperty(showPropertiesProp)).toBe(true))
    expect(setting()).toBeUndefined()
    await press('t')
    await vi.waitFor(() => expect(repo.block('first').peekProperty(showPropertiesProp)).toBe(false))
    expect(setting()).toBeUndefined()
  })

  it('selection uses the first effective mode and collapses every inherited target', async () => {
    await repo.block('first').set(propertyDisplayProp, 'none')
    await repo.block('second').set(propertyDisplayProp, 'all')
    await mount({...scope(), panel: 'non-hidden'}, true)
    await press('t')
    await vi.waitFor(() => expect([setting(), setting('second')]).toEqual(['inherit', 'inherit']))
    expect(repo.block('first').peekProperty(showPropertiesProp)).toBeUndefined()
    expect(repo.block('second').peekProperty(showPropertiesProp)).toBeUndefined()
  })

  it.each(['p', 't'])('a saved toggle_properties binding to %s still opens only the panel', async key => {
    await mount(scope(), false, [{actionId: 'toggle_properties', binding: {keys: key}, source: 'user-prefs'}])
    await press(key)
    await vi.waitFor(() => expect(repo.block('first').peekProperty(showPropertiesProp)).toBe(true))
    expect(setting()).toBeUndefined()
  })

  it.each([false, true])('cell-backed t respects a disabled or rebound panel command (selection: %s)', async multi => {
    await db.db.execute("UPDATE workspaces SET properties_migration = NULL WHERE id = 'ws'")
    const actionId = multi ? 'multi_select.toggle_properties' : 'toggle_properties'
    for (const binding of [{unbound: true} as const, {keys: 'p'}]) {
      await mount(scope(false), multi, [{actionId, binding, source: 'user-prefs'}])
      await press('t')
      expect(dispatched).toEqual([])
      expect(repo.block('first').peekProperty(showPropertiesProp)).toBeUndefined()
      expect(setting()).toBeUndefined()
      if ('keys' in binding) {
        await press('p')
        await vi.waitFor(() => expect(repo.block('first').peekProperty(showPropertiesProp)).toBe(true))
        if (multi) await vi.waitFor(() => expect(repo.block('second').peekProperty(showPropertiesProp)).toBe(true))
      }
      cleanup()
      dispatched.length = 0
    }
  })

  it('an empty selection does not write', async () => {
    const action = propertyDisplayActions.find(action => action.id === 'multi_select.property-rows.block.cycle') as ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE>
    const write = vi.spyOn(repo, 'tx')
    await action.handler({uiStateBlock: repo.block('panel'), selectedBlocks: [], anchorBlock: null,
      propertyDisplay: scope()}, {kind: 'test'} as never)
    expect(write).not.toHaveBeenCalled()
  })
})
