// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Block } from '@/data/block'
import type { AnyPropertySchema } from '@/data/api'
import { propertyEditorOverridesFacet, valuePresetCoresFacet, valuePresetPresentationsFacet } from '@/data/facets'
import { resolveEditModeKeepalive } from '@/components/editModeKeepalive'
import { showError } from '@/utils/toast'
import { InlinePropertyPicker } from './InlinePropertyPicker'

const store = vi.hoisted(() => ({
  byFacetId: new Map<string, unknown>(),
  schemas: new Map<string, AnyPropertySchema>(),
}))
vi.mock('@/extensions/runtimeContext.ts', () => ({
  useAppRuntime: () => ({read: (facet: {id: string}) => store.byFacetId.get(facet.id) ?? new Map()}),
}))
vi.mock('@/hooks/propertySchemas.ts', () => ({usePropertySchemas: () => store.schemas}))
vi.mock('./usePropertyEditingActivation', async importOriginal => ({
  ...await importOriginal<object>(),
  usePropertyEditingActivation: () => ({onFocus: () => {}, onBlur: () => {}}),
}))
vi.mock('@/utils/toast', () => ({showError: vi.fn()}))

const schema = {name: 'status', codec: {type: 'string'}} as AnyPropertySchema
const addSchema = vi.fn()
const owner = {repo: {
  propertyDefinitions: null,
  get propertySchemas() { return store.schemas },
  userSchemas: {addSchema},
}} as unknown as Block

beforeEach(() => {
  addSchema.mockReset()
  vi.mocked(showError).mockClear()
  store.schemas = new Map([[schema.name, schema]])
  store.byFacetId = new Map<string, unknown>([
    [valuePresetCoresFacet.id, new Map([['string', {id: 'string', build: () => ({type: 'string'}), defaultValue: ''}]])],
    [valuePresetPresentationsFacet.id, new Map([['string', {id: 'string', label: 'Text', Glyph: () => null}]])],
    [propertyEditorOverridesFacet.id, new Map()],
  ])
})
afterEach(cleanup)

const typeAndSubmit = async (name: string) => {
  const input = screen.getByPlaceholderText('Property name')
  fireEvent.change(input, {target: {value: name}})
  await act(async () => { fireEvent.keyDown(input, {key: 'Enter'}) })
}

describe('InlinePropertyPicker', () => {
  it('adopts an existing definition without creating a schema', async () => {
    const onPick = vi.fn()
    render(<InlinePropertyPicker owner={owner} onPick={onPick} onCancel={vi.fn()}/>)
    await typeAndSubmit('status')
    expect(onPick).toHaveBeenCalledWith(schema)
    expect(addSchema).not.toHaveBeenCalled()
  })

  it('creates an unmatched name through the schema service and picks its result', async () => {
    const created = {name: 'new field', codec: {type: 'string'}} as AnyPropertySchema
    addSchema.mockResolvedValue(created)
    const onPick = vi.fn()
    render(<InlinePropertyPicker owner={owner} onPick={onPick} onCancel={vi.fn()}/>)
    await typeAndSubmit('new field')
    expect(addSchema).toHaveBeenCalledWith({name: 'new field', presetId: 'string'})
    expect(onPick).toHaveBeenCalledWith(created)
  })

  it('cancels without creating a definition or selecting one and releases the editor hold', () => {
    const onPick = vi.fn()
    const onCancel = vi.fn()
    const view = render(<InlinePropertyPicker owner={owner} onPick={onPick} onCancel={onCancel}/>)
    expect(resolveEditModeKeepalive()).toBe('yield')
    const input = screen.getByPlaceholderText('Property name')
    fireEvent.focus(input)
    fireEvent.keyDown(input, {key: 'Escape'})
    fireEvent.keyDown(input, {key: 'Escape'})
    expect(onCancel).toHaveBeenCalledOnce()
    expect(addSchema).not.toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
    view.unmount()
    expect(resolveEditModeKeepalive()).toBe('exit')
  })

  it('refuses before creating a definition when the source text changed', async () => {
    const onPick = vi.fn()
    render(<InlinePropertyPicker owner={owner} onPick={onPick} onCancel={vi.fn()} canSubmit={() => false}/>)
    await typeAndSubmit('new field')
    expect(addSchema).not.toHaveBeenCalled()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('refuses an existing definition when the source text changed', async () => {
    const onPick = vi.fn()
    render(<InlinePropertyPicker owner={owner} onPick={onPick} onCancel={vi.fn()} canSubmit={() => false}/>)
    await typeAndSubmit('status')
    expect(onPick).not.toHaveBeenCalled()
  })

  it('refuses glyph configuration before creating a definition when the source text changed', async () => {
    render(<InlinePropertyPicker owner={owner} onPick={vi.fn()} onCancel={vi.fn()} canSubmit={() => false}/>)
    fireEvent.change(screen.getByPlaceholderText('Property name'), {target: {value: 'new field'}})
    await act(async () => { fireEvent.click(screen.getByRole('button', {name: 'Configure New field'})) })
    expect(addSchema).not.toHaveBeenCalled()
  })

  it('does not select a schema that finishes creating after cancellation', async () => {
    let finish: (schema: AnyPropertySchema) => void = () => {}
    addSchema.mockImplementation(() => new Promise<AnyPropertySchema>(resolve => { finish = resolve }))
    const onPick = vi.fn()
    const onCancel = vi.fn()
    render(<InlinePropertyPicker owner={owner} onPick={onPick} onCancel={onCancel}/>)
    const input = screen.getByPlaceholderText('Property name')
    fireEvent.change(input, {target: {value: 'new field'}})
    fireEvent.keyDown(input, {key: 'Enter'})
    expect(addSchema).toHaveBeenCalledOnce()
    fireEvent.keyDown(input, {key: 'Escape'})
    expect(onCancel).toHaveBeenCalledOnce()
    await act(async () => { finish(schema) })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('does not select a schema that finishes creating after unmount', async () => {
    let finish: (schema: AnyPropertySchema) => void = () => {}
    addSchema.mockImplementation(() => new Promise<AnyPropertySchema>(resolve => { finish = resolve }))
    const onPick = vi.fn()
    const view = render(<InlinePropertyPicker owner={owner} onPick={onPick} onCancel={vi.fn()}/>)
    const input = screen.getByPlaceholderText('Property name')
    fireEvent.change(input, {target: {value: 'new field'}})
    fireEvent.keyDown(input, {key: 'Enter'})
    expect(addSchema).toHaveBeenCalledOnce()
    view.unmount()
    await act(async () => { finish(schema) })
    expect(onPick).not.toHaveBeenCalled()
  })

  it('reports a refused name without selecting it', async () => {
    addSchema.mockRejectedValue(new Error('Name cannot be a reference'))
    const onPick = vi.fn()
    render(<InlinePropertyPicker owner={owner} onPick={onPick} onCancel={vi.fn()}/>)
    await typeAndSubmit('::[[name]]')
    expect(showError).toHaveBeenCalledWith('Name cannot be a reference')
    expect(onPick).not.toHaveBeenCalled()
  })
})
