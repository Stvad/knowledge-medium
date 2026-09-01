/** "N cards to review →" under today's daily-note title — one line per
 *  deck the user selected in the deck picker (readwise's backlog hint,
 *  for SRS). Clicking a line starts that deck's review session.
 *
 *  The contribution gate is STRUCTURAL only (type + focality); "is this
 *  today" is decided inside the component from `useStartOfToday`, so a
 *  note left open across midnight drops (or gains) the hint on its own —
 *  contributions are not re-resolved as time passes.
 */
import { Suspense, useMemo, type ComponentType } from 'react'
import type { Block } from '@/data/block'
import { useRepo } from '@/context/repo.js'
import { useWorkspaceId } from '@/hooks/block.js'
import { usePluginPrefsProperty } from '@/data/globalState.js'
import {
  cachedContentDecorator,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type { BlockRenderer } from '@/types.js'
import { navigateFromGlobalCommand } from '@/utils/navigation.js'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'
import { dailyNoteBlockId, todayIso } from '@/plugins/daily-notes/dailyNotes.js'
import { useStartOfToday } from '@/plugins/daily-notes/today.js'
import { useDueCardCount } from './useDueCards.ts'
import { getOrCreateReviewDeck, startReviewDeck } from './deck.ts'
import {
  dailyNoteDecksProp,
  normalizeDailyNoteDecks,
  srsReviewPrefsType,
} from './schema.ts'

export const reviewHintLabel = (tagName: string, count: number): string => {
  const cards = `${count} ${count === 1 ? 'card' : 'cards'} to review`
  return tagName === '' ? cards : `${tagName}: ${cards}`
}

/** The decks the hint shows, from the stored pref: never configured (null)
 *  falls back to the all-due deck; an explicit `[]` means the user turned
 *  every deck off. The all-due deck sorts first, tags keep stored order. */
export const dailyNoteHintDecks = (stored: unknown): string[] => {
  const decks = normalizeDailyNoteDecks(stored) ?? ['']
  return decks.includes('') ? ['', ...decks.filter(t => t !== '')] : decks
}

const DeckHintLine = ({workspaceId, tagName}: {workspaceId: string; tagName: string}) => {
  const repo = useRepo()
  // Due cards only, counted in SQLite — same handle the deck picker's badge
  // uses. Loading and zero both render nothing.
  const count = useDueCardCount(workspaceId, tagName)
  if (!count) return null
  return (
    <button
      type="button"
      data-block-interaction="ignore"
      className="text-xs text-muted-foreground hover:text-foreground hover:underline"
      onClick={event => {
        event.stopPropagation()
        void (async () => {
          const deck = await getOrCreateReviewDeck(repo, workspaceId)
          await startReviewDeck(deck, tagName)
          navigateFromGlobalCommand(repo, {blockId: deck.id, workspaceId})
        })().catch(error => {
          console.error('[srs-review] opening review from daily note failed', error)
        })
      }}
    >
      {reviewHintLabel(tagName, count)} →
    </button>
  )
}

const ReviewHintLines = ({workspaceId}: {workspaceId: string}) => {
  const [stored] = usePluginPrefsProperty(srsReviewPrefsType, dailyNoteDecksProp)
  const decks = useMemo(() => dailyNoteHintDecks(stored), [stored])
  if (decks.length === 0) return null
  return (
    <div className="mt-1 flex flex-col items-start gap-0.5">
      {decks.map(tag => (
        <DeckHintLine key={tag} workspaceId={workspaceId} tagName={tag} />
      ))}
    </div>
  )
}

const DailyNoteReviewHint = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const workspaceId = useWorkspaceId(block)
  const startOfToday = useStartOfToday()
  const isToday =
    !!workspaceId && block.id === dailyNoteBlockId(workspaceId, todayIso(new Date(startOfToday)))
  return (
    <>
      <Inner block={block} />
      {isToday && (
        // The prefs read suspends until the plugin's prefs block loads;
        // keep that off the title's render path.
        <Suspense fallback={null}>
          <ReviewHintLines workspaceId={workspaceId} />
        </Suspense>
      )}
    </>
  )
}

const decorateDailyNoteWithReviewHint = cachedContentDecorator(
  DailyNoteReviewHint as ComponentType<{block: Block; Inner: BlockRenderer}>,
  'WithSrsDailyNoteReviewHint',
)

/** `isTopLevel` keeps the hint off breadcrumbs, embeds and backlink
 *  entries, where it would render once per occurrence. Every daily note
 *  mounts the decorator; the component gates on today reactively. */
export const srsDailyNoteReviewHintDecorator: BlockContentDecoratorContribution = ctx => {
  if (!ctx.types.includes(DAILY_NOTE_TYPE)) return null
  if (!ctx.isTopLevel) return null
  return decorateDailyNoteWithReviewHint
}
