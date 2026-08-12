/**
 * Shared "search blocks, pick one" body for pickers built on
 * `searchLinkTargets` (alias matches → "Pages" group, content matches →
 * "Blocks" group) inside a `CommandDialog`. Used by `MergePicker` and
 * `MoveDestinationPicker`, which differ only in title/description/
 * placeholder text, what they exclude from the search, whether the
 * Blocks group applies, and what happens on select — each keeps its own
 * session-resolution and commit logic and just renders this once ready.
 *
 * Unlike the other `openDialog` dialogs (which render with a bare
 * `open`), callers of this component gate its very presence on their own
 * async session resolution — so the dialog doesn't flash before it's
 * known — rather than passing a loading state in here. This component
 * always renders open once mounted.
 */
import { useEffect, useState } from 'react'
import { truncate } from '@/utils/string'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { useRepo } from '@/context/repo.js'
import {
  searchLinkTargets,
  type LinkTargetAliasMatch,
  type LinkTargetBlockMatch,
} from '@/utils/linkTargetAutocomplete.js'

const SEARCH_LIMIT = 25
const DEBOUNCE_MS = 80

interface SearchResultState {
  query: string
  aliases: LinkTargetAliasMatch[]
  blocks: LinkTargetBlockMatch[]
  /** The search for `query` rejected. Distinct from "no matches" — the
   *  empty-state copy has to tell those apart or a broken search reads as
   *  an empty workspace. */
  failed: boolean
}

export interface BlockSearchPickerProps {
  title: string
  description: string
  placeholder: string
  workspaceId: string
  /** Blocks the search must never offer as a result — e.g. the merge
   *  source, or (for a move) the movers plus their whole subtree. */
  excludeBlockIds: readonly string[]
  /** Hides the "Blocks" content-match group, leaving only "Pages" (alias)
   *  results. Defaults to true (show both groups). */
  showBlocks?: boolean
  /** Disables the search input and every result item — for a caller with
   *  a commit pending. Defaults to false. */
  disabled?: boolean
  onSelect: (blockId: string) => void
  onCancel: () => void
}

export function BlockSearchPicker({
  title,
  description,
  placeholder,
  workspaceId,
  excludeBlockIds,
  showBlocks = true,
  disabled = false,
  onSelect,
  onCancel,
}: BlockSearchPickerProps) {
  const repo = useRepo()

  const [query, setQuery] = useState('')
  const [value, setValue] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResultState>({
    query: '',
    aliases: [],
    blocks: [],
    failed: false,
  })

  const trimmedQuery = query.trim()
  // The search effect keys on the exclusion set's CONTENT, not on the
  // array's identity: a caller passing a literal
  // (`excludeBlockIds={[sourceBlockId]}`, as MergePicker does) hands us a
  // fresh array on each of ITS renders, and depending on that identity
  // would restart the debounce and re-issue the search for state changes
  // that have nothing to do with the query. Block ids are uuids, so a
  // comma join is unambiguous.
  const excludeKey = excludeBlockIds.join(',')

  useEffect(() => {
    if (!trimmedQuery) return
    let cancelled = false
    const timer = setTimeout(() => {
      void searchLinkTargets(repo, {
        workspaceId,
        query: trimmedQuery,
        limit: SEARCH_LIMIT,
        excludeBlockIds: excludeKey ? excludeKey.split(',') : [],
      }).then(
        results => {
          if (cancelled) return
          setSearchResults({
            query: trimmedQuery,
            aliases: results.aliases,
            blocks: results.blocks,
            failed: false,
          })
        },
        // `searchLinkTargets` rejects when the alias query fails or when
        // EVERY registered content source does. Unhandled, that left the
        // dialog sitting on "No results." — the same thing it says for a
        // genuinely empty search, so the user retypes forever against a
        // search that isn't running. Reported in place rather than
        // cancelling the dialog: the query is theirs to edit and retry.
        error => {
          console.error('[block-search-picker] search failed', error)
          if (cancelled) return
          setSearchResults({query: trimmedQuery, aliases: [], blocks: [], failed: true})
        },
      )
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trimmedQuery, repo, workspaceId, excludeKey])

  const resultsAreForThisQuery = Boolean(trimmedQuery) && searchResults.query === trimmedQuery
  const searchFailed = resultsAreForThisQuery && searchResults.failed
  const aliases = resultsAreForThisQuery ? searchResults.aliases : []
  const blocks = showBlocks && resultsAreForThisQuery ? searchResults.blocks : []

  return (
    <CommandDialog
      open
      onOpenChange={isOpen => { if (!isOpen) onCancel() }}
      title={title}
      description={description}
      contentClassName="top-[12vh] translate-y-0"
      commandProps={{
        shouldFilter: false,
        value,
        onValueChange: setValue,
      }}
    >
      <CommandInput
        placeholder={placeholder}
        value={query}
        onValueChange={nextQuery => {
          setQuery(nextQuery)
          setValue('')
        }}
        disabled={disabled}
      />
      <CommandList>
        <CommandEmpty>
          {searchFailed
            ? "Search failed — check the console, then edit the query to retry."
            : trimmedQuery ? 'No results.' : 'Type to search.'}
        </CommandEmpty>

        {aliases.length > 0 && (
          <CommandGroup heading="Pages">
            {aliases.map(match => (
              <CommandItem
                key={`page:${match.blockId}:${match.alias}`}
                value={`page:${match.blockId}:${match.alias}`}
                onSelect={() => onSelect(match.blockId)}
                disabled={disabled}
                className="flex justify-between items-center gap-2"
              >
                <span className="truncate">{match.alias}</span>
                {match.content && match.content !== match.alias && (
                  <span className="text-xs text-muted-foreground truncate max-w-[40%]">
                    {truncate(match.content, 50)}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {blocks.length > 0 && (
          <CommandGroup heading="Blocks">
            {blocks.map(match => (
              <CommandItem
                key={`block:${match.blockId}`}
                value={`block:${match.blockId}`}
                onSelect={() => onSelect(match.blockId)}
                disabled={disabled}
              >
                <span className="truncate">{truncate(match.content, 80)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
