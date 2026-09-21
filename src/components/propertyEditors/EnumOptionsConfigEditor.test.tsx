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

  it('carries a pending edit into a removal, as ONE write', async () => {
    // Clicking the button blurs the input being typed in, so the naive pair
    // is two writes from one action — and the second is judged against a
    // definition row the first has already changed, which the gesture's
    // staleness check refuses. One write, from the draft.
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EnumOptionsConfigEditor value={{options: [
      {value: 'open', label: 'Open'},
      {value: 'done', label: 'Done'},
    ]}} onChange={onChange} />)

    await user.type(screen.getByLabelText('Choice 1 value'), 'x')
    await user.click(screen.getByRole('button', {name: 'Remove choice 2'}))

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenLastCalledWith({options: [{value: 'openx', label: 'Open'}]})
  })

  it('does not take the focus from the input being typed in', async () => {
    // How the single write above is achieved, and why nothing has to be
    // remembered between the press and the click: with no blur there is no
    // commit to suppress, so a press dragged away or cancelled leaves no
    // state behind that could swallow the edit later.
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EnumOptionsConfigEditor
      value={{options: [{value: 'open', label: 'Open'}]}} onChange={onChange} />)
    const input = screen.getByLabelText('Choice 1 value')
    await user.type(input, 'x')

    await user.click(screen.getByRole('button', {name: 'Add choice'}))

    expect(document.activeElement).toBe(input)
  })

  it('keeps the field being typed in when its own earlier write comes back', async () => {
    // A write is planned, counted, sometimes confirmed and only then
    // committed, so the props describe the old value for as long as that
    // takes — long enough to tab into the next field and start typing. The
    // acknowledgement arriving then must not replace the draft with its own
    // snapshot and erase what is being entered.
    const user = userEvent.setup()
    const onChange = vi.fn()
    const {rerender} = render(<EnumOptionsConfigEditor value={{options: [
      {value: 'open', label: 'Open'},
      {value: 'done', label: 'Done'},
    ]}} onChange={onChange} />)

    await user.type(screen.getByLabelText('Choice 1 value'), 'x')
    await user.tab()
    expect(onChange).toHaveBeenLastCalledWith({options: [
      {value: 'openx', label: 'Open'}, {value: 'done', label: 'Done'},
    ]})
    await user.type(screen.getByLabelText('Choice 1 label'), '!')
    // The first write lands only now.
    rerender(<EnumOptionsConfigEditor value={{options: [
      {value: 'openx', label: 'Open'},
      {value: 'done', label: 'Done'},
    ]}} onChange={onChange} />)

    expect((screen.getByLabelText('Choice 1 label') as HTMLInputElement).value).toBe('Open!')
    await user.tab()
    expect(onChange).toHaveBeenLastCalledWith({options: [
      {value: 'openx', label: 'Open!'}, {value: 'done', label: 'Done'},
    ]})
  })

  it('does not write again when a confirmation steals the focus it kept', async () => {
    // A structural change big enough to be confirmed mounts a focus trap,
    // which blurs the input this editor had just declined to blur. The
    // commit behind that blur would queue a second change putting back the
    // choice the first one removed.
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<EnumOptionsConfigEditor value={{options: [
      {value: 'open', label: 'Open'},
      {value: 'done', label: 'Done'},
    ]}} onChange={onChange} />)

    await user.type(screen.getByLabelText('Choice 1 value'), 'x')
    await user.click(screen.getByRole('button', {name: 'Remove choice 2'}))
    // What the dialog's focus trap does to the input that still has focus.
    fireEvent.blur(screen.getByLabelText('Choice 1 value'))

    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenLastCalledWith({options: [{value: 'openx', label: 'Open'}]})
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
