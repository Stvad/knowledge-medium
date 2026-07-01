// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import { valuePresetsFacet } from '@/data/facets.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { SelectPropertyEditor } from './SelectPropertyEditor'
import { resolvePropertyDisplay } from './defaults'
import { kernelValuePresetsExtension } from './kernelValuePresets'

const modeProp = defineProperty<'compact' | 'cozy'>('test:mode', {
  codec: codecs.enum([{value: 'compact', label: 'Compact'}, {value: 'cozy', label: 'Cozy'}]),
  defaultValue: 'compact',
  changeScope: ChangeScope.BlockDefault,
})

describe('SelectPropertyEditor', () => {
  it('renders an option per enum codec option and commits the picked value', async () => {
    const onChange = vi.fn()
    render(<SelectPropertyEditor value="compact" onChange={onChange} block={null} schema={modeProp} />)

    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect([...select.options].map(o => o.text)).toEqual(['Compact', 'Cozy'])
    expect(select.value).toBe('compact')

    await userEvent.selectOptions(select, 'cozy')
    expect(onChange).toHaveBeenCalledWith('cozy')
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
    const runtime = resolveFacetRuntimeSync(kernelValuePresetsExtension)
    const presets = runtime.read(valuePresetsFacet)

    const display = resolvePropertyDisplay({
      name: modeProp.name,
      encodedValue: 'compact',
      schemas: new Map([[modeProp.name, modeProp]]),
      uis: new Map(),
      presets,
    })

    expect(display.shape).toBe('enum')
    expect(display.Editor).toBe(SelectPropertyEditor)
  })
})
