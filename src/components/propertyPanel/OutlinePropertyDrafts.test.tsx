// @vitest-environment happy-dom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import type {AnyResolvedPropertySchema} from '@/data/api'
import {PropertyDisplayScopeContext} from '@/context/propertyDisplay'
import {commitInlineProperty} from '@/data/inlineProperty'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {showError} from '@/utils/toast'
import {OutlinePropertyDrafts} from './OutlinePropertyDrafts'
import {outlinePropertySession} from './outlinePropertySession'

const fixture = vi.hoisted(() => ({ui: {} as Block, owner: undefined as unknown as Block, within: true}))
vi.mock('@/data/globalState', () => ({useUIStateBlock: () => fixture.ui}))
vi.mock('@/context/block', () => ({useBlockContext: () => ({renderScopeId: 'outline'})}))
vi.mock('@/hooks/focusedChild', () => ({
  useFocusWithin: () => fixture.within,
  focusIsWithin: () => fixture.within,
}))
vi.mock('@/hooks/propertySchemas', () => ({usePropertySchemas: () => new Map()}))
vi.mock('@/hooks/typeRegistry', () => ({useTypes: () => new Map()}))
vi.mock('@/hooks/block', () => ({
  useHandle: (handle: {peek: () => unknown}, options: {selector: (value: unknown) => unknown}) => options.selector(handle.peek()),
}))
vi.mock('@/utils/toast', () => ({showError: vi.fn()}))
vi.mock('./usePropertyEditingActivation', () => ({usePropertyEditingActivation: () => ({onFocus() {}, onBlur() {}})}))
vi.mock('@/data/inlineProperty', async importOriginal => ({...await importOriginal<object>(), commitInlineProperty: vi.fn()}))
vi.mock('@/extensions/blockInteraction', async importOriginal => ({...await importOriginal<object>(), enterEditModeForBlock: vi.fn()}))
vi.mock('@/data/properties', async importOriginal => ({...await importOriginal<object>(), focusBlock: vi.fn().mockResolvedValue(undefined)}))

const schema = {fieldId: 'definition', name: 'Priority'} as AnyResolvedPropertySchema
const childrenQuery = vi.fn(() => ({peek: () => []}))
const load = vi.fn().mockResolvedValue(undefined)
const owner = () => fixture.owner
const session = () => outlinePropertySession(fixture.ui, 'outline')
const input = () => screen.getByRole('textbox', {name: 'Value for Priority'})
const Host = ({mode = 'none'}: {mode?: 'none' | 'all'}) => <>
  <div data-block-id="owner"><PropertyDisplayScopeContext value={{childBacked: true, workspace: 'inherit', panel: 'inherit'}}>
    <OutlinePropertyDrafts owner={owner()} mode={mode} children={[]}/>
  </PropertyDisplayScopeContext></div><button>Elsewhere</button>
</>
const mount = (mode: 'none' | 'all' = 'none') => render(<Host mode={mode}/>)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(commitInlineProperty).mockReset()
  load.mockResolvedValue(undefined)
  fixture.within = true
  fixture.ui = {} as Block
  fixture.owner = {id: 'owner', peek: () => ({workspaceId: 'workspace', properties: {types: ['typed']}}), repo: {
    isReadOnly: false, query: {children: childrenQuery},
    propertySchemaResolverFor: () => ({resolve: () => ({status: 'missing'})}),
    block: (id: string) => id === 'owner' ? fixture.owner : {id, load},
  }} as unknown as Block
  fixture.ui = {repo: fixture.owner.repo} as Block
})
afterEach(cleanup)

describe('OutlinePropertyDrafts', () => {
  it('does not query structural children when ghost rows are disabled', () => {
    const view = mount('all')
    expect(childrenQuery).toHaveBeenCalled()
    view.unmount()
    childrenQuery.mockClear()
    mount('none')
    expect(childrenQuery).not.toHaveBeenCalled()
  })

  it('does not steal pointer focus while revealing a committed field under logical focus', async () => {
    let finish: (value: {fieldRowId: string; valueId: string}) => void = () => {}
    vi.mocked(commitInlineProperty).mockImplementation(() => new Promise(resolve => {finish = resolve}))
    session().add('owner', {schema})
    const reveal = vi.spyOn(session(), 'reveal')
    mount()
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    expect(commitInlineProperty).toHaveBeenCalledOnce()
    const outside = screen.getByRole('button', {name: 'Elsewhere'})
    fireEvent.pointerDown(outside)
    outside.focus()
    await act(async () => {finish({fieldRowId: 'field', valueId: 'value'})})
    expect(enterEditModeForBlock).not.toHaveBeenCalled()
    expect(reveal).toHaveBeenCalledExactlyOnceWith('owner', 'field')
    expect(document.activeElement).toBe(outside)
  })

  it.each([false, true])('uses current logical focus %s after a pending commit resolves', async within => {
    let finish: (value: {fieldRowId: string; valueId: string}) => void = () => {}
    vi.mocked(commitInlineProperty).mockImplementation(() => new Promise(resolve => {finish = resolve}))
    session().add('owner', {schema})
    session().setText(session().snapshot('owner').pending[0], '12')
    fixture.within = !within
    const reveal = vi.spyOn(session(), 'reveal')
    mount()
    act(() => input().focus())
    fireEvent.keyDown(input(), {key: 'Enter'})
    const outside = screen.getByRole('button', {name: 'Elsewhere'})
    outside.focus()
    fixture.within = within
    await act(async () => {finish({fieldRowId: 'field', valueId: 'value'})})
    expect(reveal.mock.calls).toEqual(within ? [['owner', 'field']] : [])
    expect(enterEditModeForBlock).not.toHaveBeenCalled()
  })

  it('expires each containing field after its draft finishes outside the owner', () => {
    session().add('owner', {schema, fieldRowId: 'first-field'})
    session().add('owner', {schema: {...schema, fieldId: 'second'}, fieldRowId: 'second-field'})
    session().setText(session().snapshot('first-field').pending[0], '12')
    session().setText(session().snapshot('second-field').pending[0], '13')
    fixture.within = false
    mount()
    expect(session().snapshot('owner').revealed).toEqual(['first-field', 'second-field'])
    act(() => session().remove('first-field', schema.fieldId))
    expect(session().snapshot('owner').revealed).toEqual(['second-field'])
    act(() => session().remove('second-field', 'second'))
    expect(session().snapshot('owner').revealed).toEqual([])
  })

  it('focuses the committed value after removing the pending row', async () => {
    vi.mocked(commitInlineProperty).mockResolvedValue({fieldRowId: 'field', valueId: 'value'})
    session().add('owner', {schema})
    mount()
    expect(document.activeElement).toBe(input())
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    await waitFor(() => expect(enterEditModeForBlock).toHaveBeenCalledOnce())
    expect(session().snapshot('owner').pending).toHaveLength(0)
    expect(session().snapshot('owner').revealed).toEqual(['field'])
  })

  it('does not refocus after a pointer gesture while the committed rows load', async () => {
    let finish = () => {}
    const pending = new Promise<void>(resolve => { finish = resolve })
    load.mockReturnValue(pending)
    vi.mocked(commitInlineProperty).mockResolvedValue({fieldRowId: 'field', valueId: 'value'})
    session().add('owner', {schema})
    const reveal = vi.spyOn(session(), 'reveal')
    mount()
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    await waitFor(() => expect(load).toHaveBeenCalled())
    const outside = screen.getByRole('button', {name: 'Elsewhere'})
    fireEvent.pointerDown(outside)
    outside.focus()
    await act(async () => { finish() })
    expect(enterEditModeForBlock).not.toHaveBeenCalled()
    expect(reveal).toHaveBeenCalledExactlyOnceWith('owner', 'field')
  })

  it('commits on blur without taking focus from the destination', async () => {
    vi.mocked(commitInlineProperty).mockResolvedValue({fieldRowId: 'field', valueId: 'value'})
    session().add('owner', {schema})
    const reveal = vi.spyOn(session(), 'reveal')
    mount()
    fireEvent.change(input(), {target: {value: '12'}})
    const outside = screen.getByRole('button', {name: 'Elsewhere'})
    await act(async () => { outside.focus() })
    expect(commitInlineProperty).toHaveBeenCalledOnce()
    expect(enterEditModeForBlock).not.toHaveBeenCalled()
    expect(reveal).toHaveBeenCalledExactlyOnceWith('owner', 'field')
    expect(document.activeElement).toBe(outside)
  })
})


it('submits on Escape and ignores repeat Escape while saving', async () => {
  let finish: (value: {fieldRowId: string; valueId: string}) => void = () => {}
  vi.mocked(commitInlineProperty).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  session().add('owner', {schema})
  const reveal = vi.spyOn(session(), 'reveal')
  mount()
  fireEvent.change(input(), {target: {value: '12'}})
  fireEvent.keyDown(input(), {key: 'Escape'})
  expect(commitInlineProperty).toHaveBeenCalledOnce()
  fireEvent.keyDown(input(), {key: 'Escape'})
  expect(commitInlineProperty).toHaveBeenCalledOnce()
  await act(async () => { finish({fieldRowId: 'field', valueId: 'value'}) })
  expect(reveal).toHaveBeenCalledExactlyOnceWith('owner', 'field')
  expect(enterEditModeForBlock).toHaveBeenCalledOnce()
  expect(session().snapshot('owner').pending).toEqual([])
})

it('preserves an invalid Escape submission for correction after logical focus leaves', async () => {
  vi.mocked(commitInlineProperty).mockRejectedValue(new Error('Enter a number'))
  session().add('owner', {schema})
  const view = mount()
  fireEvent.change(input(), {target: {value: 'invalid'}})
  await act(async () => { fireEvent.keyDown(input(), {key: 'Escape'}) })
  expect(commitInlineProperty).toHaveBeenCalledOnce()
  expect(showError).toHaveBeenCalledWith('Enter a number — Priority: "invalid"')
  expect(input()).toHaveValue('invalid')
  expect(input()).not.toHaveAttribute('readonly')
  fixture.within = false
  view.rerender(<Host/>)
  expect(input()).toHaveValue('invalid')
  expect(session().snapshot('owner').pending[0].text).toBe('invalid')
})

it('does not reveal or focus when the owner surface unmounts during a commit', async () => {
  let finish: (value: {fieldRowId: string; valueId: string}) => void = () => {}
  vi.mocked(commitInlineProperty).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  session().add('owner', {schema})
  const reveal = vi.spyOn(session(), 'reveal')
  const view = mount()
  fireEvent.change(input(), {target: {value: '12'}})
  fireEvent.keyDown(input(), {key: 'Enter'})
  expect(commitInlineProperty).toHaveBeenCalledOnce()
  view.unmount()
  await act(async () => { finish({fieldRowId: 'field', valueId: 'value'}) })
  expect(reveal).not.toHaveBeenCalled()
  expect(enterEditModeForBlock).not.toHaveBeenCalled()
})

it('wires pending ArrowDown to the drawn row in its own scope', async () => {
  session().add('owner', {schema})
  mount()
  const next = document.createElement('div')
  next.dataset.blockShell = 'true'
  next.dataset.blockId = 'next'
  next.dataset.renderScopeId = 'outline'
  const otherScope = next.cloneNode() as HTMLElement
  otherScope.dataset.blockId = 'other'
  otherScope.dataset.renderScopeId = 'another-outline'
  document.body.append(otherScope, next)
  try {
    fireEvent.keyDown(input(), {key: 'ArrowDown'})
    await waitFor(() => expect(enterEditModeForBlock).toHaveBeenCalledWith(
      expect.objectContaining({id: 'next'}), fixture.ui, 'outline', {start: 0}))
    expect(enterEditModeForBlock).toHaveBeenCalledOnce()
  } finally { next.remove(); otherScope.remove() }
})
