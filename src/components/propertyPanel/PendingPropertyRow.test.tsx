// @vitest-environment happy-dom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react'
import type {Block} from '@/data/block'
import type {AnyPropertySchema} from '@/data/api'
import {showError} from '@/utils/toast'
import {PendingPropertyRow} from './PendingPropertyRow'

vi.mock('./usePropertyEditingActivation', () => ({
  usePropertyEditingActivation: () => ({onFocus: () => {}, onBlur: () => {}}),
}))
vi.mock('@/utils/toast', () => ({showError: vi.fn()}))

const owner = {} as Block
const schema = {name: 'Priority', codec: {type: 'optional-number'}} as AnyPropertySchema
const input = () => screen.getByRole('textbox', {name: 'Value for Priority'})
beforeEach(() => vi.mocked(showError).mockClear())
afterEach(cleanup)

describe('PendingPropertyRow', () => {
  it('renders a draft without a structural block identity or committing a value', () => {
    const onCommit = vi.fn()
    const view = render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={vi.fn()}/>)
    expect(input()).toHaveValue('')
    expect(view.container.querySelector('[data-block-id], [data-block-shell], [data-lazy-block-id]')).toBeNull()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it.each(['Enter', 'blur'])('abandons an empty draft on %s without a write', async gesture => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={onCancel}/>)
    await act(async () => {
      if (gesture === 'blur') fireEvent.blur(input())
      else fireEvent.keyDown(input(), {key: 'Enter'})
    })
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it.each(['Enter', 'blur'])('submits the draft on %s', async gesture => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={vi.fn()}/>)
    fireEvent.change(input(), {target: {value: '12'}})
    await act(async () => {
      if (gesture === 'blur') fireEvent.blur(input())
      else fireEvent.keyDown(input(), {key: 'Enter'})
    })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('12')
  })

  it('reports a rejected value and keeps the draft available to correct', async () => {
    const onCommit = vi.fn().mockRejectedValue(new Error('Enter a number'))
    const onCancel = vi.fn()
    render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={onCancel}/>)
    fireEvent.change(input(), {target: {value: 'abc'}})
    await act(async () => { fireEvent.keyDown(input(), {key: 'Enter'}) })
    expect(showError).toHaveBeenCalledWith('Enter a number')
    expect(input()).toHaveValue('abc')
    expect(onCancel).not.toHaveBeenCalled()
    onCommit.mockResolvedValue(undefined)
    fireEvent.change(input(), {target: {value: '13'}})
    await act(async () => { fireEvent.keyDown(input(), {key: 'Enter'}) })
    expect(onCommit).toHaveBeenLastCalledWith('13')
  })

  it('does not submit twice when blur follows Enter while the commit is pending', async () => {
    let finish = () => {}
    const onCommit = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={vi.fn()}/>)
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    expect(input()).toHaveAttribute('readonly')
    fireEvent.blur(input())
    expect(onCommit).toHaveBeenCalledOnce()
    await act(async () => { finish() })
    fireEvent.blur(input())
    expect(onCommit).toHaveBeenCalledOnce()
  })

  it('Escape abandons a nonempty draft and the following blur cannot submit it', async () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    const onOutlineKey = vi.fn()
    render(<div onKeyDown={onOutlineKey}><PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={onCancel}/></div>)
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Escape'})
    fireEvent.blur(input())
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onCommit).not.toHaveBeenCalled()
    expect(onOutlineKey).not.toHaveBeenCalled()
  })

  it('does not commit Enter during IME composition', () => {
    const onCommit = vi.fn()
    render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={vi.fn()}/>)
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter', isComposing: true})
    expect(onCommit).not.toHaveBeenCalled()
  })

  it.each(['blur', 'Escape'])('can edit an expected ghost again after cancelling with %s', async gesture => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={vi.fn()}/>)
    fireEvent.focus(input())
    if (gesture === 'blur') fireEvent.blur(input())
    else {
      fireEvent.change(input(), {target: {value: 'abandoned'}})
      fireEvent.keyDown(input(), {key: 'Escape'})
      fireEvent.blur(input())
    }
    fireEvent.focus(input())
    expect(input()).toHaveValue('')
    fireEvent.change(input(), {target: {value: '14'}})
    await act(async () => { fireEvent.keyDown(input(), {key: 'Enter'}) })
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('14')
  })

  it('forwards Up and Down without exposing them to outline block gestures', () => {
    const onNavigate = vi.fn()
    const onOutlineKey = vi.fn()
    render(<div onKeyDown={onOutlineKey}><PendingPropertyRow owner={owner} schema={schema} onCommit={vi.fn()} onCancel={vi.fn()} onNavigate={onNavigate}/></div>)
    fireEvent.keyDown(input(), {key: 'ArrowUp'})
    fireEvent.keyDown(input(), {key: 'ArrowDown'})
    expect(onNavigate.mock.calls).toEqual([[-1], [1]])
    expect(onOutlineKey).not.toHaveBeenCalled()
  })

  it('does not refocus or report a rejected commit after cancellation', async () => {
    let reject: (reason: Error) => void = () => {}
    const onCommit = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const onCancel = vi.fn()
    render(<><PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={onCancel}/><button>Elsewhere</button></>)
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    fireEvent.keyDown(input(), {key: 'Escape'})
    const elsewhere = screen.getByRole('button', {name: 'Elsewhere'})
    elsewhere.focus()
    await act(async () => { reject(new Error('Late error')) })
    expect(document.activeElement).toBe(elsewhere)
    expect(showError).not.toHaveBeenCalled()
  })

  it('does not report a rejected commit after the draft unmounts', async () => {
    let reject: (reason: Error) => void = () => {}
    const onCommit = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const view = render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={vi.fn()}/>)
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    expect(onCommit).toHaveBeenCalledOnce()
    view.unmount()
    await act(async () => { reject(new Error('Late error')) })
    expect(showError).not.toHaveBeenCalled()
  })

  it('keeps a new edit independent of a cancelled commit that later rejects', async () => {
    let rejectFirst: (reason: Error) => void = () => {}
    let finishSecond = () => {}
    const onCommit = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirst = reject }))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finishSecond = resolve }))
    render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={vi.fn()}/>)
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    fireEvent.keyDown(input(), {key: 'Escape'})
    fireEvent.focus(input())
    fireEvent.change(input(), {target: {value: '14'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    expect(onCommit).toHaveBeenCalledTimes(2)
    await act(async () => { rejectFirst(new Error('Cancelled attempt')) })
    fireEvent.keyDown(input(), {key: 'Enter'})
    expect(onCommit).toHaveBeenCalledTimes(2)
    expect(showError).not.toHaveBeenCalled()
    await act(async () => { finishSecond() })
  })
})


it('cancels only once when Escape repeats before unmount', () => {
  const onCancel = vi.fn()
  render(<PendingPropertyRow owner={owner} schema={schema} onCommit={vi.fn()} onCancel={onCancel}/>)
  fireEvent.keyDown(input(), {key: 'Escape'})
  fireEvent.keyDown(input(), {key: 'Escape'})
  expect(onCancel).toHaveBeenCalledOnce()
})

it('keeps a new attempt failure visible after a cancelled commit succeeds', async () => {
  let finishFirst = () => {}
  let rejectSecond: (error: Error) => void = () => {}
  const onCommit = vi.fn()
    .mockImplementationOnce(() => new Promise<void>(resolve => { finishFirst = resolve }))
    .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectSecond = reject }))
  render(<PendingPropertyRow owner={owner} schema={schema} onCommit={onCommit} onCancel={vi.fn()}/>)
  fireEvent.change(input(), {target: {value: '12'}})
  fireEvent.keyDown(input(), {key: 'Enter'})
  fireEvent.keyDown(input(), {key: 'Escape'})
  fireEvent.focus(input())
  fireEvent.change(input(), {target: {value: '14'}})
  fireEvent.keyDown(input(), {key: 'Enter'})
  expect(onCommit).toHaveBeenCalledTimes(2)
  await act(async () => { finishFirst() })
  await act(async () => { rejectSecond(new Error('Second refused')) })
  expect(showError).toHaveBeenCalledWith('Second refused')
  expect(input()).not.toHaveAttribute('readonly')
})
