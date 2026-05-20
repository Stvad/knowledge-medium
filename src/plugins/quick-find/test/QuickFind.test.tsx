import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QuickFind } from '../QuickFind.tsx'

afterEach(() => {
  cleanup()
})

describe('QuickFind mount', () => {
  it('stays inert while closed so startup does not resolve dialog state', () => {
    const {container} = render(<QuickFind/>)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByRole('dialog', {name: 'Quick find'})).not.toBeInTheDocument()
  })
})
