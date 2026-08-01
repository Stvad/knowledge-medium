/** `runStartSession`'s ORCHESTRATION — the order it does things in, and what
 *  it does when a step reports failure.
 *
 *  Not the data layer: `startSession`/`takePlaceOf`/`readProgram` are stubbed
 *  here and covered for real in `test/integration/session.test.ts`. What is
 *  only testable here is the sequencing this action owns — navigate before
 *  recording a preference, skip the preference when nothing was stamped, and
 *  report a navigation the app refused.
 *
 *  It exists because that last rule had already regressed twice with nothing
 *  to catch it: `navigateFromGlobalCommand` resolves `null` rather than
 *  rejecting, so a discarded result is indistinguishable from success by
 *  inspection, and this file had no test coverage at all.
 */

import {beforeEach, describe, expect, it, vi} from 'vitest'

import {ActionContextTypes} from '@/shortcuts/types.js'

import {setDialogAnswer} from './kernel/dialogs'
import {navigatedTo, refuseNavigation, resetNavigation} from './kernel/navigation'

const started = vi.fn()
const placed = vi.fn()
const standing = vi.fn()
const choiceWritten = vi.fn()
const homeEnsured = vi.fn()

vi.mock('../src/km/session', () => ({
  startSession: (...args: unknown[]) => started(...args),
  takePlaceOf: (...args: unknown[]) => placed(...args),
}))

vi.mock('../src/km/tonight', () => ({
  readProgram: async () => ({
    config: {unit: 'lb', dayRolloverHour: 3}, warnings: [], history: [], layoffs: [],
    pageId: null, settingsBlockId: null, day: '2026-08-01', planSource: {},
  }),
  // Carries an `or`-group option, because `choicesToRecord` narrows the
  // dialog's picks to groups the confirmed prescription actually contains —
  // with no exercises here it returns empty and the `!stamped` guard below it
  // is never reached, which left that guard unpinned until this was fixed.
  prescribeFor: () => ({
    day: '2026-08-01', session: 'A',
    exercises: [{exercise: 'Face pulls', altGroupKey: 'group-1'}],
  }),
  standingSession: (...args: unknown[]) => standing(...args),
  ensureStrengthHome: (...args: unknown[]) => homeEnsured(...args),
}))

vi.mock('../src/km/store', () => ({
  writeAltChoice: (...args: unknown[]) => choiceWritten(...args),
}))

const {runStartSession} = await import('../src/ui/startAction')

const repo = {activeWorkspaceId: 'ws-1', isReadOnly: false} as never
const placement = {parentId: 'page', position: {kind: 'last'} as const}

beforeEach(() => {
  vi.clearAllMocks()
  resetNavigation()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  standing.mockResolvedValue(null)
  started.mockResolvedValue({id: 'workout-1', stamped: true})
  placed.mockResolvedValue('took-its-place')
  homeEnsured.mockResolvedValue({pageId: 'p', settingsBlockId: 's'})
  setDialogAnswer({session: 'A', choices: {}})
})

describe('a session already under way', () => {
  it('goes there instead of opening the picker', async () => {
    standing.mockResolvedValue('peer-workout')

    await runStartSession(repo, placement)

    expect(navigatedTo().map(t => t.blockId)).toEqual(['peer-workout'])
    // Nothing was asked and nothing was written: the picker's answer would
    // have been thrown away, and that is why this short-circuit exists.
    expect(started).not.toHaveBeenCalled()
  })

  it('says so when the app refuses to open it', async () => {
    // Left unreported, the tap does nothing and gives no sign why — and it
    // stays that way, because that session is standing, so every later Start
    // finds it and navigates into the same veto.
    standing.mockResolvedValue('peer-workout')
    refuseNavigation()

    await runStartSession(repo, placement)

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be opened'), 'peer-workout')
  })
})

describe('a session started by this tap', () => {
  it('is opened, and the variant is recorded only after that', async () => {
    setDialogAnswer({session: 'A', choices: {'group-1': 'opt-1'}})
    started.mockResolvedValue({id: 'workout-1', stamped: true})

    await runStartSession(repo, placement)

    expect(navigatedTo().map(t => t.blockId)).toEqual(['workout-1'])
    expect(console.warn).not.toHaveBeenCalled()
    // The precondition for the race test below, asserted rather than assumed:
    // this pick DOES reach the writer on a real start, so its absence there
    // is the `!stamped` guard and not an empty recording list.
    expect(choiceWritten).toHaveBeenCalledWith(repo, 's', 'group-1', 'opt-1', 'Face pulls')
  })

  it('says so when the app refuses to open it', async () => {
    refuseNavigation()

    await runStartSession(repo, placement)

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be opened'), 'workout-1')
  })
})

describe('a start that lost the race', () => {
  it('opens the session it was handed and records no preference for it', async () => {
    // `stamped: false` is a peer's session handed back untouched — the pick
    // never reached it, so recording "this is the variant I now track" would
    // change future prescriptions on the strength of a race that was lost and
    // never reported.
    setDialogAnswer({session: 'A', choices: {'group-1': 'opt-1'}})
    started.mockResolvedValue({id: 'peer-workout', stamped: false})

    await runStartSession(repo, placement)

    expect(navigatedTo().map(t => t.blockId)).toEqual(['peer-workout'])
    expect(choiceWritten).not.toHaveBeenCalled()
    // …and nothing bootstrapped a Strength Log page on the way past.
    expect(homeEnsured).not.toHaveBeenCalled()
  })

  it('still clears the empty line, and does not claim the session as its own', async () => {
    started.mockResolvedValue({id: 'peer-workout', stamped: false})

    await runStartSession(repo, placement)

    // The 4th argument is `placedByUs`. False means the line is cleared but
    // the session is NOT moved into its slot — sharing a parent is not owning
    // it, and a peer's session is not ours to reorder.
    expect(placed).toHaveBeenCalledWith(repo, 'peer-workout', placement, false)
  })
})

it('writes nothing at all in a read-only workspace', async () => {
  await runStartSession({activeWorkspaceId: 'ws-1', isReadOnly: true} as never, placement)

  expect(standing).not.toHaveBeenCalled()
  expect(started).not.toHaveBeenCalled()
})

it('registers under the context the real app defines', () => {
  // The fake for `@/shortcuts/types.js` is a hand-copied value map, so it
  // could drift from the app's without anything noticing. This is the one
  // assertion that would see it.
  expect(ActionContextTypes.NORMAL_MODE).toBe('normal-mode')
})
