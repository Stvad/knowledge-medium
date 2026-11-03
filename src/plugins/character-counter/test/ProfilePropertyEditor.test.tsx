// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import { builtinCountProfiles, characterCountProfilesFacet } from '../profiles'
import { ProfilePropertyEditor } from '../ProfilePropertyEditor'

// The real hook needs the shortcut provider chain; its wiring is covered in
// SelectPropertyEditor.test.tsx.
vi.mock('@/components/propertyPanel/usePropertyEditingActivation.js', () => ({
  usePropertyEditingActivation: () => ({onFocus: () => {}, onBlur: () => {}}),
}))

const useNoCount = (): number => 0
const runtime = resolveFacetRuntimeSync([
  ...builtinCountProfiles,
  characterCountProfilesFacet.of({id: 'platform', label: 'Platform', useCount: useNoCount}, {source: 'test'}),
])

afterEach(cleanup)

const renderEditor = (value: string | undefined, onChange = vi.fn()) => {
  render(
    <AppRuntimeContextProvider value={runtime}>
      <ProfilePropertyEditor value={value} onChange={onChange} block={null}/>
    </AppRuntimeContextProvider>,
  )
  return {select: screen.getByRole('combobox') as HTMLSelectElement, onChange}
}

describe('ProfilePropertyEditor', () => {
  it('offers every registered profile, including ones other plugins add', () => {
    const {select} = renderEditor(undefined)
    expect([...select.options].map(option => option.textContent))
      .toEqual(['Characters', 'Words', 'Platform'])
  })

  it('shows an unset profile as the raw character count it falls back to', () => {
    expect(renderEditor(undefined).select.value).toBe('raw')
  })

  it('writes the chosen profile id', () => {
    const {select, onChange} = renderEditor(undefined)
    fireEvent.change(select, {target: {value: 'words'}})
    expect(onChange).toHaveBeenCalledWith('words')
  })
})
