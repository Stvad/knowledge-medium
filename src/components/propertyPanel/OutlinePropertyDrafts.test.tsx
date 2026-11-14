// @vitest-environment happy-dom
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import type {Block} from '@/data/block'
import type {AnyResolvedPropertySchema} from '@/data/api'
import {PropertyDisplayScopeContext} from '@/context/propertyDisplay'
import {commitInlineProperty} from '@/data/inlineProperty'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {OutlinePropertyDrafts} from './OutlinePropertyDrafts'
import {outlinePropertySession} from './outlinePropertySession'

const fixture = vi.hoisted(() => ({ui: {} as Block, owner: undefined as unknown as Block}))
vi.mock('@/data/globalState', () => ({useUIStateBlock: () => fixture.ui}))
vi.mock('@/context/block', () => ({useBlockContext: () => ({renderScopeId: 'outline'})}))
vi.mock('@/hooks/focusedChild', () => ({useFocusWithin: () => true}))
vi.mock('@/hooks/propertySchemas', () => ({usePropertySchemas: () => new Map()}))
vi.mock('@/hooks/typeRegistry', () => ({useTypes: () => new Map()}))
vi.mock('@/hooks/block', () => ({useHandle: (handle: {peek: () => unknown}) => handle.peek()}))
vi.mock('./usePropertyEditingActivation', () => ({usePropertyEditingActivation: () => ({onFocus() {}, onBlur() {}})}))
vi.mock('@/data/inlineProperty', async importOriginal => ({...await importOriginal<object>(), commitInlineProperty: vi.fn()}))
vi.mock('@/extensions/blockInteraction', () => ({enterEditModeForBlock: vi.fn()}))
vi.mock('@/data/properties', async importOriginal => ({...await importOriginal<object>(), focusBlock: vi.fn().mockResolvedValue(undefined)}))

const schema = {fieldId: 'definition', name: 'Priority'} as AnyResolvedPropertySchema
const childrenQuery = vi.fn(() => ({peek: () => []}))
const load = vi.fn().mockResolvedValue(undefined)
const owner = () => fixture.owner
const session = () => outlinePropertySession(fixture.ui, 'outline')
const input = () => screen.getByRole('textbox', {name: 'Value for Priority'})
const mount = (mode: 'none' | 'all' = 'none') => render(<>
  <div data-block-id="owner"><PropertyDisplayScopeContext value={{childBacked: true, workspace: 'inherit', panel: 'inherit'}}>
    <OutlinePropertyDrafts owner={owner()} mode={mode} children={[]}/>
  </PropertyDisplayScopeContext></div><button>Elsewhere</button>
</>)

beforeEach(() => {
  vi.clearAllMocks()
  fixture.ui = {} as Block
  fixture.owner = {id: 'owner', peek: () => ({workspaceId: 'workspace', properties: {}}), repo: {
    isReadOnly: false, query: {children: childrenQuery},
    propertySchemaResolverFor: () => ({resolve: () => ({status: 'missing'})}),
    block: (id: string) => id === 'owner' ? fixture.owner : {id, load},
  }} as unknown as Block
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

  it.each(['pointer', 'Escape'])('does not reveal or pull focus back after %s during commit', async gesture => {
    let finish: (value: {fieldRowId: string; valueId: string}) => void = () => {}
    vi.mocked(commitInlineProperty).mockImplementation(() => new Promise(resolve => {finish = resolve}))
    session().add('owner', {schema})
    const reveal = vi.spyOn(session(), 'reveal')
    mount()
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    expect(commitInlineProperty).toHaveBeenCalledOnce()
    const outside = screen.getByRole('button', {name: 'Elsewhere'})
    if (gesture === 'Escape') fireEvent.keyDown(input(), {key: 'Escape'})
    else fireEvent.pointerDown(outside)
    outside.focus()
    await act(async () => {finish({fieldRowId: 'field', valueId: 'value'})})
    expect(enterEditModeForBlock).not.toHaveBeenCalled()
    expect(reveal).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(outside)
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
    expect(reveal).not.toHaveBeenCalled()
    load.mockResolvedValue(undefined)
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
    expect(reveal).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(outside)
  })
})


it('cancels the pending continuation on Escape without moving focus', async () => {
  let finish: (value: {fieldRowId: string; valueId: string}) => void = () => {}
  vi.mocked(commitInlineProperty).mockImplementation(() => new Promise(resolve => { finish = resolve }))
  session().add('owner', {schema})
  const reveal = vi.spyOn(session(), 'reveal')
  mount()
  fireEvent.change(input(), {target: {value: '12'}})
  fireEvent.keyDown(input(), {key: 'Enter'})
  expect(commitInlineProperty).toHaveBeenCalledOnce()
  fireEvent.keyDown(input(), {key: 'Escape'})
  await act(async () => { finish({fieldRowId: 'field', valueId: 'value'}) })
  expect(reveal).not.toHaveBeenCalled()
  expect(enterEditModeForBlock).not.toHaveBeenCalled()
})

it('cancels the pending continuation when the owner unmounts', async () => {
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
