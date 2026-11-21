// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { Block } from '@/data/block'
import type { GroupedBacklinksConfig } from '../config.ts'
import { GroupedBacklinksDefaultsEditor } from '../GroupedBacklinksConfigEditor.tsx'

// query → tag-value candidates, for the mocked value search
const store = vi.hoisted(() => ({
  searchByValue: new Map<string, Array<{value: string; label: string; detail: string; key: string}>>(),
}))

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => ({activeWorkspaceId: 'ws-1'}),
}))

vi.mock('@/utils/linkTargetAutocomplete.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  searchLinkTargetValueCandidates: vi.fn(
    async (_repo: unknown, {query}: {query: string}) => store.searchByValue.get(query) ?? [],
  ),
}))

const EMPTY: GroupedBacklinksConfig = {
  highPriorityTags: [],
  lowPriorityTags: [],
  excludedTags: [],
  excludedPatterns: [],
}

const renderEditor = (onChange = vi.fn()) => {
  render(
    <GroupedBacklinksDefaultsEditor
      value={EMPTY}
      onChange={onChange}
      block={{} as Block}
    />,
  )
  // High priority is the first of the three "Add tag" inputs.
  const input = screen.getAllByPlaceholderText('Add tag')[0]
  return {onChange, input}
}

const cand = (value: string) => ({value, label: value, detail: '', key: value})

beforeEach(() => { store.searchByValue = new Map() })
afterEach(() => { vi.useRealTimers() })

describe('GroupedBacklinksConfigEditor / ConfigTagInput submit guard', () => {
  it('ignores mid-debounce stale results and commits the typed tag', async () => {
    vi.useFakeTimers()
    store.searchByValue.set('ab', [cand('ab-tag')])
    const {onChange, input} = renderEditor()

    fireEvent.focus(input)
    fireEvent.change(input, {target: {value: 'ab'}})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) }) // settle → results for 'ab'

    // Type ahead to 'abc' WITHOUT settling → results still reflect 'ab'.
    fireEvent.change(input, {target: {value: 'abc'}})
    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: 'Add high priority'}))
      await vi.advanceTimersByTimeAsync(0)
    })

    // Stale 'ab-tag' must NOT be committed — the typed 'abc' wins.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({highPriorityTags: ['abc']}),
    )
  })

  it('adopts the ACTIVE (arrowed) result on submit when fresh', async () => {
    vi.useFakeTimers()
    store.searchByValue.set('ab', [cand('first'), cand('second')])
    const {onChange, input} = renderEditor()

    fireEvent.focus(input)
    fireEvent.change(input, {target: {value: 'ab'}})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) }) // settle → [first, second], active=0

    fireEvent.keyDown(input, {key: 'ArrowDown'}) // active → 1 ('second')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', {name: 'Add high priority'}))
      await vi.advanceTimersByTimeAsync(0)
    })

    // Grouped commits results[activeIndex] (the arrowed pick), not results[0].
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({highPriorityTags: ['second']}),
    )
  })

  it('keyboard Enter ignores stale results and commits the typed tag', async () => {
    vi.useFakeTimers()
    store.searchByValue.set('ab', [cand('ab-tag')])
    const {onChange, input} = renderEditor()

    fireEvent.focus(input)
    fireEvent.change(input, {target: {value: 'ab'}})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) }) // settle → results for 'ab'

    fireEvent.change(input, {target: {value: 'abc'}}) // type ahead; results still 'ab'
    await act(async () => {
      fireEvent.keyDown(input, {key: 'Enter'})
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({highPriorityTags: ['abc']}),
    )
  })

  it('keyboard Enter adopts the highlighted tag when fresh', async () => {
    vi.useFakeTimers()
    store.searchByValue.set('ab', [cand('ab-tag')])
    const {onChange, input} = renderEditor()

    fireEvent.focus(input)
    fireEvent.change(input, {target: {value: 'ab'}})
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })

    await act(async () => {
      fireEvent.keyDown(input, {key: 'Enter'})
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({highPriorityTags: ['ab-tag']}),
    )
  })
})

// Escape has two jobs in a tag field and they must not both run on one
// press: dismiss the typed tag (its own dismissable state), or — with
// nothing to dismiss — fall through to `exit_property_editing`, which blurs
// the field and listens on `window`. A window listener stands in for that
// coordinator here, mirroring PropertyPicker's "Escape ownership" tests.
describe('GroupedBacklinksConfigEditor / ConfigTagInput Escape ownership', () => {
  it('dismisses a typed tag first, then lets Escape exit the field', () => {
    const reachedShortcuts = vi.fn()
    window.addEventListener('keydown', reachedShortcuts)
    try {
      const {input} = renderEditor()
      fireEvent.focus(input)
      fireEvent.change(input, {target: {value: 'ab'}})

      fireEvent.keyDown(input, {key: 'Escape'})
      expect((input as HTMLInputElement).value).toBe('')
      expect(reachedShortcuts).not.toHaveBeenCalled()

      fireEvent.keyDown(input, {key: 'Escape'})
      expect(reachedShortcuts).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', reachedShortcuts)
    }
  })
})
