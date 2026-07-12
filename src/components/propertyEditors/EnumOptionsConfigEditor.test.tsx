// @vitest-environment jsdom
import {fireEvent, render, screen} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {describe, expect, it, vi} from 'vitest'
import {EnumOptionsConfigEditor} from './EnumOptionsConfigEditor'

describe('EnumOptionsConfigEditor', () => {
  it('emits immutable option edits, additions, and removals', async () => {
    const user = userEvent.setup()
    const original = {options: [{value: 'open', label: 'Open'}]}
    const onChange = vi.fn()
    const {rerender} = render(<EnumOptionsConfigEditor value={original} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('Choice 1 value'), {target: {value: 'todo'}})
    expect(onChange).toHaveBeenLastCalledWith({options: [{value: 'todo', label: 'Open'}]})
    expect(original).toEqual({options: [{value: 'open', label: 'Open'}]})

    rerender(<EnumOptionsConfigEditor value={{options: [{value: 'todo', label: 'Open'}]}} onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Choice 1 label'), {target: {value: 'To do'}})
    expect(onChange).toHaveBeenLastCalledWith({options: [{value: 'todo', label: 'To do'}]})

    rerender(<EnumOptionsConfigEditor value={{options: [{value: 'todo', label: 'To do'}]}} onChange={onChange} />)
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
})
