/**
 * Picker modal for "move these block(s) to…". Opened via
 * `openDialog(MoveDestinationPicker, {blockIds, workspaceId})` from
 * `move-blocks.move-to` / `multi_select.move-blocks.move-to`.
 *
 * Structurally a clone of `MergePicker` (search box + Pages/Blocks
 * result groups over `searchLinkTargets`) — the direction of the
 * relationship is the only real difference: this picker never touches
 * the repo itself, it just resolves `{destinationId}` back to the
 * action, which runs `moveBlocksTo`. That keeps the mutation (and its
 * undo-group + error handling) in one place instead of split between
 * dialog and action.
 *
 * `excludeBlockIds` for the search is the movers PLUS all of their
 * descendants — offering a destination inside a mover's own subtree
 * would be refused downstream (`core.move` throws `CycleError`), so
 * the picker filters it out up front rather than surface a dead-end
 * result. Descendants are resolved once at open time via
 * `repo.query.subtree`.
 */
import { useEffect, useRef, useState } from 'react'
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
import type { DialogContextProps } from '@/utils/dialogs.js'

const SEARCH_LIMIT = 25
const DEBOUNCE_MS = 80

interface ActiveSession {
  workspaceId: string
  /** Movers plus every one of their descendants — resolved once at
   *  open time so search never offers a destination that `core.move`
   *  would refuse as a cycle. */
  excludeBlockIds: string[]
}

interface SearchResultState {
  query: string
  aliases: LinkTargetAliasMatch[]
  blocks: LinkTargetBlockMatch[]
}

export interface MoveDestinationPickerResult {
  destinationId: string
}

export interface MoveDestinationPickerProps {
  blockIds: readonly string[]
  workspaceId: string
}

export function MoveDestinationPicker({
  blockIds,
  workspaceId,
  resolve,
  cancel,
}: DialogContextProps<MoveDestinationPickerResult> & MoveDestinationPickerProps) {
  const repo = useRepo()

  const [session, setSession] = useState<ActiveSession | null>(null)
  const [query, setQuery] = useState('')
  const [value, setValue] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResultState>({
    query: '',
    aliases: [],
    blocks: [],
  })

  // The finalize callbacks are fresh closures from the DialogHost on
  // each of its renders; read them through a ref so the load effect can
  // bail without depending on (and re-running for) their identity.
  const cancelRef = useRef(cancel)
  useEffect(() => {
    cancelRef.current = cancel
  })

  // Resolve the movers' combined subtree once on mount so the exclude
  // set is stable for the life of the dialog.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (blockIds.length === 0) {
        cancelRef.current()
        return
      }
      // Structural (not visible-outline) subtree: excluding a destination
      // is a correctness concern (avoiding `core.move`'s `CycleError`),
      // so a descendant hidden behind property-field machinery must be
      // excluded too, not just what the outline renders.
      const subtrees = await Promise.all(
        blockIds.map(id => repo.query.subtree({id, hidePropertyChildren: false}).load()),
      )
      if (cancelled) return
      const excludeBlockIds = new Set<string>(blockIds)
      for (const rows of subtrees) {
        for (const row of rows) excludeBlockIds.add(row.id)
      }
      setSession({
        workspaceId,
        excludeBlockIds: Array.from(excludeBlockIds),
      })
    })()
    return () => { cancelled = true }
  }, [repo, blockIds, workspaceId])

  const trimmedQuery = query.trim()

  useEffect(() => {
    if (!session || !trimmedQuery) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const results = await searchLinkTargets(repo, {
        workspaceId: session.workspaceId,
        query: trimmedQuery,
        limit: SEARCH_LIMIT,
        excludeBlockIds: session.excludeBlockIds,
      })
      if (cancelled) return
      setSearchResults({
        query: trimmedQuery,
        aliases: results.aliases,
        blocks: results.blocks,
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [session, trimmedQuery, repo])

  const commit = (destinationId: string): void => {
    if (!session) return
    resolve({destinationId})
  }

  if (!session) return null

  const aliases = trimmedQuery && searchResults.query === trimmedQuery
    ? searchResults.aliases
    : []
  const blocks = trimmedQuery && searchResults.query === trimmedQuery
    ? searchResults.blocks
    : []

  const count = blockIds.length
  const title = count > 1 ? `Move ${count} blocks to…` : 'Move this block to…'

  return (
    // Unlike the other openDialog dialogs (which render with a bare
    // `open`), this one gates visibility on `session` — the async
    // subtree resolution that decides the exclude set — so the
    // CommandDialog doesn't flash before it's known.
    <CommandDialog
      open={session !== null}
      onOpenChange={isOpen => { if (!isOpen) cancel() }}
      title={title}
      description="The moved block(s) land as the last children of whatever you pick here."
      contentClassName="top-[12vh] translate-y-0"
      commandProps={{
        shouldFilter: false,
        value,
        onValueChange: setValue,
      }}
    >
      <CommandInput
        placeholder="Find destination…"
        value={query}
        onValueChange={nextQuery => {
          setQuery(nextQuery)
          setValue('')
        }}
      />
      <CommandList>
        <CommandEmpty>
          {trimmedQuery ? 'No results.' : 'Type to search.'}
        </CommandEmpty>

        {aliases.length > 0 && (
          <CommandGroup heading="Pages">
            {aliases.map(match => (
              <CommandItem
                key={`page:${match.blockId}:${match.alias}`}
                value={`page:${match.blockId}:${match.alias}`}
                onSelect={() => commit(match.blockId)}
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
                onSelect={() => commit(match.blockId)}
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
