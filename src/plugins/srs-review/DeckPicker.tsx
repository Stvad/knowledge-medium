import { useMemo } from 'react'
import { Layers, Tag } from 'lucide-react'
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import { useRepo } from '@/context/repo.js'
import { usePluginPrefsProperty } from '@/data/globalState.js'
import { cn } from '@/lib/utils.js'
import {
  blockTaggingPrefsType,
  blockTagsConfigProp,
  normalizeBlockTagsConfig,
} from '@/plugins/block-tagging/config.js'
import { useDueCards } from './useDueCards.ts'
import { reviewDeckStartedProp, reviewDeckTagProp } from './schema.ts'

const startDeck = async (deck: Block, tagName: string): Promise<void> => {
  await deck.repo.tx(
    async tx => {
      await tx.setProperty(deck.id, reviewDeckTagProp, tagName)
      await tx.setProperty(deck.id, reviewDeckStartedProp, true)
    },
    {scope: ChangeScope.BlockDefault, description: 'start srs review deck'},
  )
}

interface DeckOptionProps {
  workspaceId: string
  /** '' is the all-due deck. */
  tagName: string
  label: string
  icon: typeof Tag
  onPick: () => void
}

const DeckOption = ({workspaceId, tagName, label, icon: Icon, onPick}: DeckOptionProps) => {
  const due = useDueCards(workspaceId, tagName)
  const count = due.length
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
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
  )
}

/** Deck selection surface shown by the deck renderer until a deck is
 *  started. Lists an "all due" deck plus every tag in the workspace's
 *  curated tag list, each with a live due count. */
export const DeckPicker = ({deck}: {deck: Block}) => {
  const repo = useRepo()
  const workspaceId = deck.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ''
  const [storedTags] = usePluginPrefsProperty(blockTaggingPrefsType, blockTagsConfigProp)
  const tags = useMemo(() => normalizeBlockTagsConfig(storedTags), [storedTags])

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
          onPick={() => void startDeck(deck, '')}
        />
        {tags.map(tag => (
          <DeckOption
            key={tag}
            workspaceId={workspaceId}
            tagName={tag}
            label={tag}
            icon={Tag}
            onPick={() => void startDeck(deck, tag)}
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
