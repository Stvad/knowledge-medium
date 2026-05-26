import {
  Suspense,
  use,
  useState,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { useUser } from '@/components/Login.js'
import { useRepo } from '@/context/repo.js'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { activePanelIdProp, aliasesProp } from '@/data/properties.js'
import { usePropertyValue } from '@/hooks/block.js'
import { PAGE_TYPE } from '@/data/blockTypes.js'
import { v4 as uuidv4 } from 'uuid'
import { useNavigate, useNavigateFromGlobalCommand } from '@/utils/navigation.js'
import { parseRelativeDate, relativeDateCandidates } from '@/utils/relativeDate.js'
import { getOrCreateDailyNote } from '@/plugins/daily-notes'
import { formatRoamDate } from '@/utils/dailyPage.js'
import { getLayoutSessionId } from '@/utils/layoutSessionId.js'
import {
  searchLinkTargetsProgressively,
  type LinkTargetAliasMatch,
  type LinkTargetBlockMatch,
} from '@/utils/linkTargetAutocomplete.js'
import {
  getLayoutSessionBlock,
  getPluginUIStateBlock,
  getUIStateBlock,
  requireWorkspaceId,
} from '@/data/stateBlocks.js'
import { toggleQuickFindEvent } from './events.ts'
import { pushRecentBlockId, quickFindUIStateType, recentBlockIdsProp } from './recents.ts'
import {
  nextQuickFindSelection,
  quickFindAliasValue,
  quickFindBlockValue,
  quickFindCreateValue,
  quickFindDateValue,
  quickFindOpenTargetFromClickModifiers,
  quickFindOpenTargetFromModifiers,
  quickFindSelectionAction,
  type QuickFindOpenTarget,
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

interface QuickFindDialogResources {
  quickFindUIStateBlock: Block
  layoutSessionBlock: Block
}

const truncate = (text: string, max = 80) =>
  text.length > max ? text.slice(0, max - 1) + '…' : text

export function QuickFind() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handleToggle = () => {
      setOpen(prev => !prev)
    }
    window.addEventListener(toggleQuickFindEvent, handleToggle)
    return () => window.removeEventListener(toggleQuickFindEvent, handleToggle)
  }, [])

  if (!open) return null

  return (
    <Suspense fallback={null}>
      <QuickFindResources open={open} onOpenChange={setOpen}/>
    </Suspense>
  )
}

function QuickFindResources({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const repo = useRepo()
  const user = useUser()
  const workspaceId = requireWorkspaceId(repo, 'QuickFind')
  const resourcesPromise = useMemo((): Promise<QuickFindDialogResources> => (async () => {
    const rootUIStateBlock = await getUIStateBlock(repo, workspaceId, user, {})
    const [quickFindUIStateBlock, layoutSessionBlock] = await Promise.all([
      getPluginUIStateBlock(repo, workspaceId, user, quickFindUIStateType),
      getLayoutSessionBlock(rootUIStateBlock, getLayoutSessionId()),
    ])
    return {quickFindUIStateBlock, layoutSessionBlock}
  })(), [repo, user, workspaceId])
  const {quickFindUIStateBlock, layoutSessionBlock} = use(resourcesPromise)

  return (
    <QuickFindDialog
      open={open}
      onOpenChange={onOpenChange}
      quickFindUIStateBlock={quickFindUIStateBlock}
      layoutSessionBlock={layoutSessionBlock}
    />
  )
}

function QuickFindDialog({
  open,
  onOpenChange,
  quickFindUIStateBlock,
  layoutSessionBlock,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  quickFindUIStateBlock: Block
  layoutSessionBlock: Block
}) {
  const repo = useRepo()
  const navigate = useNavigate()
  const navigateFromGlobalCommand = useNavigateFromGlobalCommand()
  const [activePanelId] = usePropertyValue(layoutSessionBlock, activePanelIdProp)
  const [recentIds] = usePropertyValue(quickFindUIStateBlock, recentBlockIdsProp)

  const [query, setQuery] = useState('')
  const [value, setValue] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResultState>({
    query: '',
    aliases: [],
    blocks: [],
  })
  const pendingClickTarget = useRef<QuickFindOpenTarget | null>(null)
  const trimmedQuery = query.trim()
  // chrono-node parser is recreated each call; cheap, but memoize to keep
  // the resolved date stable across re-renders for the same input.
  const parsedDate = useMemo(
    () => (trimmedQuery ? parseRelativeDate(trimmedQuery) : null),
    [trimmedQuery],
  )
  const dateCandidates = useMemo(
    () => (trimmedQuery ? relativeDateCandidates(trimmedQuery) : []),
    [trimmedQuery],
  )
  const dateValues = useMemo(
    () => dateCandidates.map(candidate => quickFindDateValue(candidate.iso)),
    [dateCandidates],
  )
  const aliases = trimmedQuery && searchResults.query === trimmedQuery ? searchResults.aliases : []
  const blocks = trimmedQuery && searchResults.query === trimmedQuery ? searchResults.blocks : []
  const [recents, setRecents] = useState<RecentItem[]>([])

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
      await searchLinkTargetsProgressively(repo, {
        workspaceId,
        query: trimmedQuery,
        limit: SEARCH_LIMIT,
        recentBlockIds: recentIds ?? undefined,
      }, {
        onAliases: aliasResults => {
          if (cancelled) return
          setSearchResults({
            query: trimmedQuery,
            aliases: aliasResults,
            blocks: [],
          })
          setValue(current => nextQuickFindSelection({
            query: trimmedQuery,
            aliases: aliasResults,
            blocks: [],
            dateValues,
            currentValue: current,
          }))
        },
        onBlocks: (blockResults, results) => {
          if (cancelled) return
          setSearchResults({
            query: trimmedQuery,
            aliases: results.aliases,
            blocks: blockResults,
          })
          setValue(current => nextQuickFindSelection({
            query: trimmedQuery,
            aliases: results.aliases,
            blocks: blockResults,
            dateValues,
            currentValue: current,
          }))
        },
      })
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, trimmedQuery, dateValues, repo, recentIds])

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

  const openResolvedBlock = (blockId: string, target: QuickFindOpenTarget) => {
    if (!repo.activeWorkspaceId) return
    pushRecentBlockId(quickFindUIStateBlock, blockId)
    if (target === 'stack') {
      navigate({blockId, target: 'sidebar-stack', sourcePanelId: activePanelId})
    } else if (target === 'new-panel') {
      navigate({blockId, target: 'new-panel', sourcePanelId: activePanelId})
    } else {
      navigateFromGlobalCommand({blockId})
    }
    onOpenChange(false)
  }

  const createPage = async (alias: string, target: QuickFindOpenTarget) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const trimmed = alias.trim()
    if (!trimmed) return

    const existing = await repo.query.aliasLookup({workspaceId, alias: trimmed}).load()
    if (existing) {
      openResolvedBlock(existing.id, target)
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
    openResolvedBlock(newId, target)
  }

  const openDailyNote = async (iso: string, target: QuickFindOpenTarget) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId) return
    const note = await getOrCreateDailyNote(repo, workspaceId, iso)
    openResolvedBlock(note.id, target)
  }

  const handleSelect = (selectedValue: string, target: QuickFindOpenTarget) => {
    const action = quickFindSelectionAction(selectedValue, target)
    if (!action) return

    if (action.kind === 'create-page') {
      void createPage(action.alias, action.target)
      return
    }
    if (action.kind === 'open-date') {
      void openDailyNote(action.iso, action.target)
      return
    }
    openResolvedBlock(action.blockId, action.target)
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return
    const target = quickFindOpenTargetFromModifiers(event)
    // Plain Enter falls through to cmdk's onSelect, which routes to the
    // default 'jump'. We only intercept when a modifier picks a non-default
    // target so we can pass it through pendingClickTarget's role.
    if (target === 'jump') return
    event.preventDefault()
    event.stopPropagation()
    if (value) handleSelect(value, target)
  }

  const handleItemClickCapture = (event: MouseEvent) => {
    pendingClickTarget.current = quickFindOpenTargetFromClickModifiers(event)
  }

  const handleItemSelect = (selectedValue: string) => {
    const target = pendingClickTarget.current ?? 'jump'
    pendingClickTarget.current = null
    handleSelect(selectedValue, target)
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
      onOpenChange={onOpenChange}
      title="Quick find"
      description="Find or create a page or block by alias or content."
      contentClassName="top-[12vh] translate-y-0"
      commandProps={{
        shouldFilter: false,
        value,
        onValueChange: setValue,
        onKeyDown: handleKeyDown,
      }}
    >
      <CommandInput
        placeholder="Find or create page or block..."
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

        {showRecents && (
          <CommandGroup heading="Recent">
            {recents.map(item => (
              <CommandItem
                key={`recent:${item.blockId}`}
                value={`recent:${item.blockId}`}
                onClickCapture={handleItemClickCapture}
                onSelect={handleItemSelect}
                className="flex justify-between items-center"
              >
                <span className="truncate">{truncate(item.label)}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {dateCandidates.length > 0 && (
          <CommandGroup heading="Date">
            {dateCandidates.map((candidate, index) => {
              const detail = candidate.phrase.toLowerCase() === trimmedQuery.toLowerCase()
                ? candidate.iso
                : candidate.phrase
              return (
                <CommandItem
                  key={`date:${candidate.iso}:${candidate.phrase}`}
                  value={dateValues[index]}
                  onClickCapture={handleItemClickCapture}
                  onSelect={handleItemSelect}
                  className="flex justify-between items-center gap-2"
                >
                  <span className="truncate">{formatRoamDate(candidate.date)}</span>
                  <span className="text-xs text-muted-foreground">{detail}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}

        {aliases.length > 0 && (
          <CommandGroup heading="Pages">
            {aliases.map(match => (
              <CommandItem
                key={`page:${match.blockId}:${match.alias}`}
                value={quickFindAliasValue(match)}
                onClickCapture={handleItemClickCapture}
                onSelect={handleItemSelect}
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
                onClickCapture={handleItemClickCapture}
                onSelect={handleItemSelect}
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
              onClickCapture={handleItemClickCapture}
              onSelect={handleItemSelect}
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
        <span className="flex items-center gap-1">
          <Kbd>⇧⌥↵</Kbd> new panel
        </span>
      </div>
    </CommandDialog>
  )
}
