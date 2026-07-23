import {
  Suspense,
  use,
  useId,
  useState,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { Search } from 'lucide-react'
import { truncate } from '@/utils/string'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { quickFindToggle } from './toggleStore.ts'
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

export interface QuickFindListItem {
  key: string
  value: string
  children: ReactNode
  className?: string
}

export interface QuickFindListGroup {
  heading: string
  items: QuickFindListItem[]
}


const quickFindListValueSeparator = '\u001f'

const visuallyHiddenClassName = 'absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 -m-px [clip:rect(0,0,0,0)]'

export function QuickFindList({
  query,
  onQueryChange,
  value,
  onValueChange,
  groups,
  emptyMessage,
  onItemClickCapture,
  onSelect,
  onKeyDown,
  placeholder = 'Find or create page or block...',
}: {
  query: string
  onQueryChange: (query: string) => void
  value: string
  onValueChange: (value: string) => void
  groups: QuickFindListGroup[]
  emptyMessage: string
  onItemClickCapture?: (event: MouseEvent) => void
  onSelect: (value: string) => void
  onKeyDown?: (event: KeyboardEvent) => void
  placeholder?: string
}) {
  const reactId = useId()
  const inputId = `${reactId}-input`
  const labelId = `${reactId}-label`
  const listId = `${reactId}-list`
  const listRef = useRef<HTMLDivElement>(null)
  const selectableItems = groups.flatMap(group => group.items)
  const selectableValuesKey = selectableItems
    .map(item => item.value)
    .join(quickFindListValueSeparator)
  const selectedIndex = selectableItems.findIndex(item => item.value === value)
  const selectedItemId = selectedIndex === -1 ? undefined : `${listId}-item-${selectedIndex}`

  useEffect(() => {
    if (selectableItems.length === 0) {
      if (value) onValueChange('')
      return
    }
    if (!value || !selectableItems.some(item => item.value === value)) {
      onValueChange(selectableItems[0].value)
    }
  }, [onValueChange, selectableItems, selectableValuesKey, value])

  useEffect(() => {
    if (!selectedItemId) return
    const selectedElement = document.getElementById(selectedItemId)
    selectedElement?.scrollIntoView({block: 'nearest'})
  }, [selectedItemId])

  const selectByIndex = (nextIndex: number) => {
    const nextItem = selectableItems[nextIndex]
    if (nextItem) onValueChange(nextItem.value)
  }

  const moveSelection = (delta: 1 | -1) => {
    if (selectableItems.length === 0) return
    if (selectedIndex === -1) {
      selectByIndex(delta > 0 ? 0 : selectableItems.length - 1)
      return
    }
    const nextIndex = Math.min(
      Math.max(selectedIndex + delta, 0),
      selectableItems.length - 1,
    )
    selectByIndex(nextIndex)
  }

  const handleRootKeyDown = (event: KeyboardEvent) => {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return

    if ((event.key === 'n' || event.key === 'j') && event.ctrlKey) {
      event.preventDefault()
      moveSelection(1)
      return
    }

    if ((event.key === 'p' || event.key === 'k') && event.ctrlKey) {
      event.preventDefault()
      moveSelection(-1)
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (event.metaKey) {
        selectByIndex(selectableItems.length - 1)
      } else {
        moveSelection(1)
      }
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (event.metaKey) {
        selectByIndex(0)
      } else {
        moveSelection(-1)
      }
      return
    }

    if (event.key === 'Home') {
      event.preventDefault()
      selectByIndex(0)
      return
    }

    if (event.key === 'End') {
      event.preventDefault()
      selectByIndex(selectableItems.length - 1)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      if (value) onSelect(value)
    }
  }

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground"
      data-quick-find-root=""
      onKeyDown={handleRootKeyDown}
      tabIndex={-1}
    >
      <label className={visuallyHiddenClassName} htmlFor={inputId} id={labelId}>
        Quick find
      </label>
      <div className="flex items-center border-b px-3" data-quick-find-input-wrapper="">
        <Search className="mr-2 h-5 w-5 shrink-0 opacity-50" />
        <input
          aria-activedescendant={selectedItemId}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-labelledby={labelId}
          autoComplete="off"
          autoCorrect="off"
          className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          data-quick-find-input=""
          id={inputId}
          onChange={event => onQueryChange(event.target.value)}
          placeholder={placeholder}
          role="combobox"
          spellCheck={false}
          type="text"
          value={query}
        />
      </div>
      <div
        aria-activedescendant={selectedItemId}
        aria-label="Suggestions"
        className="max-h-[300px] overflow-y-auto overflow-x-hidden"
        data-quick-find-list=""
        id={listId}
        ref={listRef}
        role="listbox"
        tabIndex={-1}
      >
        {selectableItems.length === 0 && (
          <div className="py-6 text-center text-sm" data-quick-find-empty="" role="presentation">
            {emptyMessage}
          </div>
        )}

        {groups.map((group, groupIndex) => {
          if (group.items.length === 0) return null
          const groupId = `${listId}-group-${groupIndex}`
          const headingId = `${groupId}-heading`
          const groupStartIndex = groups
            .slice(0, groupIndex)
            .reduce((total, previousGroup) => total + previousGroup.items.length, 0)

          return (
            <div
              className="overflow-hidden px-2 py-1 text-foreground"
              data-quick-find-group=""
              key={group.heading}
              role="presentation"
            >
              <div
                aria-hidden="true"
                className="px-2 py-1.5 text-xs font-medium text-muted-foreground"
                data-quick-find-group-heading=""
                id={headingId}
              >
                {group.heading}
              </div>
              <div
                aria-labelledby={headingId}
                data-quick-find-group-items=""
                role="group"
              >
                {group.items.map((item, itemIndex) => {
                  const currentIndex = groupStartIndex + itemIndex
                  const selected = item.value === value

                  return (
                    <div
                      aria-disabled={false}
                      aria-selected={selected}
                      className={cn(
                        'relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-3 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
                        item.className,
                      )}
                      data-disabled="false"
                      data-quick-find-item=""
                      data-selected={selected ? 'true' : 'false'}
                      data-value={item.value}
                      id={`${listId}-item-${currentIndex}`}
                      key={item.key}
                      onAuxClick={event => {
                        if (event.button !== 1) return
                        event.preventDefault()
                        onSelect(item.value)
                      }}
                      onAuxClickCapture={event => {
                        if (event.button === 1) onItemClickCapture?.(event)
                      }}
                      onClick={() => onSelect(item.value)}
                      onClickCapture={onItemClickCapture}
                      onMouseDown={event => event.preventDefault()}
                      onPointerMove={() => onValueChange(item.value)}
                      role="option"
                    >
                      {item.children}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function QuickFind() {
  const open = useSyncExternalStore(
    quickFindToggle.subscribe,
    quickFindToggle.isOpen,
    quickFindToggle.isOpen,
  )

  if (!open) return null

  return (
    <Suspense fallback={null}>
      <QuickFindResources open={open} onOpenChange={quickFindToggle.set}/>
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
      getLayoutSessionBlock(rootUIStateBlock, repo.activeLayoutSessionId),
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
    // Plain Enter falls through to QuickFindList's onSelect, which routes to
    // the default 'jump'. Intercept modified Enter chords so the selected
    // value can open in a stack or new panel.
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
  const groups: QuickFindListGroup[] = []

  if (showRecents) {
    groups.push({
      heading: 'Recent',
      items: recents.map(item => ({
        key: `recent:${item.blockId}`,
        value: `recent:${item.blockId}`,
        className: 'flex justify-between items-center',
        children: (
          <span className="truncate">{truncate(item.label, 80)}</span>
        ),
      })),
    })
  }

  if (dateCandidates.length > 0) {
    groups.push({
      heading: 'Date',
      items: dateCandidates.map((candidate, index) => {
        const detail = candidate.phrase.toLowerCase() === trimmedQuery.toLowerCase()
          ? candidate.iso
          : candidate.phrase

        return {
          key: `date:${candidate.iso}:${candidate.phrase}`,
          value: dateValues[index] ?? quickFindDateValue(candidate.iso),
          className: 'flex justify-between items-center gap-2',
          children: (
            <>
              <span className="truncate">{formatRoamDate(candidate.date)}</span>
              <span className="text-xs text-muted-foreground">{detail}</span>
            </>
          ),
        }
      }),
    })
  }

  if (aliases.length > 0) {
    groups.push({
      heading: 'Pages',
      items: aliases.map(match => ({
        key: `page:${match.blockId}:${match.alias}`,
        value: quickFindAliasValue(match),
        className: 'flex justify-between items-center gap-2',
        children: (
          <>
            <span className="truncate">{match.alias}</span>
            {match.content && match.content !== match.alias && (
              <span className="text-xs text-muted-foreground truncate max-w-[40%]">
                {truncate(match.content, 50)}
              </span>
            )}
          </>
        ),
      })),
    })
  }

  if (blocks.length > 0) {
    groups.push({
      heading: 'Blocks',
      items: blocks.map(match => ({
        key: `block:${match.blockId}`,
        value: quickFindBlockValue(match),
        children: (
          <span className="truncate">{truncate(match.content, 80)}</span>
        ),
      })),
    })
  }

  if (showCreate) {
    groups.push({
      heading: 'Create',
      items: [{
        key: `create:${trimmedQuery}`,
        value: quickFindCreateValue(trimmedQuery),
        children: (
          <span>Create page “{trimmedQuery}”</span>
        ),
      }],
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12vh] translate-y-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Quick find</DialogTitle>
        <DialogDescription className="sr-only">
          Find or create a page or block by alias or content.
        </DialogDescription>
        <QuickFindList
          emptyMessage={trimmedQuery ? 'No results.' : 'Type to search.'}
          groups={groups}
          onItemClickCapture={handleItemClickCapture}
          onKeyDown={handleKeyDown}
          onQueryChange={nextQuery => {
            setQuery(nextQuery)
            setValue('')
          }}
          onSelect={handleItemSelect}
          onValueChange={setValue}
          query={query}
          value={value}
        />
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
      </DialogContent>
    </Dialog>
  )
}
