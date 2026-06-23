import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import { SelectPropertyEditor } from './SelectPropertyEditor'

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
})
