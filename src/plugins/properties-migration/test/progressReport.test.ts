// @vitest-environment node
/**
 * The split this module exists for: PROGRESS goes to the dialog the claim
 * raises, the OUTCOME goes to a toast that outlives it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const showInfo = vi.fn()
const showError = vi.fn()
vi.mock('@/utils/toast.js', () => ({
  showInfo: (message: string, opts?: unknown) => showInfo(message, opts),
  showError: (message: string, opts?: unknown) => showError(message, opts),
}))

const { reportMigrationProgress } = await import('../progressReport.ts')
const { getLocalMigrationMessage, setLocalMigrationMessage } =
  await import('../localRunMessage.ts')

beforeEach(() => { showInfo.mockClear(); showError.mockClear() })
afterEach(() => { setLocalMigrationMessage(null) })

describe('while the pass is running', () => {
  it('drives the dialog\'s status line and raises no toast', () => {
    const progress = reportMigrationProgress('Migrating properties to blocks…')
    expect(getLocalMigrationMessage()).toBe('Migrating properties to blocks…')

    progress.update('Switching this workspace to property blocks…')

    expect(getLocalMigrationMessage()).toBe('Switching this workspace to property blocks…')
    expect(showInfo).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()
  })
})

describe('when it ends', () => {
  it('reports the outcome where the dialog closing cannot take it', () => {
    // The dialog is the CLAIM's, and the claim is handed back before the
    // gesture finishes reporting — so an outcome shown there would be swept
    // away with it, and several outcomes are reported on paths where no claim
    // was ever taken at all.
    const progress = reportMigrationProgress('…')

    progress.done('Migrated 7 blocks.')

    expect(getLocalMigrationMessage()).toBeNull()
    expect(showInfo).toHaveBeenCalledWith('Migrated 7 blocks.', expect.anything())
  })

  it('reports a failure as a failure', () => {
    reportMigrationProgress('…').fail('Could not switch this workspace over.')

    expect(showError).toHaveBeenCalledWith(
      'Could not switch this workspace over.', expect.anything())
    expect(showInfo).not.toHaveBeenCalled()
  })

  it('ignores a late progress notification, which would restart a finished run', () => {
    // The pass notifies per committed batch and its subscription is torn down
    // after the outcome; a notification that lands in between would otherwise
    // put a finished migration back on screen as running.
    const progress = reportMigrationProgress('…')
    progress.done('Migrated 7 blocks.')

    progress.update('still going')

    expect(getLocalMigrationMessage()).toBeNull()
  })

  it('says something for a gesture that ended without reporting', () => {
    const progress = reportMigrationProgress('…')

    progress.settleUnreported()

    expect(showError).toHaveBeenCalledWith(
      expect.stringContaining('without reporting what happened'), expect.anything())
  })

  it('leaves a reported outcome alone rather than overwriting it with the fallback', () => {
    const progress = reportMigrationProgress('…')
    progress.done('Migrated 7 blocks.')

    progress.settleUnreported()

    expect(showError).not.toHaveBeenCalled()
    expect(showInfo).toHaveBeenCalledTimes(1)
  })

  it('qualifies the outcome in place, rather than beside it', () => {
    // The note says the workspace is still held, which the outcome message
    // cannot know — it is written before the release is attempted. Under the
    // same toast id, or the user reads two toasts as two events.
    const progress = reportMigrationProgress('…')
    progress.done('Migrated 7 blocks.')
    const id = (showInfo.mock.calls[0]?.[1] as {id: string}).id

    progress.addNote('Every device is still waiting on this workspace.')

    expect(showInfo).toHaveBeenLastCalledWith(
      expect.stringContaining('Every device is still waiting'), expect.objectContaining({id}))
    expect(showInfo).toHaveBeenLastCalledWith(
      expect.stringContaining('Migrated 7 blocks.'), expect.anything())
  })

  it('has nothing to qualify while the run is still going', () => {
    const progress = reportMigrationProgress('…')

    progress.addNote('ignored')

    expect(showInfo).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()
  })
})
