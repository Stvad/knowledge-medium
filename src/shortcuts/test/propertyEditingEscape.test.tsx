// @vitest-environment happy-dom
/**
 * Escape exits property editing — the property-panel analogue of
 * `exit_edit_mode_cm`.
 *
 * Driven through the REAL reconciler cascade with the REAL
 * `PROPERTY_EDITING` context config on purpose: the reported bug ("Esc in
 * property editor does not exit edit mode") had two independent halves, and
 * a handler-only test would pass with the second still broken —
 *
 *  1. no action was registered against `PROPERTY_EDITING` at all, and
 *  2. a bare Escape from inside an `<input>` never reaches dispatch:
 *     `defaultEventFilter` drops modifier-less keys on editable targets, so
 *     the context has to opt in via `eventFilter` the way `EDIT_MODE_CM`
 *     does for `.cm-editor`.
 *
 * The narrowness of that opt-in is load-bearing, hence the bare-key global
 * case below: green-lighting every key while a property input is focused
 * would fire bare-key GLOBAL chords (shortcut-help's `?`) mid-typing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useEffect } from 'react'
import { ChangeScope, type User } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { topLevelBlockIdProp } from '@/data/properties'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler.js'
import {
  ActiveContextsProvider,
  useActiveContextsDispatch,
} from '@/shortcuts/ActiveContexts.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts.js'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import {
  ActionContextTypes,
  type ActionConfig,
  type PropertyEditingDependencies,
} from '@/shortcuts/types'

const WS = 'ws-1'
const USER: User = {id: 'user-1'}

let sharedDb: TestDb
let repo: Repo
let deps: PropertyEditingDependencies
let input: HTMLInputElement

const propertyEditingAction = (id: string): ActionConfig => {
  const action = getDefaultActions({repo}).find(
    candidate => candidate.id === id && candidate.context === ActionContextTypes.PROPERTY_EDITING,
  )
  if (!action) throw new Error(`Action not found in property-editing context: ${id}`)
  return action
}

/** Activates PROPERTY_EDITING with the real focused-input deps the
 *  `usePropertyEditingActivation` hook supplies in the app. */
const Activator = () => {
  const dispatch = useActiveContextsDispatch()
  useEffect(() => {
    dispatch.activate(ActionContextTypes.PROPERTY_EDITING, deps)
    return () => dispatch.deactivate(ActionContextTypes.PROPERTY_EDITING)
  }, [dispatch])
  return null
}

const renderWith = (actions: readonly ActionConfig[]) => {
  const runtime = resolveFacetRuntimeSync([
    ...defaultActionContextConfigs.map(config => actionContextsFacet.of(config)),
    ...actions.map(action => actionsFacet.of(action)),
  ])
  render(
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        <Activator/>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>,
  )
}

/** Keydown ON THE INPUT (not on window): `event.target` is what the filter
 *  cascade reads, so dispatching at the window would make every case pass
 *  regardless of the opt-in. */
const pressKeyInInput = (key: string) => {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
    }))
  })
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({
      id: 'panel',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      properties: {[topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode('content')},
    })
    await tx.create({id: 'content', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'content'})
  }, {scope: ChangeScope.UiState})

  input = document.createElement('input')
  document.body.append(input)
  input.focus()
  deps = {uiStateBlock: repo.block('panel'), block: repo.block('content'), input}
})

afterEach(() => {
  cleanup()
  input.remove()
})

describe('Escape in a property editor', () => {
  it('blurs the focused property input, ending property editing', () => {
    renderWith([propertyEditingAction('exit_property_editing')])
    expect(document.activeElement).toBe(input)

    pressKeyInInput('Escape')

    expect(document.activeElement).not.toBe(input)
  })

  it('leaves bare-key global chords blocked while the input has focus', () => {
    const handler = vi.fn()
    renderWith([
      propertyEditingAction('exit_property_editing'),
      {
        // Stands in for shortcut-help's bare `?`: a GLOBAL chord that stays
        // installed under a modal context. Typing must not reach it.
        id: 'test.bare_global',
        description: 'bare-key global',
        context: ActionContextTypes.GLOBAL,
        handler,
        defaultBinding: {keys: 'p'},
      } as ActionConfig,
    ])

    pressKeyInInput('p')

    expect(handler).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })
})
