// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {ChangeScope} from '@/data/api'
import { propertyEditorOverridesFacet, valuePresetCoresFacet, valuePresetPresentationsFacet } from '@/data/facets.js'
import type { Block } from '@/data/block'
import {buildPropertyDefinitionRegistry} from '@/data/propertyDefinitionRegistry'
import {seedProperty} from '@/data/propertySeeds'
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
const pickerBlock = (propertyDefinitions: Block['repo']['propertyDefinitions'] = null) => ({
  repo: {propertyDefinitions},
}) as Block
// Read the highlighted option from the input's aria-activedescendant rather than
// the rendered listbox: the input attribute updates synchronously with state,
// whereas FloatingListbox mounts its options asynchronously (floating-ui
// computePosition), which is racy to assert on directly.
const activeOption = () =>
  screen.getByPlaceholderText('Field').getAttribute('aria-activedescendant') ?? ''

beforeEach(() => {
  store.schemas = new Map([['apple', schema('apple')], ['apricot', schema('apricot')]])
  store.byFacetId = new Map<string, unknown>([
    // Mirror the runtime shape: the picker reads the joined registry
    // (cores ⋈ presentations by id), so seed both facets. This test asserts
    // suggestion navigation/reset, not preset display, so the preset contents
    // aren't what's under test.
    [valuePresetCoresFacet.id, new Map([['string', {id: 'string', build: () => ({type: 'string'}), defaultValue: ''}]])],
    [valuePresetPresentationsFacet.id, new Map([['string', {id: 'string', label: 'Text', Glyph: () => null}]])],
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
        block={pickerBlock()}
      />,
    )
    const input = screen.getByPlaceholderText('Field')

    // Open suggestions and arrow down to the 2nd row.
    fireEvent.change(input, {target: {value: 'ap'}})
    expect(activeOption()).toMatch(/-option-0$/) // apple, index 0
    fireEvent.keyDown(input, {key: 'ArrowDown'})
    expect(activeOption()).toMatch(/-option-1$/) // apricot, index 1

    // Commit it (Enter) → submit() → onAdd → reset(). Wait for reset to settle
    // (input cleared) before reopening, so focus can't race the async close that
    // reset() performs — otherwise a late reset() would re-close the list.
    await act(async () => { fireEvent.keyDown(input, {key: 'Enter'}) })
    expect(onAdd).toHaveBeenCalledTimes(1)
    await waitFor(() => expect((input as HTMLInputElement).value).toBe(''))

    // Reopen WITHOUT typing — onFocus does not reset the index, so this only
    // passes if reset() already cleared it. Highlight must be back at the top.
    fireEvent.focus(input)
    expect(activeOption()).toMatch(/-option-0$/)
  })

  it('does not suggest, submit, or configure a hidden seed when bound or at stage 0', async () => {
    const hidden = seedProperty({
      seedKey: 'plugin:test/property/secret',
      revision: 1,
      name: 'secret',
      preset: 'string',
      changeScope: ChangeScope.BlockDefault,
      hidden: true,
    })
    const snapshot = buildPropertyDefinitionRegistry({
      workspaceId: 'ws',
      legacySchemas: new Map(),
      projectedDefinitions: new Map(),
      seeds: [hidden],
    })
    store.schemas = new Map(snapshot.schemas)
    for (const definitions of [snapshot, null]) {
      const onAdd = vi.fn()
      const onConfigureNewSchema = vi.fn()
      const view = render(
        <PropertyPicker
          onAdd={onAdd}
          onConfigureNewSchema={onConfigureNewSchema}
          block={pickerBlock(definitions)}
        />,
      )

      const input = screen.getByPlaceholderText('Field')
      fireEvent.change(input, {target: {value: hidden.name}})
      // itemCount=0 is reflected synchronously even though FloatingListbox
      // itself mounts asynchronously.
      expect(input.getAttribute('aria-activedescendant')).toBeNull()
      fireEvent.keyDown(input, {key: 'Enter'})
      fireEvent.click(screen.getByRole('button', {name: 'Configure New field'}))

      expect(onAdd).not.toHaveBeenCalled()
      expect(onConfigureNewSchema).not.toHaveBeenCalled()
      view.unmount()
    }
  })
})
