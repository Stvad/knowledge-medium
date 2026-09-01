import { useMemo } from 'react'
import { CalendarCheck, CalendarPlus, Layers, Tag } from 'lucide-react'
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { usePluginPrefsBlock, usePluginPrefsProperty } from '@/data/globalState.js'
import { cn } from '@/lib/utils.js'
import {
  blockTaggingPrefsType,
  blockTagsConfigProp,
  normalizeBlockTagsConfig,
} from '@/plugins/block-tagging/config.js'
import { useDueCardCount } from './useDueCards.ts'
import { startReviewDeck } from './deck.ts'
import {
  dailyNoteDecksProp,
  normalizeDailyNoteDecks,
  srsReviewPrefsType,
} from './schema.ts'

interface DeckOptionProps {
  workspaceId: string
  /** '' is the all-due deck. */
  tagName: string
  label: string
  icon: typeof Tag
  onPick: () => void
  /** Whether this deck's due count is surfaced on today's daily note. */
  pinned: boolean
  onTogglePinned: () => void
}

const DeckOption = ({workspaceId, tagName, label, icon: Icon, onPick, pinned, onTogglePinned}: DeckOptionProps) => {
  // The picker wants a number, not the cards. Counting in SQLite keeps a
  // workspace with many decks from materialising every due card in each of
  // them just to render a badge.
  const count = useDueCardCount(workspaceId, tagName) ?? 0
  return (
    <div className="flex items-stretch gap-1">
      <button
        type="button"
        onClick={onPick}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
          count > 0
            ? 'border-border bg-background hover:bg-muted'
            : 'border-border/60 bg-background text-muted-foreground hover:bg-muted',
        )}
      >
        <Icon className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate font-medium">{label}</span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
            count > 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
          {count} due
        </span>
      </button>
      <button
        type="button"
        onClick={onTogglePinned}
        aria-pressed={pinned}
        // The deck name goes into the accessible name — with several decks,
        // identical icon-only toggles are indistinguishable to a screen
        // reader; `aria-pressed` only carries the state.
        aria-label={pinned
          ? `Hide ${label} from today’s daily note`
          : `Show ${label} on today’s daily note`}
        title={pinned
          ? `Hide ${label} from today’s daily note`
          : `Show ${label} on today’s daily note`}
        className={cn(
          'flex shrink-0 items-center rounded-lg border px-2.5 transition-colors hover:bg-muted',
          pinned ? 'border-border text-primary' : 'border-border/60 text-muted-foreground',
        )}
      >
        {pinned ? <CalendarCheck className="h-4 w-4" /> : <CalendarPlus className="h-4 w-4" />}
      </button>
    </div>
  )
}

/** Deck selection surface shown by the deck renderer until a deck is
 *  started. Lists an "all due" deck plus every tag in the workspace's
 *  curated tag list, each with a live due count and a toggle controlling
 *  whether the deck's count is surfaced on today's daily note. */
export const DeckPicker = ({deck}: {deck: Block}) => {
  const repo = useRepo()
  const workspaceId = deck.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ''
  const [storedTags] = usePluginPrefsProperty(blockTaggingPrefsType, blockTagsConfigProp)
  const tags = useMemo(() => normalizeBlockTagsConfig(storedTags), [storedTags])

  // Same never-configured fallback the daily-note hint reads (all-due deck
  // pinned), so the toggles here show what the note actually shows. The
  // first toggle materialises the explicit list.
  const prefsBlock = usePluginPrefsBlock(srsReviewPrefsType)
  const [storedDecks] = usePluginPrefsProperty(srsReviewPrefsType, dailyNoteDecksProp)
  const pinnedDecks = useMemo(() => normalizeDailyNoteDecks(storedDecks) ?? [''], [storedDecks])
  // Re-read inside the tx, not from `pinnedDecks`: two quick toggles both
  // computing from the render-time snapshot would each write the whole
  // array and the second would undo the first.
  const togglePinned = (tagName: string) =>
    void prefsBlock.repo.tx(
      async tx => {
        const current =
          normalizeDailyNoteDecks(await tx.getProperty(prefsBlock.id, dailyNoteDecksProp)) ?? ['']
        await tx.setProperty(
          prefsBlock.id,
          dailyNoteDecksProp,
          current.includes(tagName)
            ? current.filter(t => t !== tagName)
            : [...current, tagName],
        )
      },
      {scope: ChangeScope.UserPrefs, description: 'toggle srs daily-note deck'},
    )

  return (
    <div className="mx-auto w-full max-w-xl space-y-4 py-4">
      <div>
        <h2 className="text-lg font-semibold">Spaced repetition review</h2>
        <p className="text-sm text-muted-foreground">
          Pick a deck to review cards due today or earlier.
        </p>
      </div>

      <div className="space-y-2">
        <DeckOption
          workspaceId={workspaceId}
          tagName=""
          label="All due cards"
          icon={Layers}
          onPick={() => void startReviewDeck(deck, '')}
          pinned={pinnedDecks.includes('')}
          onTogglePinned={() => togglePinned('')}
        />
        {tags.map(tag => (
          <DeckOption
            key={tag}
            workspaceId={workspaceId}
            tagName={tag}
            label={tag}
            icon={Tag}
            onPick={() => void startReviewDeck(deck, tag)}
            pinned={pinnedDecks.includes(tag)}
            onTogglePinned={() => togglePinned(tag)}
          />
        ))}
      </div>

      {tags.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No tags configured yet. Add tag names under the &quot;Tags&quot; entry in
          Preferences to review tag-scoped decks, or start with all due cards above.
        </p>
      )}
    </div>
  )
}
