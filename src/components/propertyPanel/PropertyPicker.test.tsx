// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { propertyEditorOverridesFacet, valuePresetsFacet } from '@/data/facets.js'
import type { Block } from '@/data/block'
import { PropertyPicker } from './PropertyPicker.tsx'

const store = vi.hoisted(() => ({
  byFacetId: new Map<string, unknown>(),
  schemas: new Map<string, unknown>(),
}))

vi.mock('@/extensions/runtimeContext.ts', () => ({
  useAppRuntime: () => ({read: (facet: {id: string}) => store.byFacetId.get(facet.id) ?? new Map()}),
}))
vi.mock('@/hooks/propertySchemas.ts', () => ({
  usePropertySchemas: () => store.schemas,
}))
vi.mock('./usePropertyEditingActivation', () => ({
  usePropertyEditingActivation: () => ({onFocus: () => {}, onBlur: () => {}}),
}))

const schema = (name: string) => ({name, codec: {type: 'string'}})
const activeText = () => screen.queryByRole('option', {selected: true})?.textContent ?? ''

beforeEach(() => {
  store.schemas = new Map([['apple', schema('apple')], ['apricot', schema('apricot')]])
  store.byFacetId = new Map<string, unknown>([
    [valuePresetsFacet.id, new Map([['string', {id: 'string', label: 'Text', Glyph: () => null}]])],
    [propertyEditorOverridesFacet.id, new Map()],
  ])
})

describe('PropertyPicker', () => {
  // Guards the regression Codex flagged: the picker stays mounted after submit()
  // (BlockTypeBlockRenderer), so reset() must clear the listbox's activeIndex —
  // otherwise the next property's suggestions open on a stale highlight.
  it('resets the highlighted suggestion after submit so the next session starts at the top', async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined)
    render(
      <PropertyPicker
        onAdd={onAdd}
        onConfigureNewSchema={vi.fn().mockResolvedValue(undefined)}
        block={{} as Block}
      />,
    )
    const input = screen.getByPlaceholderText('Field')

    // Open suggestions and arrow down to the 2nd row.
    fireEvent.change(input, {target: {value: 'ap'}})
    expect(activeText()).toContain('apple') // index 0
    fireEvent.keyDown(input, {key: 'ArrowDown'})
    expect(activeText()).toContain('apricot') // index 1

    // Commit it (Enter) → submit() → onAdd → reset(). Wait for reset to settle
    // (input cleared) before reopening, so focus can't race the async close that
    // reset() performs — otherwise a late reset() would re-close the list.
    await act(async () => { fireEvent.keyDown(input, {key: 'Enter'}) })
    expect(onAdd).toHaveBeenCalledTimes(1)
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))

    // Reopen WITHOUT typing — onFocus does not reset the index, so this only
    // passes if reset() already cleared it. Highlight must be back at the top.
    fireEvent.focus(input)
    await waitFor(() => expect(activeText()).toContain('apple'))
    expect(activeText()).not.toContain('apricot')
  })
})
