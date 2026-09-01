// @vitest-environment happy-dom
//
// The daily-note review hint: shown only on TODAY's note, for the decks the
// user selected, hiding decks with nothing due. The date and the selection
// are decided inside the component (the contribution is structural only), so
// these render through the real decorator with the reactive inputs mocked.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { BlockResolveContext } from '@/extensions/blockInteraction'
import type { BlockRenderer } from '@/types.js'
import { dailyNoteBlockId, todayIso } from '@/plugins/daily-notes/dailyNotes.ts'

const WS = 'ws-1'
const START_OF_TODAY = new Date(2026, 5, 2).getTime()
const TODAY_ID = dailyNoteBlockId(WS, todayIso(new Date(START_OF_TODAY)))

// Reassigned per test; the mocks close over them.
let storedDecks: unknown = null
let dueCounts: Record<string, number | undefined> = {}

vi.mock('@/context/repo.js', () => ({useRepo: () => ({})}))
vi.mock('@/hooks/block.js', () => ({
  useWorkspaceId: (block: Block) => (block as unknown as {workspaceId?: string}).workspaceId ?? WS,
}))
vi.mock('@/data/globalState.js', () => ({
  usePluginPrefsProperty: () => [storedDecks, vi.fn()],
}))
vi.mock('@/plugins/daily-notes/today.js', () => ({
  useStartOfToday: () => START_OF_TODAY,
}))
vi.mock('../useDueCards.ts', () => ({
  useDueCardCount: (_ws: string, tagName: string) => dueCounts[tagName],
}))
vi.mock('../deck.ts', () => ({
  getOrCreateReviewDeck: vi.fn(),
  startReviewDeck: vi.fn(),
}))
vi.mock('@/utils/navigation.js', () => ({navigateFromGlobalCommand: vi.fn()}))

const {srsDailyNoteReviewHintDecorator, dailyNoteHintDecks} =
  await import('../DailyNoteReviewHint.tsx')
const {DAILY_NOTE_TYPE} = await import('@/plugins/daily-notes/schema.ts')

const Inner: BlockRenderer = () => <span>note title</span>

const renderHint = (blockId: string) => {
  const decorate = srsDailyNoteReviewHintDecorator({
    types: [DAILY_NOTE_TYPE],
    isTopLevel: true,
  } as unknown as BlockResolveContext)
  if (!decorate) throw new Error('the hint decorator did not apply')
  const Decorated = decorate(Inner)
  render(<Decorated block={{id: blockId} as Block} />)
}

beforeEach(() => {
  storedDecks = null
  dueCounts = {}
})
afterEach(cleanup)

describe('the hint decorator contribution', () => {
  it('applies only to top-level daily notes', () => {
    const ctx = (types: string[], isTopLevel: boolean) =>
      ({types, isTopLevel} as unknown as BlockResolveContext)
    expect(srsDailyNoteReviewHintDecorator(ctx([DAILY_NOTE_TYPE], true))).not.toBeNull()
    expect(srsDailyNoteReviewHintDecorator(ctx(['page'], true))).toBeNull()
    expect(srsDailyNoteReviewHintDecorator(ctx([DAILY_NOTE_TYPE], false))).toBeNull()
  })
})

describe('deck selection semantics', () => {
  it('defaults an unconfigured pref to the all-due deck, keeps an explicit none', () => {
    expect(dailyNoteHintDecks(null)).toEqual([''])
    expect(dailyNoteHintDecks([])).toEqual([])
  })

  it('orders the all-due deck first and drops junk entries', () => {
    expect(dailyNoteHintDecks(['Spanish', '', 'Spanish', 42])).toEqual(['', 'Spanish'])
  })
})

describe('the daily-note review hint', () => {
  it('shows the all-due count on today’s note by default', () => {
    dueCounts = {'': 3}
    renderHint(TODAY_ID)
    expect(screen.getByText('note title')).not.toBeNull()
    expect(screen.getByText(/3 cards to review/)).not.toBeNull()
  })

  it('stays off every note that is not today’s', () => {
    dueCounts = {'': 3}
    renderHint(dailyNoteBlockId(WS, '2026-06-01'))
    // The positive case above proves this render path CAN produce the line;
    // only the date input differs here.
    expect(screen.getByText('note title')).not.toBeNull()
    expect(screen.queryByText(/to review/)).toBeNull()
  })

  it('shows one line per selected deck and hides decks with nothing due', () => {
    storedDecks = ['Spanish', 'German']
    dueCounts = {'': 5, Spanish: 1, German: 0}
    renderHint(TODAY_ID)
    expect(screen.getByText(/Spanish: 1 card to review/)).not.toBeNull()
    expect(screen.queryByText(/German/)).toBeNull()
    // The all-due deck is not selected, so its 5 due cards stay off the note.
    expect(screen.queryByText(/5 cards/)).toBeNull()
  })

  it('renders nothing when the user deselected every deck', () => {
    storedDecks = []
    dueCounts = {'': 5}
    renderHint(TODAY_ID)
    expect(screen.getByText('note title')).not.toBeNull()
    expect(screen.queryByText(/to review/)).toBeNull()
  })
})
