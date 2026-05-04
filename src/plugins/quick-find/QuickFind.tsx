import { useState, useEffect, useMemo, KeyboardEvent } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { useRepo } from '@/context/repo.tsx'
import { useUserPrefsBlock, useUserPrefsProperty } from '@/data/globalState.ts'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties.ts'
import { v4 as uuidv4 } from 'uuid'
import { writeAppHash } from '@/utils/routing.ts'
import { parseRelativeDate } from '@/utils/relativeDate.ts'
import { getOrCreateDailyNote } from '@/data/dailyNotes.ts'
import { formatRoamDate } from '@/utils/dailyPage.ts'
import { toggleQuickFindEvent } from './events.ts'
import { pushRecentBlockId, recentBlockIdsProp } from './recents.ts'

const SEARCH_LIMIT = 25
const DEBOUNCE_MS = 80

interface AliasMatch {
  alias: string
  blockId: string
  content: string
}

interface BlockMatch {
  blockId: string
  content: string
}

interface RecentItem {
  blockId: string
  label: string
}

const truncate = (text: string, max = 80) =>
  text.length > max ? text.slice(0, max - 1) + '…' : text

export function QuickFind() {
  const repo = useRepo()
  const userPrefsBlock = useUserPrefsBlock()
  const [recentIds] = useUserPrefsProperty(recentBlockIdsProp)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [value, setValue] = useState('')
  const [aliasResults, setAliasResults] = useState<AliasMatch[]>([])
  const [blockResults, setBlockResults] = useState<BlockMatch[]>([])
  // Mask stale fetch results when the query is empty so the effect
  // above doesn't need to setState on the empty path.
  const aliases = query.trim() ? aliasResults : []
  const blocks = query.trim() ? blockResults : []
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
    // Empty-query path: no fetch is needed. We don't reset state here
    // — the displayed `aliases` / `blocks` below mask stale results
    // when the query is empty, which keeps this effect free of the
    // set-state-in-effect anti-pattern.
    if (!query.trim()) return

    let cancelled = false
    const timer = setTimeout(async () => {
      const [aliasRows, blockRows] = await Promise.all([
        repo.query.aliasMatches({workspaceId, filter: query, limit: SEARCH_LIMIT}).load(),
        repo.query.searchByContent({workspaceId, query, limit: SEARCH_LIMIT}).load(),
      ])
      if (cancelled) return

      const aliasBlockIds = new Set(aliasRows.map(row => row.blockId))
      const blockMatches: BlockMatch[] = []
      for (const block of blockRows) {
        if (aliasBlockIds.has(block.id)) continue
        blockMatches.push({blockId: block.id, content: block.content})
      }

      setAliasResults(aliasRows)
      setBlockResults(blockMatches)
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, query, repo])

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
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    pushRecentBlockId(userPrefsBlock, blockId)
    writeAppHash(workspaceId, blockId)
    setOpen(false)
  }

  const openInNewPanel = (blockId: string) => {
    pushRecentBlockId(userPrefsBlock, blockId)
    window.dispatchEvent(new CustomEvent('open-panel', {detail: {blockId}}))
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
    await repo.tx(async tx => {
      await tx.create({
        id: newId,
        workspaceId,
        parentId: null,
        orderKey: 'a0',
        content: trimmed,
        properties: {[aliasesProp.name]: aliasesProp.codec.encode([trimmed])},
      })
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
    if (openInPanel) openInNewPanel(blockId)
    else jumpToBlock(blockId)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.stopPropagation()
      if (value) handleSelect(value, true)
    }
  }

  const trimmedQuery = query.trim()
  // chrono-node parser is recreated each call; cheap, but memoize to keep
  // the resolved date stable across re-renders for the same input.
  const parsedDate = useMemo(
    () => (trimmedQuery ? parseRelativeDate(trimmedQuery) : null),
    [trimmedQuery],
  )
  const dateLabel = parsedDate ? formatRoamDate(parsedDate.date) : null
  const exactAliasMatch = aliases.some(
    match => match.alias.toLowerCase() === trimmedQuery.toLowerCase(),
  )
  // If the query is itself a date (typed verbatim, like "2026-04-28") the
  // date item already gets us to the daily note — suppress the "Create"
  // fallback so we don't offer a duplicate path for the same intent.
  const showCreate = trimmedQuery.length > 0 && !exactAliasMatch && !parsedDate
  const showRecents = !trimmedQuery && recents.length > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0">
        <DialogTitle className="sr-only">Quick find</DialogTitle>
        <DialogDescription className="sr-only">
          Find or create a page or block by alias or content.
        </DialogDescription>
        <Command
          shouldFilter={false}
          value={value}
          onValueChange={setValue}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5"
        >
          <CommandInput
            placeholder="Find or create page or block..."
            value={query}
            onValueChange={setQuery}
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
                  value={`date:${parsedDate.iso}`}
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
                    value={`page:${match.blockId}:${match.alias}`}
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
                    value={`block:${match.blockId}`}
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
                  value={`create:${trimmedQuery}`}
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
              <Kbd>⇧↵</Kbd> open in panel
            </span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
