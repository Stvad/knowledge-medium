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
const { localMigrationMessageFor, __resetLocalMigrationRunForTests } =
  await import('../localRunMessage.ts')

const WS = 'ws-1'
const start = (initial = '…') => reportMigrationProgress(WS, initial)
const line = (): string | null => localMigrationMessageFor(WS)

beforeEach(() => { showInfo.mockClear(); showError.mockClear() })
afterEach(() => { __resetLocalMigrationRunForTests() })

describe('while the pass is running', () => {
  it('drives the dialog\'s status line and raises no toast', () => {
    const progress = start('Migrating properties to blocks…')
    expect(line()).toBe('Migrating properties to blocks…')

    progress.update('Switching this workspace to property blocks…')

    expect(line()).toBe('Switching this workspace to property blocks…')
    expect(showInfo).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()
  })
})

describe('a second invocation while a run is live', () => {
  it('cannot clear the running line out from under the run that owns it', () => {
    // The palette stays reachable while the dialog is up, so a re-run can start
    // and be turned away by the claim. Its failure report must not blank the
    // live run's status — which is what carries "leave this tab open", at the
    // moment the operator is most likely to close the tab.
    const live = start('Migrating properties to blocks…')

    const turnedAway = start('Migrating properties to blocks…')
    turnedAway.fail('The migration is already running on this device.')

    expect(line()).toBe('Migrating properties to blocks…')

    live.update('Converting block 40,000 of 650,000…')
    expect(line()).toBe('Converting block 40,000 of 650,000…')
  })

  it('leaves the slot with the run that took it, not the newest caller', () => {
    const first = start('first')
    const second = start('second')

    expect(line()).toBe('first')

    second.update('second again')
    expect(line()).toBe('first')

    first.update('first again')
    expect(line()).toBe('first again')
  })
})

describe('a run on a workspace the user is not looking at', () => {
  it('is reported as ITS workspace\'s, not as whatever dialog happens to be up', () => {
    // A run started on one workspace and a dialog raised by a PEER's claim on
    // another are two situations; the dialog keys on the workspace to keep them
    // apart, and can only do that if the run says which one it is.
    reportMigrationProgress('ws-other', 'Switching that workspace over…')

    expect(localMigrationMessageFor('ws-other')).toBe('Switching that workspace over…')
    expect(localMigrationMessageFor(WS)).toBeNull()
  })
})

describe('a run ending on ANOTHER workspace', () => {
  it('does not take the live run\'s slot down with it', () => {
    // The browser's Back button switches workspaces even while the gate is up
    // (App.tsx says so), and the palette is global — so a second workspace's
    // run can start and end while the first is still going. Ending one by
    // clearing every slot leaves the live run unable to publish for the rest of
    // its life: it no longer owns what it is writing to. The gate then reads no
    // local message, degrades to "another device", and offers the tab that is
    // WRITING a button to release its own claim.
    const live = reportMigrationProgress(WS, 'Migrating properties to blocks…')

    reportMigrationProgress('ws-other', 'Migrating…').done('Migrated 3 blocks.')

    expect(line()).toBe('Migrating properties to blocks…')
    live.update('Converting block 40,000 of 650,000…')
    expect(line()).toBe('Converting block 40,000 of 650,000…')
  })
})

describe('when it ends', () => {
  it('reports the outcome where the dialog closing cannot take it', () => {
    // The dialog is the CLAIM's, and the claim is handed back before the
    // gesture finishes reporting — so an outcome shown there would be swept
    // away with it, and several outcomes are reported on paths where no claim
    // was ever taken at all.
    const progress = start()

    progress.done('Migrated 7 blocks.')

    expect(line()).toBeNull()
    expect(showInfo).toHaveBeenCalledWith('Migrated 7 blocks.', expect.anything())
  })

  it('reports a failure as a failure', () => {
    start().fail('Could not switch this workspace over.')

    expect(showError).toHaveBeenCalledWith(
      'Could not switch this workspace over.', expect.anything())
    expect(showInfo).not.toHaveBeenCalled()
  })

  it('ignores a late progress notification, which would restart a finished run', () => {
    // The pass notifies per committed batch and its subscription is torn down
    // after the outcome; a notification that lands in between would otherwise
    // put a finished migration back on screen as running.
    const progress = start()
    progress.done('Migrated 7 blocks.')

    progress.update('still going')

    expect(line()).toBeNull()
  })

  it('says something for a gesture that ended without reporting', () => {
    const progress = start()

    progress.settleUnreported()

    expect(showError).toHaveBeenCalledWith(
      expect.stringContaining('without reporting what happened'), expect.anything())
  })

  it('leaves a reported outcome alone rather than overwriting it with the fallback', () => {
    const progress = start()
    progress.done('Migrated 7 blocks.')

    progress.settleUnreported()

    expect(showError).not.toHaveBeenCalled()
    expect(showInfo).toHaveBeenCalledTimes(1)
  })

  it('qualifies the outcome in place, rather than beside it', () => {
    // The note says the workspace is still held, which the outcome message
    // cannot know — it is written before the release is attempted. Under the
    // same toast id, or the user reads two toasts as two events.
    const progress = start()
    progress.done('Migrated 7 blocks.')
    const id = (showInfo.mock.calls[0]?.[1] as {id: string}).id

    progress.addNote('Every device is still waiting on this workspace.')

    expect(showInfo).toHaveBeenLastCalledWith(
      expect.stringContaining('Every device is still waiting'), expect.objectContaining({id}))
    expect(showInfo).toHaveBeenLastCalledWith(
      expect.stringContaining('Migrated 7 blocks.'), expect.anything())
  })

  it('has nothing to qualify while the run is still going', () => {
    const progress = start()

    progress.addNote('ignored')

    expect(showInfo).not.toHaveBeenCalled()
    expect(showError).not.toHaveBeenCalled()
  })
})
