// @vitest-environment happy-dom
import {cleanup, fireEvent, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {EnumOptionsConfigEditor} from './EnumOptionsConfigEditor'

afterEach(cleanup)

describe('EnumOptionsConfigEditor', () => {
  it('commits a text edit once, when the field is left', async () => {
    // Every `onChange` is a write to the definition row, and every such write
    // fans out to each block using the property inside the same transaction.
    // Per keystroke that is one fan-out per character — and on a property big
    // enough to be worth confirming, one modal per character (#1112).
    const user = userEvent.setup()
    const original = {options: [{value: 'open', label: 'Open'}]}
    const onChange = vi.fn()
    render(<EnumOptionsConfigEditor value={original} onChange={onChange} />)

    await user.type(screen.getByLabelText('Choice 1 value'), 'x')

    expect(onChange).not.toHaveBeenCalled()
    // The character IS in the field — it is held, not dropped.
    expect((screen.getByLabelText('Choice 1 value') as HTMLInputElement).value).toBe('openx')

    await user.tab()

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenLastCalledWith({options: [{value: 'openx', label: 'Open'}]})
    expect(original).toEqual({options: [{value: 'open', label: 'Open'}]})
  })

  it('writes nothing for a field that was only passed through', async () => {
    // Tabbing across the editor must not fan out. Without this, moving the
    // caret through a big property's options costs a transaction per field.
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EnumOptionsConfigEditor
      value={{options: [{value: 'open', label: 'Open'}]}} onChange={onChange} />)

    await user.click(screen.getByLabelText('Choice 1 value'))
    await user.tab()
    await user.tab()

    expect(onChange).not.toHaveBeenCalled()
  })

  it('adds and removes a choice as one act, immediately', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const {rerender} = render(<EnumOptionsConfigEditor
      value={{options: [{value: 'todo', label: 'To do'}]}} onChange={onChange} />)

    await user.click(screen.getByRole('button', {name: 'Add choice'}))
    expect(onChange).toHaveBeenLastCalledWith({
      options: [{value: 'todo', label: 'To do'}, {value: '', label: ''}],
    })

    rerender(<EnumOptionsConfigEditor value={{options: [
      {value: 'todo', label: 'Open'},
      {value: 'done', label: 'Done'},
    ]}} onChange={onChange} />)
    await user.click(screen.getByRole('button', {name: 'Remove choice 1'}))
    expect(onChange).toHaveBeenLastCalledWith({options: [{value: 'done', label: 'Done'}]})
  })

  it('adopts a committed change that lands under an open draft', async () => {
    // A peer edit, an undo, or a preset switch that resets the config. The
    // same trade the name field records: the committed value wins over a
    // stale draft rather than being overwritten by it on the next blur.
    const onChange = vi.fn()
    const {rerender} = render(<EnumOptionsConfigEditor
      value={{options: [{value: 'open', label: 'Open'}]}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Choice 1 value'), {target: {value: 'mine'}})

    rerender(<EnumOptionsConfigEditor
      value={{options: [{value: 'theirs', label: 'Theirs'}]}} onChange={onChange} />)

    expect((screen.getByLabelText('Choice 1 value') as HTMLInputElement).value).toBe('theirs')
    fireEvent.blur(screen.getByLabelText('Choice 1 value'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
