// @vitest-environment happy-dom
/**
 * The pending-move mark is the ONLY feedback a cut gives (cut doesn't
 * delete), so "does it actually apply, and does it apply the moment the
 * register changes" is the whole contract.
 *
 * This exists because the first implementation used `blockTextClassFacet`,
 * whose contributions are plain functions and can't subscribe — the mark
 * then never appeared for a single-block cut, which was only caught by
 * looking at the running app. A decorator renders a component, so it can
 * subscribe; these tests pin that it does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { BlockShellState } from '@/extensions/blockInteraction.js'
import { clearPendingMove, setPendingMove } from '@/utils/pendingMove.js'
import { PendingMoveShellDecorator } from './pendingMoveStyling.tsx'

const WS = 'ws-1'

const renderDecorator = (blockId: string, activeWorkspaceId: string | null = WS) => {
  const resolveContext = {
    block: {id: blockId},
    repo: {activeWorkspaceId},
  } as never

  const state = {shellProps: {className: 'tm-block'}} as unknown as BlockShellState

  return render(
    <PendingMoveShellDecorator
      resolveContext={resolveContext}
      state={state}
      shellRef={{current: null}}
      contentRef={{current: null}}
    >
      {(next: BlockShellState) => (
        <div
          data-testid="shell"
          className={next.shellProps.className}
          data-pending-move={
            (next.shellProps as unknown as Record<string, unknown>)['data-pending-move'] as
              | string
              | undefined
          }
        />
      )}
    </PendingMoveShellDecorator>,
  )
}

afterEach(() => {
  cleanup()
  clearPendingMove()
})

describe('PendingMoveShellDecorator', () => {
  it('marks a block that is part of the pending move', () => {
    setPendingMove({blockIds: ['a'], workspaceId: WS, clipboardText: 'a'})
    const {getByTestId} = renderDecorator('a')

    expect(getByTestId('shell').dataset.pendingMove).toBe('true')
    expect(getByTestId('shell').className).toContain('opacity-50')
  })

  it('leaves other blocks alone', () => {
    setPendingMove({blockIds: ['a'], workspaceId: WS, clipboardText: 'a'})
    const {getByTestId} = renderDecorator('b')

    expect(getByTestId('shell').dataset.pendingMove).toBeUndefined()
    expect(getByTestId('shell').className).not.toContain('opacity-50')
  })

  // The reason this is a decorator and not a class facet. Rendered first
  // with nothing pending (so the "absent" assertion below is a real
  // observation and not a first-render freebie), THEN the register
  // changes with no other prop or state touched.
  it('appears as soon as the register changes, with no other re-render trigger', () => {
    const {getByTestId} = renderDecorator('a')
    expect(getByTestId('shell').dataset.pendingMove).toBeUndefined()

    act(() => {
      setPendingMove({blockIds: ['a'], workspaceId: WS, clipboardText: 'a'})
    })

    expect(getByTestId('shell').dataset.pendingMove).toBe('true')
  })

  it('clears as soon as the register is cleared', () => {
    setPendingMove({blockIds: ['a'], workspaceId: WS, clipboardText: 'a'})
    const {getByTestId} = renderDecorator('a')
    expect(getByTestId('shell').dataset.pendingMove).toBe('true')

    act(() => { clearPendingMove() })

    expect(getByTestId('shell').dataset.pendingMove).toBeUndefined()
  })

  it('does not mark a same-id block in a different workspace', () => {
    setPendingMove({blockIds: ['a'], workspaceId: 'ws-other', clipboardText: 'a'})
    const {getByTestId} = renderDecorator('a')

    expect(getByTestId('shell').dataset.pendingMove).toBeUndefined()
  })
})
