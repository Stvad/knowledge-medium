// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { Block } from '@/data/block'
import type { BlockLayoutSlots, BlockResolveContext, BlockShellProps } from '@/extensions/blockInteraction'
import {
  srsReviewCardLayoutContribution,
  SRS_REVIEW_CARD_ID,
  SRS_REVIEW_REVEALED,
} from '../reviewCardLayout.tsx'

// The card styles its own wrapper rather than using the default layout, so it
// is solely responsible for spreading `shellProps` onto it. It used to render
// `Shell` and ignore them, which left the card with no identity in the DOM:
// the review deck around it then answered for the card's pointer gestures, and
// spatial navigation could not see it as a row.
const SHELL_PROPS = {
  'data-block-shell': 'true',
  'data-block-id': 'card',
  'data-editing': 'false',
  className: 'decorator-class',
  tabIndex: 0,
} as unknown as BlockShellProps

const slots = (): BlockLayoutSlots => ({
  block: {id: 'card'} as Block,
  Content: () => <span>content</span>,
  Children: () => <span>answer</span>,
  Shell: ({children}: {children: (props: BlockShellProps) => React.ReactNode}) =>
    <>{children(SHELL_PROPS)}</>,
} as unknown as BlockLayoutSlots)

const layoutFor = (revealed: boolean) => {
  const variant = srsReviewCardLayoutContribution({
    block: {id: 'card'},
    blockContext: {
      [SRS_REVIEW_CARD_ID]: 'card',
      ...(revealed ? {[SRS_REVIEW_REVEALED]: true} : {}),
    },
  } as unknown as BlockResolveContext)
  if (!variant) throw new Error('the card layout did not apply')
  return variant.render
}

afterEach(cleanup)

describe('the SRS review card layout', () => {
  it.each([
    ['question', false, 'srs-review-card-question'],
    ['answer', true, 'srs-review-card-answer'],
  ])('gives the %s phase the block boundary', (_phase, revealed, wrapperClass) => {
    const Layout = layoutFor(revealed as boolean)
    render(<Layout {...slots()} />)

    const wrapper = document.querySelector(`.${wrapperClass}`)
    expect(wrapper).not.toBeNull()
    // The wrapper IS the shell, so both halves of the block's identity have to
    // land on it — otherwise the nearest one above is the deck's.
    expect(wrapper?.getAttribute('data-block-shell')).toBe('true')
    expect(wrapper?.getAttribute('data-block-id')).toBe('card')
    // Decorator classes (focus ring, selection) ride on `shellProps.className`;
    // spreading must not drop them or the phase class.
    expect(wrapper?.className).toContain('decorator-class')
  })

  it('shows the answer subtree only once revealed', () => {
    // The reason these layouts exist at all — kept alongside the boundary
    // assertions so a spread that clobbered `Children` would surface here.
    const Question = layoutFor(false)
    render(<Question {...slots()} />)
    expect(screen.queryByText('answer')).toBeNull()

    cleanup()
    const Answer = layoutFor(true)
    render(<Answer {...slots()} />)
    expect(screen.getByText('answer')).not.toBeNull()
  })
})
