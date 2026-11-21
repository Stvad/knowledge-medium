// @vitest-environment happy-dom
/** The panel type-picker's Enter/Tab commit decision (pure) — the
 *  label-collision preference and the navigated-highlight override.
 *  The surrounding combobox mechanics (filtering, arrow movement) are
 *  plain list state; the commit resolution is the part with policy.
 *
 *  Also covers Escape ownership (below) — this needs a DOM, hence the
 *  happy-dom pragma for the whole file. */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { resolveCommitTarget, TypesPropertyEditor, type TypeOption } from './TypesPropertyEditor'

// The real hook needs the shortcut provider chain (useRepo / uiStateBlock /
// useActiveContextsDispatch); the Escape tests below only need onFocus/
// onBlur. `consumeFieldEscape`, exported from the same module, is the real
// logic under test — keep it intact.
vi.mock('@/components/propertyPanel/usePropertyEditingActivation.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  usePropertyEditingActivation: () => ({onFocus: () => {}, onBlur: () => {}}),
}))

// useTypes reads the merged type registry off `useRepo()`'s context; stub it
// rather than standing up a real Provider — the Escape tests below don't
// need any options in the dropdown, just its open/closed state.
vi.mock('@/hooks/typeRegistry.js', () => ({
  useTypes: () => new Map(),
}))

const USER_DEFINED: TypeOption = {id: 'uuid-1', label: 'User', hideFromCompletion: false}
const KERNEL_USER: TypeOption = {id: 'user', label: 'User', hideFromCompletion: true}
const MEDIA: TypeOption = {id: 'media', label: 'Media', hideFromCompletion: true}
const TASK: TypeOption = {id: 'uuid-2', label: 'Task', hideFromCompletion: false}

const resolve = (overrides: Partial<Parameters<typeof resolveCommitTarget>[0]>) =>
  resolveCommitTarget({
    options: [],
    filtered: [],
    queryText: '',
    navigated: false,
    activeIndex: 0,
    selectedIds: new Set<string>(),
    ...overrides,
  })

describe('resolveCommitTarget', () => {
  it('on a label collision, the completion-offered type beats the infrastructure one', () => {
    expect(resolve({
      options: [KERNEL_USER, USER_DEFINED],
      filtered: [KERNEL_USER, USER_DEFINED],
      queryText: 'user',
    })).toBe(USER_DEFINED)
  })

  it('a sole infrastructure exact match still commits — the panel picker lists everything', () => {
    expect(resolve({
      options: [MEDIA, TASK],
      filtered: [MEDIA],
      queryText: 'media',
    })).toBe(MEDIA)
  })

  it('an explicit highlight (navigated) beats the exact-match shortcut', () => {
    expect(resolve({
      options: [KERNEL_USER, USER_DEFINED, TASK],
      filtered: [USER_DEFINED, TASK],
      queryText: 'user',
      navigated: true,
      activeIndex: 1,
    })).toBe(TASK)
  })

  it('an exact match already on the block falls through to the highlighted row', () => {
    expect(resolve({
      options: [USER_DEFINED, TASK],
      filtered: [TASK],
      queryText: 'user',
      selectedIds: new Set([USER_DEFINED.id]),
    })).toBe(TASK)
  })

  it('matches by id as well as label, case-insensitively', () => {
    expect(resolve({
      options: [TASK],
      filtered: [],
      // queryText arrives pre-lowercased from the component; the id
      // comparison folds the OPTION's side — mixed-case id exercises it.
      queryText: 'uuid-2',
    })).toBe(TASK)
    expect(resolve({
      options: [{...TASK, id: 'UUID-2'}],
      filtered: [],
      queryText: 'uuid-2',
    })).toMatchObject({id: 'UUID-2'})
  })

  it('no exact match and nothing filtered → nothing to commit', () => {
    expect(resolve({
      options: [TASK],
      filtered: [],
      queryText: 'recipe',
    })).toBeUndefined()
  })
})

describe('TypesPropertyEditor — Escape ownership', () => {
  // Escape has two jobs in a property field and they must not both run on
  // one press: dismiss what's open (the suggestion dropdown), or — nothing
  // open — exit the field via `exit_property_editing`, which listens on
  // `window`. A window listener stands in for that action here, mirroring
  // PropertyPicker.test.tsx's "Escape ownership" block.
  it('dismisses its own open dropdown first, then lets Escape exit the field', () => {
    const reachedShortcuts = vi.fn()
    window.addEventListener('keydown', reachedShortcuts)
    try {
      const block = new Block({isReadOnly: false} as unknown as Repo, 'block-1')
      render(<TypesPropertyEditor value={[]} onChange={vi.fn()} block={block} />)
      const input = screen.getByRole('combobox')

      fireEvent.focus(input)
      expect(input.getAttribute('aria-expanded')).toBe('true')

      fireEvent.keyDown(input, {key: 'Escape'})
      expect(input.getAttribute('aria-expanded')).toBe('false')
      expect(reachedShortcuts).not.toHaveBeenCalled()

      fireEvent.keyDown(input, {key: 'Escape'})
      expect(reachedShortcuts).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', reachedShortcuts)
    }
  })
})
