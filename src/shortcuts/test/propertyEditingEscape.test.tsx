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
  type MultiSelectModeDependencies,
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
 *  `usePropertyEditingActivation` hook supplies in the app — plus GLOBAL,
 *  which the app activates app-wide and which modal shadowing deliberately
 *  keeps installed (`computeInstallableContexts`). Without GLOBAL active, a
 *  global action isn't a dispatch candidate at all and the bare-key case
 *  below would pass no matter how wide this context's filter got. */
const Activator = ({shadowWithMultiSelect = false}: {shadowWithMultiSelect?: boolean}) => {
  const dispatch = useActiveContextsDispatch()
  useEffect(() => {
    dispatch.activate(ActionContextTypes.GLOBAL, {uiStateBlock: deps.uiStateBlock})
    dispatch.activate(ActionContextTypes.PROPERTY_EDITING, deps)
    // Activated AFTER property-editing, so it becomes the latest modal and
    // shadows it — the real sequence when a selection changes while a
    // property field still holds focus (`activate` re-inserts at the end on
    // any deps change, and multi-select's deps are a fresh object per
    // selection change).
    if (shadowWithMultiSelect) {
      const multiSelectDeps: MultiSelectModeDependencies = {
        uiStateBlock: deps.uiStateBlock,
        selectedBlocks: [deps.block],
        anchorBlock: null,
      }
      dispatch.activate(ActionContextTypes.MULTI_SELECT_MODE, multiSelectDeps)
    }
    return () => {
      if (shadowWithMultiSelect) dispatch.deactivate(ActionContextTypes.MULTI_SELECT_MODE)
      dispatch.deactivate(ActionContextTypes.PROPERTY_EDITING)
      dispatch.deactivate(ActionContextTypes.GLOBAL)
    }
  }, [dispatch, shadowWithMultiSelect])
  return null
}

const renderWith = (
  actions: readonly ActionConfig[],
  {shadowWithMultiSelect = false} = {},
) => {
  const runtime = resolveFacetRuntimeSync([
    ...defaultActionContextConfigs.map(config => actionContextsFacet.of(config)),
    ...actions.map(action => actionsFacet.of(action)),
  ])
  render(
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        <Activator shadowWithMultiSelect={shadowWithMultiSelect}/>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>,
  )
}

/** Keydown ON THE INPUT (not on window): `event.target` is what the filter
 *  cascade reads, so dispatching at the window would make every case pass
 *  regardless of the opt-in. */
const pressKeyInInput = (key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      ...init,
    }))
  })
}

const globalAction = (id: string, keys: string, handler: () => void): ActionConfig => ({
  id,
  description: id,
  context: ActionContextTypes.GLOBAL,
  handler,
  defaultBinding: {keys},
} as ActionConfig)

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

  it('still exits when the action is rebound to another bare non-text key', () => {
    // The context filter can't see bindings, so keying it to the literal
    // Escape would make any rebinding onto a bare non-text key (F2, Tab)
    // silently dead: `defaultEventFilter` drops modifier-less keys on
    // editable targets, and nothing would opt this one back in.
    const rebound = {
      ...propertyEditingAction('exit_property_editing'),
      defaultBinding: {keys: 'F2', eventOptions: {preventDefault: false}},
    } as ActionConfig
    renderWith([rebound])
    expect(document.activeElement).toBe(input)

    pressKeyInInput('F2')

    expect(document.activeElement).not.toBe(input)
  })

  it('exits a `<select>` field too, not just text inputs', () => {
    // `enum` ("Choice") properties render a native `<select>`, which
    // `hasEditableTarget` also treats as editable — so it needs the same exit,
    // and the context's deps must accept it rather than only HTMLInputElement.
    const select = document.createElement('select')
    document.body.append(select)
    try {
      deps = {...deps, input: select}
      select.focus()
      renderWith([propertyEditingAction('exit_property_editing')])
      expect(document.activeElement).toBe(select)

      act(() => {
        select.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
        }))
      })

      expect(document.activeElement).not.toBe(select)
    } finally {
      select.remove()
    }
  })

  it('does not let a shadowed property-editing context green-light another modal', () => {
    // A context this filter belongs to can be active but SHADOWED: focusing a
    // property field deliberately keeps a block selection, and any later
    // selection change re-activates MULTI_SELECT_MODE, making it the latest
    // modal. `exit_property_editing` is then uninstalled, while
    // MULTI_SELECT_MODE's own bare-key bindings are installed — `Escape`
    // (`clear_selection`) and `Delete` (`deleteSelectedBlocks`, no
    // confirmation). If this context's filter still admitted the event while
    // shadowed, a keypress in a text field would run those: silently clearing
    // the selection, or DELETING the selected blocks. The stand-ins below are
    // bound to exactly those keys.
    const multiEscape = vi.fn()
    const multiDelete = vi.fn()
    renderWith(
      [
        propertyEditingAction('exit_property_editing'),
        {
          id: 'test.multi_escape',
          description: 'stands in for clear_selection',
          context: ActionContextTypes.MULTI_SELECT_MODE,
          handler: multiEscape,
          defaultBinding: {keys: 'Escape'},
        } as ActionConfig,
        {
          id: 'test.multi_delete',
          description: 'stands in for the multi-select delete',
          context: ActionContextTypes.MULTI_SELECT_MODE,
          handler: multiDelete,
          defaultBinding: {keys: 'Delete'},
        } as ActionConfig,
      ],
      {shadowWithMultiSelect: true},
    )

    pressKeyInInput('Escape')
    pressKeyInInput('Delete')

    expect(multiEscape).not.toHaveBeenCalled()
    expect(multiDelete).not.toHaveBeenCalled()
    // Nothing ran at all: the shadowing also uninstalled the exit action, so
    // the field keeps focus rather than the key being handed to another mode.
    expect(document.activeElement).toBe(input)
  })

  it('still exits when the key is rebound to a modifier chord', () => {
    // The opt-in declines single-character keys so typing stays typing — but
    // that must not veto `Ctrl+J`, which the editable-target heuristic admits
    // on its own (a modifier chord is aimed at the app, not the field). An
    // opt-in adds to the default; it never subtracts from it.
    renderWith([
      {...propertyEditingAction('exit_property_editing'), defaultBinding: {keys: 'Control+j'}},
    ])
    expect(document.activeElement).toBe(input)

    pressKeyInInput('j', {ctrlKey: true})

    expect(document.activeElement).not.toBe(input)
  })

  it('leaves Escape to the IME while a composition is in flight', () => {
    // Mid-composition Escape cancels the candidate; blurring here would end
    // the composition and let the field's blur commit the half-composed text.
    renderWith([propertyEditingAction('exit_property_editing')])

    pressKeyInInput('Escape', {isComposing: true})
    expect(document.activeElement).toBe(input)

    // Composition over, same key: the ordinary exit is back.
    pressKeyInInput('Escape')
    expect(document.activeElement).not.toBe(input)
  })

  it('does not lend its opt-in to a global bound to a bare named key', () => {
    // The opt-in admits non-text keys so a REBOUND exit key still works. That
    // must not also hand those keys to GLOBAL, which declares no filter: the
    // keybindings UI imposes no modifier requirement, so a user can put any
    // global on bare F2/Enter/Delete, and it would then fire while they type
    // here. Each candidate is judged by its own context, so this stays put.
    const handler = vi.fn()
    renderWith([
      propertyEditingAction('exit_property_editing'),
      {
        id: 'test.rebound_global',
        description: 'global rebound onto a bare named key',
        context: ActionContextTypes.GLOBAL,
        handler,
        defaultBinding: {keys: 'F2'},
      } as ActionConfig,
    ])

    pressKeyInInput('F2')

    expect(handler).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)
  })

  it('leaves bare-key global chords blocked while the input has focus', () => {
    // `test.bare_global` stands in for shortcut-help's bare `?`: a GLOBAL
    // chord that modal shadowing keeps installed. Typing must not reach it.
    const bare = vi.fn()
    const chord = vi.fn()
    renderWith([
      propertyEditingAction('exit_property_editing'),
      globalAction('test.bare_global', 'p', bare),
      globalAction('test.chord_global', 'Control+j', chord),
    ])

    pressKeyInInput('p')

    expect(bare).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(input)

    // Liveness control for the assertion above: a modifier-bearing GLOBAL
    // chord DOES fire from inside this same input, proving the global context
    // is active and installed — so the miss above is this context's filter
    // declining a text key, not an unreachable global.
    pressKeyInInput('j', {ctrlKey: true})

    expect(chord).toHaveBeenCalled()
  })
})
