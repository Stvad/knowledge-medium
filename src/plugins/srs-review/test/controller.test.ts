// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { BaseShortcutDependencies } from '@/shortcuts/types.ts'
import { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.ts'
import { makeSrsReviewController, srsReviewActions, type SrsReviewController } from '../actions.ts'

const make = (state: {busy?: boolean; revealed?: boolean} = {}) => {
  const reveal = vi.fn()
  const grade = vi.fn()
  const controller = makeSrsReviewController({
    busy: state.busy ?? false,
    revealed: state.revealed ?? false,
    reveal,
    grade,
  })
  return {controller, reveal, grade}
}

describe('the review controller', () => {
  it('reveals a hidden answer on the default key, without grading', () => {
    const {controller, reveal, grade} = make({revealed: false})
    controller.revealOrGradeDefault()
    expect(reveal).toHaveBeenCalledTimes(1)
    expect(grade).not.toHaveBeenCalled()
  })

  it('grades a revealed answer Good on the default key', () => {
    const {controller, reveal, grade} = make({revealed: true})
    controller.revealOrGradeDefault()
    expect(grade).toHaveBeenCalledExactlyOnceWith(SrsSignal.GOOD)
    expect(reveal).not.toHaveBeenCalled()
  })

  it('does nothing while a grade write is in flight', () => {
    // Space is now a GRADING key once revealed: without the busy gate a
    // second press during the write would double-grade the card (or grade
    // the next one before it was even shown).
    for (const revealed of [false, true]) {
      const {controller, reveal, grade} = make({busy: true, revealed})
      controller.revealOrGradeDefault()
      controller.reveal()
      controller.grade(SrsSignal.AGAIN)
      expect(reveal).not.toHaveBeenCalled()
      expect(grade).not.toHaveBeenCalled()
    }
  })

  it('ignores explicit grades until the answer is revealed', () => {
    const {controller, grade} = make({revealed: false})
    controller.grade(SrsSignal.EASY)
    expect(grade).not.toHaveBeenCalled()
  })
})

describe('the default-vote key action', () => {
  const revealAction = srsReviewActions.find(a => a.id === 'srs-review.reveal')!
  const dispatch = (repeat: boolean) => {
    const revealOrGradeDefault = vi.fn()
    const deps = {
      controller: {revealOrGradeDefault} as unknown as SrsReviewController,
    } as unknown as BaseShortcutDependencies
    revealAction.handler(deps, new KeyboardEvent('keydown', {key: ' ', repeat}))
    return revealOrGradeDefault
  }

  it('fires on a fresh keydown but not on OS auto-repeats', () => {
    // Held Space auto-repeats ~30/s; the first repeat after the reveal
    // would grade Good before the user has seen the answer, and repeats
    // after the advance would chain onto the next card.
    expect(dispatch(false)).toHaveBeenCalledTimes(1)
    expect(dispatch(true)).not.toHaveBeenCalled()
  })
})
