// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { ReferenceSearch } from './RefPropertyEditor'

// ReferenceSearch reads the owner's workspace id via the reactive
// `useWorkspaceId` Handle hook, which needs a fully wired Block/repo to drive
// `useSyncExternalStore`. The Escape-ownership behavior under test here
// doesn't depend on search results, so stub the hook instead of standing up
// a real DB.
vi.mock('@/hooks/block.js', () => ({
  useWorkspaceId: () => 'workspace-1',
}))

// The real hook needs the shortcut provider chain (useRepo / uiStateBlock /
// useActiveContextsDispatch); this test only needs onFocus/onBlur.
// `consumeFieldEscape`, exported from the same module, is the real logic
// under test below — keep it intact.
vi.mock('@/components/propertyPanel/usePropertyEditingActivation.js', async (importOriginal) => ({
  ...await importOriginal<object>(),
  usePropertyEditingActivation: () => ({onFocus: () => {}, onBlur: () => {}}),
}))

const repo = {
  activeWorkspaceId: 'workspace-1',
  query: {
    // Empty-query focus takes the alias/recent-blocks branch of
    // `searchReferenceCandidates`; stub both rather than standing up a DB —
    // this test doesn't assert on search results, only on Escape ownership.
    aliasMatches: () => ({load: () => Promise.resolve([])}),
    recentBlocks: () => ({load: () => Promise.resolve([])}),
  },
} as unknown as Repo
const owner = new Block(repo, 'owner-1')

// Flush the search effect's promise chain (Promise.resolve().then()...
// .finally()) so its state updates land inside `act` instead of after the
// test body returns.
const flush = () => act(() => new Promise(resolve => setTimeout(resolve, 0)))

describe('ReferenceSearch — Escape ownership', () => {
  // Escape has two jobs in a property field and they must not both run on
  // one press: dismiss what's open (the suggestion dropdown), or — nothing
  // open — exit the field via `exit_property_editing`, which listens on
  // `window`. A window listener stands in for that action here, mirroring
  // PropertyPicker.test.tsx's "Escape ownership" block.
  it('dismisses its own open dropdown first, then lets Escape exit the field', async () => {
    const reachedShortcuts = vi.fn()
    window.addEventListener('keydown', reachedShortcuts)
    try {
      render(
        <ReferenceSearch
          owner={owner}
          excludeIds={[]}
          targetTypes={[]}
          placeholder="Search blocks"
          selectionMode="single"
          onPick={vi.fn()}
          propertyField
        />,
      )
      const input = screen.getByRole('combobox')

      fireEvent.focus(input)
      expect(input.getAttribute('aria-expanded')).toBe('true')
      await flush()

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
