// @vitest-environment happy-dom
/**
 * The migration's progress modal: that it BLOCKS while the pass runs, and that
 * it always becomes closable.
 *
 * The blocking half is the reason it is a modal rather than a toast, and the
 * closable half is what keeps that from turning into a reload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MigrationProgressDialog,
  type MigrationProgressState,
} from '../MigrationProgressDialog.tsx'
import { showBlockingMigrationProgress } from '../blockingProgress.ts'
import { __resetDialogsForTests, getDialogQueue } from '@/utils/dialogs.js'

afterEach(() => {
  cleanup()
  __resetDialogsForTests()
})

/** Renders the dialog against a store the test drives, the way
 *  `showBlockingMigrationProgress` drives it. */
const renderDialog = (initial: MigrationProgressState) => {
  let state = initial
  const listeners = new Set<() => void>()
  const resolve = vi.fn()
  render(
    <MigrationProgressDialog
      getState={() => state}
      subscribe={listener => { listeners.add(listener); return () => listeners.delete(listener) }}
      resolve={resolve}
      cancel={vi.fn()}
    />,
  )
  return {
    resolve,
    set: (next: MigrationProgressState) => {
      state = next
      listeners.forEach(listener => { listener() })
    },
  }
}

describe('while the migration is running', () => {
  it('offers no way to dismiss itself', async () => {
    // All three of Radix's exits, because hiding the button while leaving
    // Escape and outside-click would read as blocking without being it.
    const {resolve} = renderDialog({kind: 'running', message: 'Migrating…'})
    // `pointerEventsCheck: 0` because Radix sets `pointer-events: none` on the
    // body while a modal is open, and user-event refuses to click through it —
    // which would pass this test without ever reaching the handler under test.
    const user = userEvent.setup({pointerEventsCheck: 0})

    expect(screen.queryByRole('button', {name: /close/i})).toBeNull()
    await user.keyboard('{Escape}')
    await user.click(document.body)

    expect(resolve).not.toHaveBeenCalled()
    expect(screen.getByText('Migrating…')).toBeTruthy()
  })

  it('says the workspace is not accepting edits, which is why it is in the way', async () => {
    renderDialog({kind: 'running', message: 'Migrating…'})

    expect(screen.getByText(/not accepting edits/i)).toBeTruthy()
  })

  it('follows the status line as the pass reports', async () => {
    const {set} = renderDialog({kind: 'running', message: 'Migrating…'})

    set({kind: 'running', message: 'sweep 2, 300/900'})

    expect(await screen.findByText('sweep 2, 300/900')).toBeTruthy()
  })
})

describe('once the migration reports an outcome', () => {
  it('becomes closable, and closing it resolves the dialog', async () => {
    const {set, resolve} = renderDialog({kind: 'running', message: 'Migrating…'})

    set({kind: 'done', message: 'Migrated 900 blocks.'})

    await userEvent.click(await screen.findByRole('button', {name: /close/i}))
    expect(resolve).toHaveBeenCalledWith(true)
  })

  it('is closable after a FAILURE too', async () => {
    const {set} = renderDialog({kind: 'running', message: 'Migrating…'})

    set({kind: 'failed', message: 'The flip was refused.'})

    expect(await screen.findByRole('button', {name: /close/i})).toBeTruthy()
    expect(screen.getByText('The flip was refused.')).toBeTruthy()
  })
})

describe('the handle the gesture reports through', () => {
  const state = (): MigrationProgressState => {
    const entry = getDialogQueue()[0]
    if (!entry) throw new Error('[test] no dialog was opened')
    return (entry.props.getState as () => MigrationProgressState)()
  }

  it('opens the dialog as soon as the gesture starts', () => {
    showBlockingMigrationProgress('Migrating properties to blocks…')

    expect(state()).toEqual({kind: 'running', message: 'Migrating properties to blocks…'})
  })

  it('ignores a progress report that arrives after the outcome', () => {
    // The pass notifies per committed batch and its subscription is torn down
    // after the outcome is reported — a notification that crosses that would
    // put a finished migration back into a state with no way out of it.
    const progress = showBlockingMigrationProgress('Migrating…')

    progress.done('Migrated 900 blocks.')
    progress.update('sweep 3, 900/900')

    expect(state()).toEqual({kind: 'done', message: 'Migrated 900 blocks.'})
  })

  it('settles a gesture that ended without reporting anything', () => {
    // Reaching this is a bug; the alternative is a modal with no way out, and a
    // reload over a pass whose result the user was never told.
    const progress = showBlockingMigrationProgress('Migrating…')

    progress.settleUnreported()

    expect(state()).toMatchObject({kind: 'failed'})
  })

  it('leaves a reported outcome alone when the gesture settles', () => {
    const progress = showBlockingMigrationProgress('Migrating…')

    progress.fail('The flip was refused.')
    progress.settleUnreported()

    expect(state()).toEqual({kind: 'failed', message: 'The flip was refused.'})
  })
})
