import { useState, useEffect, useMemo, KeyboardEvent } from 'react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { useRepo } from '@/context/repo.tsx'
import { useLayoutSessionBlock, usePluginUIStateBlock, usePluginUIStateProperty } from '@/data/globalState.ts'
import { ChangeScope } from '@/data/api'
import { activePanelIdProp, aliasesProp } from '@/data/properties.ts'
import { usePropertyValue } from '@/hooks/block.ts'
import { PAGE_TYPE } from '@/data/blockTypes.ts'
import { v4 as uuidv4 } from 'uuid'
import { useNavigate, useNavigateFromGlobalCommand } from '@/utils/navigation.ts'
import { parseRelativeDate } from '@/utils/relativeDate.ts'
import { getOrCreateDailyNote } from '@/plugins/daily-notes'
import { formatRoamDate } from '@/utils/dailyPage.ts'
import {
  searchLinkTargets,
  type LinkTargetAliasMatch,
  type LinkTargetBlockMatch,
} from '@/utils/linkTargetAutocomplete.ts'
import { toggleQuickFindEvent } from './events.ts'
import { pushRecentBlockId, quickFindUIStateType, recentBlockIdsProp } from './recents.ts'
import {
  nextQuickFindSelection,
  quickFindAliasValue,
  quickFindBlockValue,
  quickFindCreateValue,
  quickFindDateValue,
} from './selection.ts'

const SEARCH_LIMIT = 25
const DEBOUNCE_MS = 80

interface RecentItem {
  blockId: string
  label: string
}

interface SearchResultState {
  query: string
  aliases: LinkTargetAliasMatch[]
  blocks: LinkTargetBlockMatch[]
}

const truncate = (text: string, max = 80) =>
  text.length > max ? text.slice(0, max - 1) + '…' : text

export function QuickFind() {
  const repo = useRepo()
  const quickFindUIStateBlock = usePluginUIStateBlock(quickFindUIStateType)
  const navigate = useNavigate()
  const navigateFromGlobalCommand = useNavigateFromGlobalCommand()
  const layoutSessionBlock = useLayoutSessionBlock()
  const [activePanelId] = usePropertyValue(layoutSessionBlock, activePanelIdProp)
  const [recentIds] = usePluginUIStateProperty(quickFindUIStateType, recentBlockIdsProp)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [value, setValue] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResultState>({
    query: '',
    aliases: [],
    blocks: [],
  })
  const trimmedQuery = query.trim()
  // chrono-node parser is recreated each call; cheap, but memoize to keep
  // the resolved date stable across re-renders for the same input.
  const parsedDate = useMemo(
    () => (trimmedQuery ? parseRelativeDate(trimmedQuery) : null),
    [trimmedQuery],
  )
  const dateItemValue = parsedDate ? quickFindDateValue(parsedDate.iso) : ''
  const dateLabel = parsedDate ? formatRoamDate(parsedDate.date) : null
  const aliases = trimmedQuery && searchResults.query === trimmedQuery ? searchResults.aliases : []
  const blocks = trimmedQuery && searchResults.query === trimmedQuery ? searchResults.blocks : []
  const [recents, setRecents] = useState<RecentItem[]>([])

  useEffect(() => {
    const handleToggle = () => {
      setOpen(prev => {
        const next = !prev
        if (next) {
          setQuery('')
          setValue('')
        }
        return next
      })
    }
    window.addEventListener(toggleQuickFindEvent, handleToggle)
    return () => window.removeEventListener(toggleQuickFindEvent, handleToggle)
  }, [])

  useEffect(() => {
    if (!open) return
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    // Empty-query path: no fetch is needed. The displayed `aliases` /
    // `blocks` are derived from the result query so stale rows stay
    // hidden without clearing state here.
    if (!trimmedQuery) return

    let cancelled = false
    const timer = setTimeout(async () => {
      const results = await searchLinkTargets(repo, {
        workspaceId,
        query: trimmedQuery,
        limit: SEARCH_LIMIT,
      })
      if (cancelled) return

      setSearchResults({
        query: trimmedQuery,
        aliases: results.aliases,
        blocks: results.blocks,
      })

      setValue(current => nextQuickFindSelection({
        query: trimmedQuery,
        aliases: results.aliases,
        blocks: results.blocks,
        dateValue: dateItemValue,
        currentValue: current,
      }))
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, trimmedQuery, dateItemValue, repo])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    const ids = recentIds ?? []
    const load = async () => {
      const items: RecentItem[] = []
      for (const id of ids) {
        const data = await repo.load(id)
        if (!data) continue
        const blockAliases = (data.properties[aliasesProp.name] as string[] | undefined) ?? []
        items.push({blockId: id, label: blockAliases[0] ?? data.content ?? id})
      }
      if (!cancelled) setRecents(items)
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [open, recentIds, repo])

  const jumpToBlock = (blockId: string) => {
    if (!repo.activeWorkspaceId) return
    pushRecentBlockId(quickFindUIStateBlock, blockId)
    navigateFromGlobalCommand({blockId})
    setOpen(false)
  }

  const openInStackedPanel = (blockId: string) => {
    pushRecentBlockId(quickFindUIStateBlock, blockId)
    navigate({blockId, target: 'sidebar-stack', sourcePanelId: activePanelId})
    setOpen(false)
  }

  const createPage = async (alias: string) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const trimmed = alias.trim()
    if (!trimmed) return

    const existing = await repo.query.aliasLookup({workspaceId, alias: trimmed}).load()
    if (existing) {
      jumpToBlock(existing.id)
      return
    }

    const newId = uuidv4()
    const typeSnapshot = repo.snapshotTypeRegistries()
    await repo.tx(async tx => {
      await tx.create({
        id: newId,
        workspaceId,
        parentId: null,
        orderKey: 'a0',
        content: trimmed,
      })
      await repo.addTypeInTx(tx, newId, PAGE_TYPE, {[aliasesProp.name]: [trimmed]}, typeSnapshot)
    }, {scope: ChangeScope.BlockDefault, description: 'create page from QuickFind'})
    jumpToBlock(newId)
  }

  const openDailyNote = async (iso: string) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const note = await getOrCreateDailyNote(repo, workspaceId, iso)
    jumpToBlock(note.id)
  }

  const handleSelect = (selectedValue: string, openInPanel: boolean) => {
    const colonIdx = selectedValue.indexOf(':')
    if (colonIdx === -1) return
    const kind = selectedValue.slice(0, colonIdx)
    const payload = selectedValue.slice(colonIdx + 1)

    if (kind === 'create') {
      void createPage(payload)
      return
    }
    if (kind === 'date') {
      void openDailyNote(payload)
      return
    }
    const blockId = payload.split(':')[0]
    if (!blockId) return
    if (openInPanel) openInStackedPanel(blockId)
    else jumpToBlock(blockId)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      if (value) handleSelect(value, true)
    }
  }

  const exactAliasMatch = aliases.some(
    match => match.alias.toLowerCase() === trimmedQuery.toLowerCase(),
  )
  // If the query is itself a date (typed verbatim, like "2026-04-28") the
  // date item already gets us to the daily note — suppress the "Create"
  // fallback so we don't offer a duplicate path for the same intent.
  const showCreate = trimmedQuery.length > 0 && !exactAliasMatch && !parsedDate
  const showRecents = !trimmedQuery && recents.length > 0

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Quick find"
      description="Find or create a page or block by alias or content."
      contentClassName="top-[12vh] translate-y-0"
      commandProps={{
        shouldFilter: false,
        value,
        onValueChange: setValue,
      }}
    >
      <CommandInput
        placeholder="Find or create page or block..."
        value={query}
        onValueChange={nextQuery => {
          setQuery(nextQuery)
          setValue('')
        }}
        onKeyDown={handleKeyDown}
      />
      <CommandList>
        <CommandEmpty>
          {trimmedQuery ? 'No results.' : 'Type to search.'}
        </CommandEmpty>

        {showRecents && (
          <CommandGroup heading="Recent">
            {recents.map(item => (
              <CommandItem
                key={`recent:${item.blockId}`}
                value={`recent:${item.blockId}`}
                onSelect={selectedValue => handleSelect(selectedValue, false)}
                className="flex justify-between items-center"
              >
                <span className="truncate">{truncate(item.label)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {parsedDate && (
          <CommandGroup heading="Date">
            <CommandItem
              key={`date:${parsedDate.iso}`}
              value={dateItemValue}
              onSelect={selectedValue => handleSelect(selectedValue, false)}
              className="flex justify-between items-center gap-2"
            >
              <span className="truncate">{dateLabel}</span>
              <span className="text-xs text-muted-foreground">{parsedDate.iso}</span>
            </CommandItem>
          </CommandGroup>
        )}

        {aliases.length > 0 && (
          <CommandGroup heading="Pages">
            {aliases.map(match => (
              <CommandItem
                key={`page:${match.blockId}:${match.alias}`}
                value={quickFindAliasValue(match)}
                onSelect={selectedValue => handleSelect(selectedValue, false)}
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
                value={quickFindBlockValue(match)}
                onSelect={selectedValue => handleSelect(selectedValue, false)}
              >
                <span className="truncate">{truncate(match.content)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {showCreate && (
          <CommandGroup heading="Create">
            <CommandItem
              key={`create:${trimmedQuery}`}
              value={quickFindCreateValue(trimmedQuery)}
              onSelect={selectedValue => handleSelect(selectedValue, false)}
            >
              <span>Create page “{trimmedQuery}”</span>
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex justify-end gap-3 border-t px-3 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> jump
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⇧↵</Kbd> open in stack
        </span>
      </div>
    </CommandDialog>
  )
}
