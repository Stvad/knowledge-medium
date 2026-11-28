// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { actionsFacet, actionContextsFacet, appMountsFacet } from '@/extensions/core'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { resolveAppRuntimeSync } from '@/facets/resolveAppRuntime'
import { ActiveContextsProvider, useActiveContextsDispatch } from '@/shortcuts/ActiveContexts'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler'
import { defaultActionContextConfigs } from '@/shortcuts/defaultContexts'
import { KEYBINDING_OVERRIDE_USER_SOURCE, keybindingOverridesFacet } from '@/shortcuts/keybindingOverrides'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types'
import { vimLinkHintsPlugin } from './index'

const repo = {} as Repo
const deps = {block: new Block(repo, 'row'), uiStateBlock: new Block(repo, 'panel'), renderScopeId: 'scope'}
const normal = ActionContextTypes.NORMAL_MODE
const global = ActionContextTypes.GLOBAL

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Contexts({modal, scope}: {modal: boolean; scope: string}) {
  const dispatch = useActiveContextsDispatch()
  useLayoutEffect(() => {
    const scopedDeps = {...deps, renderScopeId: scope}
    dispatch.activate(normal, scopedDeps)
    return () => dispatch.deactivate(normal)
  }, [dispatch, scope])
  useLayoutEffect(() => {
    dispatch.activate(global, deps)
    return () => dispatch.deactivate(global)
  }, [dispatch])
  useLayoutEffect(() => {
    if (!modal) return
    dispatch.activate(ActionContextTypes.DIALOG, deps)
    return () => dispatch.deactivate(ActionContextTypes.DIALOG)
  }, [dispatch, modal])
  return null
}

function setup({always = false, actions = []}: {always?: boolean; actions?: ActionConfig[]} = {}) {
  const runtime = resolveAppRuntimeSync([
    ...defaultActionContextConfigs.map(config => actionContextsFacet.of(config)),
    vimLinkHintsPlugin,
    ...actions.map(action => actionsFacet.of(action)),
  ], {overrides: new Map([['system:vim-link-hints/always-show', always]])})
  const [{component: Mount}] = runtime.read(appMountsFacet)
  const clicked = vi.fn()
  const tree = (modal = false, scope = deps.renderScopeId) => (
    <AppRuntimeContextProvider value={runtime}>
      <ActiveContextsProvider>
        <HotkeyReconciler/>
        <Contexts modal={modal} scope={scope}/>
        <Mount/>
        <div data-block-shell data-block-id="row" data-render-scope-id="other" tabIndex={0} aria-label="Other instance">
          <div className="block-content"><a href="#other">Other instance</a></div>
        </div>
        <div data-block-shell data-block-id="row" data-render-scope-id="scope" tabIndex={0} aria-label="Row">
          <div className="block-content">
            <a href="#first" onClick={event => {
              event.preventDefault()
              clicked(event)
            }}>First</a>
            <a href="#second">Second</a>
            <a href="#hidden" hidden>Hidden</a>
            <div data-block-shell><div className="block-content"><a href="#embed">Embedded block</a></div></div>
          </div>
          <div data-block-shell><div className="block-content"><a href="#child">Child block</a></div></div>
        </div>
      </ActiveContextsProvider>
    </AppRuntimeContextProvider>
  )
  const view = render(tree())
  const shell = screen.getByLabelText('Row')
  act(() => shell.focus())
  return {view, tree, runtime, shell, clicked}
}

function press(target: HTMLElement, key: string, {trusted = false, ...init}: KeyboardEventInit & {trusted?: boolean} = {}) {
  const event = new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true, ...init})
  Object.defineProperty(event, 'isTrusted', {value: trusted})
  // Happy DOM aliases AltGraph to Alt. Model a distinct Option/Alt key.
  const getModifierState = event.getModifierState.bind(event)
  vi.spyOn(event, 'getModifierState').mockImplementation(key => key !== 'AltGraph' && getModifierState(key))
  act(() => { target.dispatchEvent(event) })
  return event
}

const hint = (text: string) => screen.getByText(text).getAttribute('data-vim-link-hint')

function pointerDown(target: HTMLElement, pointerType: string) {
  act(() => target.dispatchEvent(new PointerEvent('pointerdown', {pointerType, bubbles: true})))
}

it('on a touchscreen shows automatic hints during keyboard use and hides them on touch or pen', () => {
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(5)
  const {shell, clicked} = setup({always: true})
  expect(hint('First')).toBeNull()
  press(shell, 'a')
  press(shell, 'a', {trusted: true, isComposing: true})
  expect(hint('First')).toBeNull()

  const editor = document.createElement('input')
  shell.append(editor)
  act(() => editor.focus())
  press(editor, 'a', {trusted: true})
  act(() => shell.focus())
  expect(hint('First')).toBeNull()

  expect(press(shell, 'a', {trusted: true}).defaultPrevented).toBe(false)
  expect(clicked).not.toHaveBeenCalled()
  expect(hint('First')).toBe('a')
  press(shell, 'a', {trusted: true})
  expect(clicked).toHaveBeenCalledOnce()

  pointerDown(shell, 'mouse')
  expect(hint('First')).toBe('a')
  pointerDown(shell, 'touch')
  expect(hint('First')).toBeNull()
  press(shell, 'Escape', {trusted: true})
  expect(hint('First')).toBe('a')
  pointerDown(shell, 'pen')
  expect(hint('First')).toBeNull()
})

it('opens on the first toggle key on a touchscreen', () => {
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(5)
  const {shell} = setup()
  expect(hint('First')).toBeNull()
  press(shell, 'f', {trusted: true})
  expect(hint('First')).toBe('a')
  pointerDown(shell, 'touch')
  expect(hint('First')).toBeNull()
  press(shell, 'f', {trusted: true})
  expect(hint('First')).toBe('a')
})

it('reveals only the focused block’s own visible links and follows through the original click handler', () => {
  const {shell, clicked} = setup()
  expect(hint('First')).toBeNull()
  press(shell, 'f')
  expect(hint('First')).toBe('a')
  expect(hint('Second')).toBe('b')
  for (const text of ['Hidden', 'Embedded block', 'Child block', 'Other instance']) {
    const link = screen.getByText(text, {selector: 'a'})
    expect(link.hasAttribute('data-vim-link-hint')).toBe(false)
  }
  const followed = press(shell, 'A', {altKey: true, shiftKey: true, metaKey: true, ctrlKey: true})
  expect(followed.defaultPrevented).toBe(true)
  expect(clicked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    altKey: true, shiftKey: true, metaKey: true, ctrlKey: true,
  }))
  expect(hint('First')).toBeNull()
})

it('reserves every press in an active shortcut and updates hints when a binding is remapped', () => {
  const handler = vi.fn()
  const {runtime, shell, clicked} = setup({always: true, actions: [
    {id: 'sequence', context: normal, description: 'Sequence', defaultBinding: {keys: 'a b'}, handler},
    {id: 'modified', context: global, description: 'Modified', defaultBinding: {keys: 'Shift+KeyC'}, handler},
    {id: 'edit', context: ActionContextTypes.EDIT_MODE_CM, description: 'Edit', defaultBinding: {keys: 'd'}, handler},
  ]})
  expect(hint('First')).toBe('d')
  press(shell, 'D', {code: 'KeyC', shiftKey: true})
  expect(handler).toHaveBeenCalledTimes(1)
  expect(clicked).not.toHaveBeenCalled()
  press(shell, 'a')
  press(shell, 'b')
  expect(handler).toHaveBeenCalledTimes(2)

  act(() => {
    runtime.setRuntimeContributions(keybindingOverridesFacet, 'test', [
      {actionId: 'sequence', context: normal, binding: {keys: 'd g'}, source: KEYBINDING_OVERRIDE_USER_SOURCE},
    ])
  })
  expect(hint('First')).toBe('a')
  press(shell, 'd')
  press(shell, 'g')
  expect(handler).toHaveBeenCalledTimes(3)
})

it('reassigns labels when rendered content changes and clears them when a modal takes over', async () => {
  const {view, tree, shell} = setup({always: true})
  const link = document.createElement('a')
  link.href = '#new'
  link.textContent = 'New'
  shell.querySelector('.block-content')!.prepend(link)
  await waitFor(() => expect(hint('New')).toBe('a'))
  expect(hint('First')).toBe('b')

  view.rerender(tree(true))
  expect(hint('New')).toBeNull()
  expect(press(shell, 'a').defaultPrevented).toBe(false)
  view.rerender(tree(false))
  expect(hint('New')).toBe('a')
  act(() => screen.getByLabelText('Other instance').focus())
  expect(hint('New')).toBeNull()
})

it('uses multi-letter hints when two free letters must label three links', async () => {
  const {shell, clicked} = setup({always: true, actions: [
    {id: 'other-letters', context: normal, description: 'Other letters', defaultBinding: {keys: '([c-z])'}, handler: () => {}},
  ]})
  const link = document.createElement('a')
  link.href = '#new'
  link.textContent = 'New'
  shell.querySelector('.block-content')!.append(link)
  await waitFor(() => expect(hint('New')).toBe('ba'))
  expect(hint('First')).toBe('aa')
  press(shell, 'a')
  expect(hint('First')).toBe('a')
  expect(hint('Second')).toBe('b')
  expect(hint('New')).toBeNull()
  press(shell, 'a', {repeat: true})
  expect(clicked).not.toHaveBeenCalled()
  press(shell, 'a', {shiftKey: true})
  expect(clicked).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({shiftKey: true}))
  expect(hint('First')).toBe('aa')
})

it('keeps a trigger pressed between DOM focus and the matching normal-mode activation', () => {
  const {view, tree} = setup()
  const other = screen.getByLabelText('Other instance')
  act(() => other.focus())
  expect(press(other, 'f').defaultPrevented).toBe(true)
  expect(hint('Other instance')).toBeNull()
  view.rerender(tree(false, 'other'))
  expect(hint('Other instance')).toBe('a')
  expect(hint('First')).toBeNull()
})

it('follows logical normal-mode focus when Colemak navigation leaves DOM focus on the previous row', () => {
  const {shell, view, tree} = setup()
  view.rerender(tree(false, 'other'))
  expect(document.activeElement).toBe(shell)
  press(shell, 'f', {code: 'KeyE'})
  expect(hint('Other instance')).toBe('a')
  expect(hint('First')).toBeNull()
  expect(press(shell, 'a').defaultPrevented).toBe(true)
})

it('keeps always-show hints on the normal-mode block when the document body receives the keys', () => {
  const {shell, clicked} = setup({always: true})
  act(() => shell.blur())
  expect(hint('First')).toBe('a')
  press(document.body, 'a')
  expect(clicked).toHaveBeenCalledTimes(1)
})

it('accepts Colemak movement from a tab-focused link on the previous row', () => {
  const {view, tree} = setup()
  const previous = screen.getByText('First')
  act(() => previous.focus())
  view.rerender(tree(false, 'other'))
  press(previous, 'f', {code: 'KeyE'})
  expect(hint('Other instance')).toBe('a')
  expect(press(previous, 'a').defaultPrevented).toBe(true)
})

it.each(['', 'plaintext-only'])('leaves typing in contenteditable="%s" to the editor', mode => {
  const {shell, clicked} = setup({always: true})
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', mode)
  editor.tabIndex = 0
  shell.append(editor)
  expect(hint('First')).toBe('a')
  act(() => editor.focus())
  expect(press(editor, 'a').defaultPrevented).toBe(false)
  expect(clicked).not.toHaveBeenCalled()
})

it('offsets nested link badges and releases their styling when hints close', async () => {
  const {shell} = setup({always: true})
  const outer = screen.getByText('First')
  const inner = document.createElement('a')
  inner.href = '#inner'
  inner.textContent = 'Inner'
  outer.prepend(inner)
  await waitFor(() => expect(hint('Inner')).toBe('b'))
  expect(outer.getAttribute('data-vim-link-hint')).toBe('a')
  expect(inner.style.getPropertyValue('--vim-link-hint-depth')).toBe('1')
  press(shell, 'f')
  expect(inner.style.getPropertyValue('--vim-link-hint-depth')).toBe('')
})

it('labels three links with single letters while preserving the modified shortcut on the third letter', async () => {
  const shortcut = vi.fn()
  const {shell} = setup({always: true, actions: [
    {id: 'busy', context: normal, description: 'Busy letters', defaultBinding: {keys: '([^blmq])'}, handler: () => {}},
    {id: 'suffix', context: normal, description: 'Sequence suffix', defaultBinding: {keys: 'g Alt+l'}, handler: () => {}},
    {id: 'modified-m', context: global, description: 'Modified m', defaultBinding: {keys: 'Control+Shift+m'}, handler: shortcut},
  ]})
  const third = document.createElement('a')
  third.href = '#third'
  third.textContent = 'Third'
  const follow = vi.fn((event: MouseEvent) => event.preventDefault())
  third.addEventListener('click', follow)
  shell.querySelector('.block-content')!.append(third)
  await waitFor(() => expect(hint('Third')).toBe('m'))
  expect([hint('First'), hint('Second')]).toEqual(['b', 'q'])

  press(shell, 'M', {ctrlKey: true, shiftKey: true})
  expect(shortcut).toHaveBeenCalledOnce()
  expect(follow).not.toHaveBeenCalled()
  press(shell, 'm')
  press(shell, 'M', {shiftKey: true})
  expect(follow).toHaveBeenCalledTimes(2)
  expect(follow).toHaveBeenLastCalledWith(expect.objectContaining({shiftKey: true}))
})
