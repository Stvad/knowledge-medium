// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { SelectPropertyEditor } from './SelectPropertyEditor'
import { resolvePropertyDisplay } from './defaults'
import { kernelValuePresetsExtension } from './kernelValuePresets'
import {readValuePresets} from '@/data/valuePresetRegistry'
import {kernelDataExtension} from '@/data/kernelDataExtension'

// The real hook needs the shortcut provider chain (useRepo / uiStateBlock /
// useActiveContextsDispatch); this file only needs to prove the `<select>` is
// wired to it. The dispatch side is covered in
// src/shortcuts/test/propertyEditingEscape.test.tsx.
const activation = {onFocus: vi.fn(), onBlur: vi.fn()}
vi.mock('@/components/propertyPanel/usePropertyEditingActivation.js', () => ({
  usePropertyEditingActivation: () => activation,
}))

const modeProp = defineProperty<'compact' | 'cozy'>('test:mode', {
  codec: codecs.enum([{value: 'compact', label: 'Compact'}, {value: 'cozy', label: 'Cozy'}]),
  defaultValue: 'compact',
  changeScope: ChangeScope.BlockDefault,
})

describe('SelectPropertyEditor', () => {
  beforeEach(() => {
    activation.onFocus.mockClear()
    activation.onBlur.mockClear()
  })

  it('renders an option per enum codec option and commits the picked value', async () => {
    const onChange = vi.fn()
    render(<SelectPropertyEditor value="compact" onChange={onChange} block={null} schema={modeProp} />)

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect([...select.options].map(o => o.text)).toEqual(['Compact', 'Cozy'])
    expect(select.value).toBe('compact')

    await userEvent.selectOptions(select, 'cozy')
    expect(onChange).toHaveBeenCalledWith('cozy')
  })

  it('activates the property-editing context while focused, so Escape can exit', () => {
    // Without this the `<select>` is the one property shape where the
    // reported bug survives: `PROPERTY_EDITING` never activates, so
    // `exit_property_editing` isn't even a dispatch candidate.
    const onChange = vi.fn()
    render(<SelectPropertyEditor value="compact" onChange={onChange} block={null} schema={modeProp} />)

    const select = screen.getByRole('combobox')
    fireEvent.focus(select)
    expect(activation.onFocus).toHaveBeenCalledTimes(1)

    fireEvent.blur(select)
    expect(activation.onBlur).toHaveBeenCalledTimes(1)
  })

  it('surfaces a stored value that is no longer a valid option', () => {
    const onChange = vi.fn()
    render(<SelectPropertyEditor value="archived" onChange={onChange} block={null} schema={modeProp} />)

    const select = screen.getByRole('combobox') as HTMLSelectElement
    // The stale value renders (selected) instead of silently snapping to
    // the first option, so the user can pick a valid replacement.
    expect(select.value).toBe('archived')
    expect([...select.options].map(o => o.value)).toContain('archived')
  })

  it('renders a placeholder option for an unset value so the select stays controlled', () => {
    const onChange = vi.fn()
    render(<SelectPropertyEditor value="" onChange={onChange} block={null} schema={modeProp} />)

    // A controlled <select value=""> must have a matching option, or the
    // browser shows option 0 while the value stays '' (and React warns).
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
    expect([...select.options].map(o => o.value)).toContain('')
  })
})

describe('enum preset wiring', () => {
  it('resolves an enum-codec property to the SelectPropertyEditor', () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension, kernelValuePresetsExtension])
    const presets = readValuePresets(runtime)

    const display = resolvePropertyDisplay({
      name: modeProp.name,
      encodedValue: 'compact',
      schemas: new Map([[modeProp.name, modeProp]]),
      override: undefined,
      presets,
    })

    expect(display.shape).toBe('enum')
    expect(display.Editor).toBe(SelectPropertyEditor)
  })
})
