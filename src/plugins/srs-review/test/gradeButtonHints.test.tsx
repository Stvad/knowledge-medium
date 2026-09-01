// @vitest-environment happy-dom
//
// The grade buttons render the hints they are HANDED, rather than any of
// their own. Without this, re-writing a literal back into the button table
// leaves every hint test in keyHints.test.tsx green — those cover the
// derivation, not who consumes it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Block } from '@/data/block'
import { SrsSignal } from '@/plugins/srs-rescheduling/scheduler.js'

// The card's live interval/factor drive the "next due in" line, not the
// hints; an unenrolled card reads undefined for both anyway.
vi.mock('@/hooks/block.js', () => ({useProperty: () => [undefined, vi.fn()]}))

const { GradeButtons } = await import('../ReviewSession.tsx')
const { SRS_DEFAULT_GRADE_SIGNAL, SRS_GRADE_ACTION_IDS, SRS_REVEAL_ACTION_ID } =
  await import('../actions.ts')

const CARD = {id: 'card'} as Block

const renderButtons = (hints: ReadonlyMap<string, string>) =>
  render(<GradeButtons card={CARD} busy={false} keyHints={hints} onGrade={vi.fn()} />)

afterEach(cleanup)

describe('grade buttons', () => {
  it('shows the hint derived for each button, reveal chord included', () => {
    renderButtons(new Map([
      [SRS_GRADE_ACTION_IDS.get(SrsSignal.AGAIN)!, 'Q'],
      [SRS_GRADE_ACTION_IDS.get(SRS_DEFAULT_GRADE_SIGNAL)!, 'W'],
      [SRS_REVEAL_ACTION_ID, 'R'],
    ]))

    // Deliberately not the default chords: a button echoing a literal
    // would still show `1`/`3 · space` against these bindings.
    expect(screen.getByText('Q')).toBeTruthy()
    expect(screen.getByText('W · R')).toBeTruthy()
  })

  it('renders no hint element for a button whose keys are all unbound', () => {
    const {container} = renderButtons(new Map())

    expect(container.querySelectorAll('.opacity-50')).toHaveLength(0)
    // The buttons themselves survive — an unbound key isn't a missing grade.
    expect(screen.getByText('Again')).toBeTruthy()
  })
})
