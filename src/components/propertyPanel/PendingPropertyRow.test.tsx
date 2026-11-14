// @vitest-environment happy-dom
import {useState} from 'react'
import {afterEach, describe, expect, it, vi} from 'vitest'
import {cleanup, fireEvent, render, screen} from '@testing-library/react'
import type {Block} from '@/data/block'
import type {AnyPropertySchema} from '@/data/api'
import {PendingPropertyRow} from './PendingPropertyRow'

vi.mock('./usePropertyEditingActivation', () => ({
  usePropertyEditingActivation: () => ({onFocus: () => {}, onBlur: () => {}}),
}))

const owner = {} as Block
const schema = {name: 'Priority', codec: {type: 'optional-number'}} as AnyPropertySchema
const input = () => screen.getByRole('textbox', {name: 'Value for Priority'})
afterEach(cleanup)

function ControlledRow({initialDraft = '', initiallyCommitting = false, onCommit = () => {}, onCancel = () => {}, onNavigate}: {
  initialDraft?: string
  initiallyCommitting?: boolean
  onCommit?: (text: string) => void
  onCancel?: () => void
  onNavigate?: (direction: -1 | 1) => void
}) {
  const [draft, setDraft] = useState(initialDraft)
  const [committing, setCommitting] = useState(initiallyCommitting)
  return <PendingPropertyRow
    owner={owner}
    schema={schema}
    draft={draft}
    committing={committing}
    onDraftChange={setDraft}
    onCommit={text => { setCommitting(true); onCommit(text) }}
    onCancel={onCancel}
    onNavigate={onNavigate}
  />
}

describe('PendingPropertyRow', () => {
  it('renders a controlled draft without a structural block identity or committing a value', () => {
    const onCommit = vi.fn()
    const onDraftChange = vi.fn()
    const view = render(<PendingPropertyRow owner={owner} schema={schema} draft="12" committing={false} onDraftChange={onDraftChange} onCommit={onCommit} onCancel={vi.fn()}/>)
    expect(input()).toHaveValue('12')
    expect(view.container.querySelector('[data-block-id], [data-block-shell], [data-lazy-block-id]')).toBeNull()
    fireEvent.change(input(), {target: {value: '13'}})
    expect(onDraftChange).toHaveBeenCalledExactlyOnceWith('13')
    expect(input()).toHaveValue('12')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it.each(['Enter', 'Escape', 'blur'])('abandons an empty draft on %s without a write', gesture => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<ControlledRow onCommit={onCommit} onCancel={onCancel}/>)
    if (gesture === 'blur') fireEvent.blur(input())
    else fireEvent.keyDown(input(), {key: gesture})
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it.each(['Enter', 'Escape', 'blur'])('submits the draft on %s without clearing it', gesture => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<ControlledRow onCommit={onCommit} onCancel={onCancel}/>)
    fireEvent.change(input(), {target: {value: '12'}})
    if (gesture === 'blur') fireEvent.blur(input())
    else fireEvent.keyDown(input(), {key: gesture})
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('12')
    expect(onCancel).not.toHaveBeenCalled()
    expect(input()).toHaveValue('12')
  })

  it('keeps the input read-only and ignores further commit gestures while the parent is saving', () => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<ControlledRow onCommit={onCommit} onCancel={onCancel}/>)
    fireEvent.change(input(), {target: {value: '12'}})
    fireEvent.keyDown(input(), {key: 'Enter'})
    expect(input()).toHaveAttribute('readonly')
    fireEvent.keyDown(input(), {key: 'Enter'})
    fireEvent.keyDown(input(), {key: 'Escape'})
    fireEvent.blur(input())
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('12')
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('does not cancel a busy empty draft', () => {
    const onCancel = vi.fn()
    render(<ControlledRow initiallyCommitting onCancel={onCancel}/>)
    fireEvent.keyDown(input(), {key: 'Escape'})
    fireEvent.blur(input())
    expect(onCancel).not.toHaveBeenCalled()
  })

  it.each(['Enter', 'Escape'])('does not submit %s during IME composition', key => {
    const onCommit = vi.fn()
    const onCancel = vi.fn()
    render(<ControlledRow initialDraft="12" onCommit={onCommit} onCancel={onCancel}/>)
    fireEvent.keyDown(input(), {key, isComposing: true})
    expect(onCommit).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.keyDown(input(), {key})
    expect(onCommit).toHaveBeenCalledExactlyOnceWith('12')
  })

  it('forwards Up and Down without exposing handled keys to outline gestures', () => {
    const onNavigate = vi.fn()
    const onOutlineKey = vi.fn()
    render(<div onKeyDown={onOutlineKey}><ControlledRow onNavigate={onNavigate}/></div>)
    expect(fireEvent.keyDown(input(), {key: 'ArrowUp'})).toBe(false)
    expect(fireEvent.keyDown(input(), {key: 'ArrowDown'})).toBe(false)
    expect(onNavigate.mock.calls).toEqual([[-1], [1]])
    expect(onOutlineKey).not.toHaveBeenCalled()
  })

  it.each(['Enter', 'Escape'])('prevents the handled %s gesture from reaching the outline', key => {
    const onOutlineKey = vi.fn()
    render(<div onKeyDown={onOutlineKey}><ControlledRow/></div>)
    expect(fireEvent.keyDown(input(), {key})).toBe(false)
    expect(onOutlineKey).not.toHaveBeenCalled()
  })

  it.each([
    {key: 'k', metaKey: true},
    {key: 'z', metaKey: true},
    {key: 'z', ctrlKey: true},
    {key: 'Enter', metaKey: true},
    {key: 'Escape', ctrlKey: true},
    {key: 'ArrowUp', altKey: true},
    {key: 'ArrowDown', metaKey: true},
    {key: 'Tab'},
    {key: 'Backspace'},
    {key: 'a'},
  ])('lets unhandled key $key and its modifiers bubble', event => {
    const onOutlineKey = vi.fn()
    const onCommit = vi.fn()
    const onNavigate = vi.fn()
    render(<div onKeyDown={onOutlineKey}><ControlledRow initialDraft="12" onCommit={onCommit} onNavigate={onNavigate}/></div>)
    expect(fireEvent.keyDown(input(), event)).toBe(true)
    expect(onOutlineKey).toHaveBeenCalledOnce()
    expect(onCommit).not.toHaveBeenCalled()
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('lets navigation keys bubble when no navigation handler is available', () => {
    const onOutlineKey = vi.fn()
    render(<div onKeyDown={onOutlineKey}><ControlledRow/></div>)
    expect(fireEvent.keyDown(input(), {key: 'ArrowUp'})).toBe(true)
    expect(onOutlineKey).toHaveBeenCalledOnce()
  })
})
