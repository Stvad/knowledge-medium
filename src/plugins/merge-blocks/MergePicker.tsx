/**
 * Picker modal for "merge this block into…". Opened via
 * `openDialog(MergePicker, {sourceBlockId, workspaceId})` from the
 * `merge_blocks.merge_into` action.
 *
 * Direction: the currently-focused block is the SOURCE (folds into the
 * pick and is soft-deleted); the picked block is the TARGET. Picker
 * results filter to pages only when the source is itself a page —
 * otherwise the picker is more useful as an open block-search (mirrors
 * `QuickFind`'s aliases + blocks groups).
 *
 * Content strategy is chosen at commit time by `pickMergeContentStrategy`
 * (page-involving merges keep target, outline-block merges concat) so
 * the kernel `core.merge` mutator stays generic.
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
import { PAGE_TYPE } from '@/data/blockTypes.js'
import { hasBlockType } from '@/data/properties.js'
import { useNavigate } from '@/utils/navigation.js'
import {
  searchLinkTargets,
  type LinkTargetAliasMatch,
  type LinkTargetBlockMatch,
} from '@/utils/linkTargetAutocomplete.js'
import type { DialogContextProps } from '@/utils/dialogs.js'
import { pickMergeContentStrategy } from './strategy.ts'

const SEARCH_LIMIT = 25
const DEBOUNCE_MS = 80


interface ActiveSession {
  sourceBlockId: string
  workspaceId: string
  /** Source's page-ness is sampled at open time so we don't have to
   *  re-read the block on every keystroke to decide which results group
   *  to filter. */
  sourceIsPage: boolean
}

interface SearchResultState {
  query: string
  aliases: LinkTargetAliasMatch[]
  blocks: LinkTargetBlockMatch[]
}

export interface MergePickerProps {
  sourceBlockId: string
  workspaceId: string
}

export function MergePicker({
  sourceBlockId,
  workspaceId,
  resolve,
  cancel,
}: DialogContextProps<void> & MergePickerProps) {
  const repo = useRepo()
  const navigate = useNavigate()

  const [session, setSession] = useState<ActiveSession | null>(null)
  const [query, setQuery] = useState('')
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)
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

  // Resolve the source block once on mount to decide page-vs-block
  // search filtering. Closes the dialog if the source vanished.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const sourceBlock = repo.block(sourceBlockId)
      const data = sourceBlock.peek() ?? await sourceBlock.load()
      if (cancelled) return
      if (!data) {
        console.error(`[merge-blocks] source ${sourceBlockId} not found`)
        cancelRef.current()
        return
      }
      setSession({
        sourceBlockId,
        workspaceId,
        sourceIsPage: hasBlockType(data, PAGE_TYPE),
      })
    })()
    return () => { cancelled = true }
  }, [repo, sourceBlockId, workspaceId])

  const trimmedQuery = query.trim()

  useEffect(() => {
    if (!session || !trimmedQuery) return
    let cancelled = false
    const timer = setTimeout(async () => {
      const results = await searchLinkTargets(repo, {
        workspaceId: session.workspaceId,
        query: trimmedQuery,
        limit: SEARCH_LIMIT,
        excludeBlockIds: [session.sourceBlockId],
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

  const commit = async (targetBlockId: string) => {
    if (!session || pending) return
    setPending(true)
    try {
      const sourceBlock = repo.block(session.sourceBlockId)
      const targetBlock = repo.block(targetBlockId)
      const sourceData = sourceBlock.peek() ?? await sourceBlock.load()
      const targetData = targetBlock.peek() ?? await targetBlock.load()
      if (!sourceData || !targetData) {
        console.error('[merge-blocks] source or target missing at commit')
        return
      }
      const contentStrategy = pickMergeContentStrategy(sourceData, targetData)
      await repo.mutate.merge({
        intoId: targetBlockId,
        fromId: session.sourceBlockId,
        contentStrategy,
      })
      // If source was a page it was very likely the panel's top-level
      // block; navigate the active panel to target so the user doesn't
      // land on a soft-deleted view. For non-page sources we leave the
      // panel alone — the source just vanishes from its outline.
      if (session.sourceIsPage) {
        navigate({blockId: targetBlockId, target: 'active'})
      }
    } catch (error) {
      // Surface failure to the console at minimum so a busted commit
      // isn't completely silent. Toast plumbing for merge errors can
      // come later if this surface grows teeth.
      console.error('[merge-blocks] merge failed', error)
    } finally {
      resolve()
    }
  }

  if (!session) return null

  // Source is a page → only the aliases group is meaningful (pages are
  // identified by alias). Content-match blocks are typically outline
  // rows and would muddle the picker for the page-consolidation flow.
  const showBlocks = !session.sourceIsPage
  const aliases = trimmedQuery && searchResults.query === trimmedQuery
    ? searchResults.aliases
    : []
  const blocks = showBlocks && trimmedQuery && searchResults.query === trimmedQuery
    ? searchResults.blocks
    : []

  return (
    // Unlike the other openDialog dialogs (which render with a bare
    // `open`), this one gates visibility on `session` — the async
    // source-block load that decides page-vs-block search — so the
    // CommandDialog doesn't flash before `sourceIsPage` is known.
    <CommandDialog
      open={session !== null}
      onOpenChange={isOpen => { if (!isOpen) cancel() }}
      title={session.sourceIsPage ? 'Merge this page into…' : 'Merge this block into…'}
      description={
        session.sourceIsPage
          ? 'Source page (with this block\'s content + properties) folds into the picked page; aliases union so old links keep resolving.'
          : 'This block\'s content + children fold into the picked block, then this block is removed.'
      }
      contentClassName="top-[12vh] translate-y-0"
      commandProps={{
        shouldFilter: false,
        value,
        onValueChange: setValue,
      }}
    >
      <CommandInput
        placeholder={session.sourceIsPage ? 'Find page to merge into…' : 'Find target block…'}
        value={query}
        onValueChange={nextQuery => {
          setQuery(nextQuery)
          setValue('')
        }}
        disabled={pending}
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
                onSelect={() => { void commit(match.blockId) }}
                disabled={pending}
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
                onSelect={() => { void commit(match.blockId) }}
                disabled={pending}
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
