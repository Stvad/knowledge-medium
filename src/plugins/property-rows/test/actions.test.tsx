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
import { actionContextsFacet, actionTransformsFacet } from '@/extensions/core'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { ActiveContextsProvider, useActiveContextsDispatch, useActiveContextsState } from '@/shortcuts/ActiveContexts'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler'
import { actionDispatchVerb } from '@/shortcuts/actionDispatch'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { defaultActionsExtension } from '@/shortcuts/defaultShortcuts'
import { getEffectiveActions } from '@/shortcuts/effectiveActions'
import { useCommandPaletteActions } from '@/plugins/command-palette/useCommandPaletteActions'
import { propertyRowsPlugin } from '../index'
import { keybindingOverridesFacet, type KeybindingOverride } from '@/shortcuts/keybindingOverrides'
import { ActionContextTypes, type ActionConfig, type BaseShortcutDependencies } from '@/shortcuts/types'
import { cyclePropertyDisplayActions } from '../actions'

let db: TestDb
let repo: Repo
const dispatched: string[] = []
const trace: string[] = []
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })
afterEach(cleanup)
beforeEach(async () => {
  dispatched.length = 0
  trace.length = 0
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

async function mount(propertyDisplay: PropertyDisplayScopeLevels | undefined, multi = false, overrides: KeybindingOverride[] = []) {
  const context = multi ? ActionContextTypes.MULTI_SELECT_MODE : ActionContextTypes.NORMAL_MODE
  const deps = {
    uiStateBlock: repo.block('panel'), propertyDisplay,
    ...(multi ? {selectedBlocks: [repo.block('first'), repo.block('second')], anchorBlock: null} : {block: repo.block('first')}),
  }
  const runtime = resolveFacetRuntimeSync([
    kernelDataExtension,
    defaultActionsExtension({repo}),
    propertyRowsPlugin,
    defaultActionContextConfigs.map(config => actionContextsFacet.of(config)),
    overrides.map(override => keybindingOverridesFacet.of(override)),
    cyclePropertyDisplayActions.map(({id}) => actionTransformsFacet.of({
      actionId: id,
      apply: action => ({...action, canDispatch: dependencies => {
        trace.push(`try ${id}`)
        return action.canDispatch?.(dependencies) ?? true
      }}),
    })),
    actionDispatchVerb.before(({action}) => { dispatched.push(action.id); trace.push(action.id) }),
  ])
  repo.setFacetRuntime(runtime)
  let ready = false
  let palette: readonly ActionConfig[] = []
  function Activate() {
    const dispatch = useActiveContextsDispatch()
    const active = useActiveContextsState()
    useLayoutEffect(() => { dispatch.activate(context, deps as BaseShortcutDependencies) }, [dispatch])
    useEffect(() => { if (active.has(context)) ready = true }, [active])
    return null
  }
  function PaletteProbe() {
    const {actions} = useCommandPaletteActions(true, null)
    useEffect(() => { palette = actions }, [actions])
    return null
  }
  render(<AppRuntimeContextProvider value={runtime}><ActiveContextsProvider>
    <HotkeyReconciler/><Activate/><PaletteProbe/>
  </ActiveContextsProvider></AppRuntimeContextProvider>)
  await vi.waitFor(() => expect(ready).toBe(true))
  return {runtime, palette: () => palette}
}

async function press(key: string) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', {key, code: `Key${key.toUpperCase()}`, bubbles: true}))
    window.dispatchEvent(new KeyboardEvent('keyup', {key, code: `Key${key.toUpperCase()}`, bubbles: true}))
  })
}
const setting = (id = 'first') => repo.block(id).peek()?.properties[propertyDisplayProp.name]

const cycleId = (multi: boolean) => multi ? 'multi_select.property-rows.block.cycle' : 'property-rows.block.cycle'
const panelId = (multi: boolean) => multi ? 'multi_select.toggle_properties' : 'toggle_properties'
const panelDispatches = (multi: boolean) => multi ? [panelId(true), panelId(false), panelId(false)] : [panelId(false)]

const overrideCases = [
  {name: 'default', target: 'panel', binding: undefined, child: 'cycle', cell: 'panel'},
  {name: 'panel rebound to p', target: 'panel', binding: {keys: 'p'}, child: 'cycle', cell: 'none'},
  {name: 'panel explicitly rebound to t', target: 'panel', binding: {keys: 't'}, child: 'panel', cell: 'panel'},
  {name: 'panel unbound', target: 'panel', binding: {unbound: true}, child: 'cycle', cell: 'none'},
  {name: 'cycle explicitly rebound to t', target: 'cycle', binding: {keys: 't'}, child: 'cycle', cell: 'none'},
] as const

const matrix = [false, true].flatMap(multi => [false, true].flatMap(childBacked =>
  overrideCases.map(scenario => ({...scenario, multi, childBacked}))))

describe('property display keyboard actions', () => {
  it.each([false, true].flatMap(multi => [false, true].map(childBacked => ({multi, childBacked}))))(
    'facet precedence tries the cycle first and declines to the panel (selection: $multi, child-backed: $childBacked)',
    async ({multi, childBacked}) => {
      const {runtime} = await mount(scope(childBacked), multi)
      const candidates = getEffectiveActions(runtime).filter(action => [cycleId(multi), panelId(multi)].includes(action.id))
      expect(candidates.map(action => action.id)).toEqual([cycleId(multi), panelId(multi)])
      expect(candidates.every(action => action.defaultBinding?.keys === 't')).toBe(true)
      await press('t')
      const expected = childBacked ? [cycleId(multi)] : panelDispatches(multi)
      await vi.waitFor(() => expect(trace).toEqual([`try ${cycleId(multi)}`, ...expected]))
      if (childBacked) await vi.waitFor(() => expect(setting()).toBe('non-hidden'))
      else await vi.waitFor(() => expect(repo.block('first').peekProperty(showPropertiesProp)).toBe(true))
    },
  )

  it.each(matrix)('$name: t follows saved override dispatch (selection: $multi, child-backed: $childBacked)', async scenario => {
    const {multi, childBacked, binding, target} = scenario
    if (!childBacked) await db.db.execute("UPDATE workspaces SET properties_migration = NULL WHERE id = 'ws'")
    const overrides: KeybindingOverride[] = binding ? [{
      actionId: target === 'cycle' ? cycleId(multi) : panelId(multi), binding, source: 'user-prefs',
    }] : []
    await mount(scope(childBacked), multi, overrides)
    await press('t')
    const outcome = childBacked ? scenario.child : scenario.cell
    const expected = outcome === 'cycle' ? [cycleId(multi)] : outcome === 'panel' ? panelDispatches(multi) : []
    await vi.waitFor(() => expect(dispatched).toEqual(expected))
    const subjects = multi ? ['first', 'second'] : ['first']
    await vi.waitFor(() => {
      for (const id of subjects) {
        expect(setting(id)).toBe(outcome === 'cycle' ? 'non-hidden' : undefined)
        expect(repo.block(id).peekProperty(showPropertiesProp)).toBe(outcome === 'panel' ? true : undefined)
      }
    })
    if (binding && 'keys' in binding && binding.keys === 'p') {
      dispatched.length = 0
      await press('p')
      await vi.waitFor(() => expect(dispatched).toEqual(panelDispatches(multi)))
      await vi.waitFor(() => subjects.forEach(id => expect(repo.block(id).peekProperty(showPropertiesProp)).toBe(true)))
    }
  })

  it('child-backed t cycles rows without opening the property panel', async () => {
    await mount(scope())
    for (const next of ['non-hidden', 'all', 'inherit']) {
      await press('t')
      await vi.waitFor(() => expect(setting()).toBe(next))
      expect(repo.block('first').peekProperty(showPropertiesProp)).toBeUndefined()
    }
  })

  it.each([false, true])('read-only child-backed t falls through to the panel (selection: %s)', async multi => {
    repo.setReadOnly(true)
    const {palette} = await mount(scope(), multi)
    await press('t')
    await vi.waitFor(() => expect(dispatched).toEqual(panelDispatches(multi)))
    await vi.waitFor(() => expect(repo.block('first').peekProperty(showPropertiesProp)).toBe(true))
    expect(setting()).toBeUndefined()
    if (multi) {
      await vi.waitFor(() => expect(repo.block('second').peekProperty(showPropertiesProp)).toBe(true))
      expect(setting('second')).toBeUndefined()
    }
    await vi.waitFor(() => expect(palette().map(action => action.id)).toContain(panelId(multi)))
    expect(palette().map(action => action.id)).not.toContain(cycleId(multi))
  })

  it.each([false, true])('the palette hides the cycle on a cell-backed workspace (selection: %s)', async multi => {
    const {palette} = await mount(scope(false), multi)
    await vi.waitFor(() => expect(palette().map(action => action.id)).toContain(panelId(multi)))
    expect(palette().map(action => action.id)).not.toContain(cycleId(multi))
  })

  it.each([false, true])('the palette offers the cycle on an editable child-backed workspace (selection: %s)', async multi => {
    const {palette} = await mount(scope(), multi)
    await vi.waitFor(() => expect(palette().map(action => action.id)).toContain(cycleId(multi)))
  })

  it.each([false, true].flatMap(multi => [scope(false), undefined].map(propertyDisplay => ({multi, propertyDisplay}))))(
    'direct cycle handler refuses cell-backed or absent scope before a transaction (selection: $multi, scope: $propertyDisplay)',
    async ({multi, propertyDisplay}) => {
      const {runtime} = await mount(propertyDisplay, multi)
      const action = getEffectiveActions(runtime).find(action => action.id === cycleId(multi))!
      const write = vi.spyOn(repo, 'tx')
      const deps = {uiStateBlock: repo.block('panel'), propertyDisplay,
        ...(multi ? {selectedBlocks: [repo.block('first'), repo.block('second')], anchorBlock: null} : {block: repo.block('first')})}
      await action.handler(deps, new CustomEvent('test'))
      expect(write).not.toHaveBeenCalled()
      expect(setting()).toBeUndefined()
    },
  )

  it('selection uses the first effective mode and collapses every inherited target', async () => {
    await repo.block('first').set(propertyDisplayProp, 'none')
    await repo.block('second').set(propertyDisplayProp, 'all')
    await mount({...scope(), panel: 'non-hidden'}, true)
    await press('t')
    await vi.waitFor(() => expect([setting(), setting('second')]).toEqual(['inherit', 'inherit']))
    expect(repo.block('first').peekProperty(showPropertiesProp)).toBeUndefined()
    expect(repo.block('second').peekProperty(showPropertiesProp)).toBeUndefined()
  })

  it('an empty selection does not write', async () => {
    const action = cyclePropertyDisplayActions.find(action => action.id === cycleId(true)) as ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE>
    const write = vi.spyOn(repo, 'tx')
    await action.handler({uiStateBlock: repo.block('panel'), selectedBlocks: [], anchorBlock: null,
      propertyDisplay: scope()}, {kind: 'test'} as never)
    expect(write).not.toHaveBeenCalled()
  })
})
