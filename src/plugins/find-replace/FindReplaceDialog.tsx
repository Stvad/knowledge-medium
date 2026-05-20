import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useRepo } from '@/context/repo.tsx'
import { showError, showSuccess } from '@/utils/toast.ts'
import { cn } from '@/lib/utils.ts'
import {
  DEFAULT_FIND_REPLACE_MAX_BLOCKS,
  FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
  FIND_REPLACE_SEARCH_CONTENT_QUERY,
} from './dataExtension.ts'
import { toggleFindReplaceEvent } from './events.ts'
import type {
  ApplyContentReplaceResult,
  ContentSearchMatch,
  ContentSearchResult,
  FindReplaceOptions,
} from './types.ts'

const DEBOUNCE_MS = 120

const defaultOptions: FindReplaceOptions = {
  matchCase: false,
  wholeWord: false,
}

const resultSummary = (result: ApplyContentReplaceResult): string => {
  const changed = `${result.replacements} replacement${result.replacements === 1 ? '' : 's'} in ${result.updatedBlocks} block${result.updatedBlocks === 1 ? '' : 's'}`
  const skipped = result.skippedChangedBlocks + result.skippedUnavailableBlocks
  if (skipped === 0) return changed
  return `${changed}; ${skipped} skipped`
}

export function FindReplaceDialog() {
  const repo = useRepo()
  const [open, setOpen] = useState(false)
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [options, setOptions] = useState<FindReplaceOptions>(defaultOptions)
  const [searchResult, setSearchResult] = useState<ContentSearchResult>({
    query: '',
    matches: [],
    truncated: false,
  })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)

  const trimmedFind = find.trim()
  const matches = useMemo(
    () => searchResult.query === trimmedFind ? searchResult.matches : [],
    [searchResult, trimmedFind],
  )
  const selectedItems = useMemo(
    () => matches.filter(match => selectedIds.has(match.blockId)),
    [matches, selectedIds],
  )
  const selectedReplacementCount = selectedItems.reduce((sum, match) => sum + match.matchCount, 0)

  useEffect(() => {
    const handleToggle = () => {
      setOpen(prev => !prev)
    }
    window.addEventListener(toggleFindReplaceEvent, handleToggle)
    return () => window.removeEventListener(toggleFindReplaceEvent, handleToggle)
  }, [])

  useEffect(() => {
    if (!open) return
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId || !trimmedFind) {
      return
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        setLoading(true)
        const result = await repo.query[FIND_REPLACE_SEARCH_CONTENT_QUERY]({
          workspaceId,
          query: trimmedFind,
          options,
          maxBlocks: DEFAULT_FIND_REPLACE_MAX_BLOCKS,
        }).load()
        if (cancelled) return
        setSearchResult(result)
        setSelectedIds(new Set(result.matches.map(match => match.blockId)))
      } catch (error) {
        if (!cancelled) {
          showError(error instanceof Error ? error.message : 'Find failed')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, options, repo, trimmedFind])

  const setOption = (key: keyof FindReplaceOptions, value: boolean) => {
    setOptions(current => ({...current, [key]: value}))
  }

  const toggleSelected = (blockId: string, checked: boolean) => {
    setSelectedIds(current => {
      const next = new Set(current)
      if (checked) next.add(blockId)
      else next.delete(blockId)
      return next
    })
  }

  const setAllSelected = (checked: boolean) => {
    setSelectedIds(checked ? new Set(matches.map(match => match.blockId)) : new Set())
  }

  const applyReplace = async (items: ContentSearchMatch[]) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId || !trimmedFind || items.length === 0 || repo.isReadOnly) return

    setApplying(true)
    try {
      const result = await repo.run<ApplyContentReplaceResult>(
        FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
        {
          workspaceId,
          find: trimmedFind,
          replace,
          options,
          items: items.map(item => ({
            blockId: item.blockId,
            originalContent: item.originalContent,
          })),
        },
      )
      showSuccess(resultSummary(result))
      setSearchResult({query: '', matches: [], truncated: false})
      setSelectedIds(new Set())
      setFind('')
      setReplace('')
      setOpen(false)
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Replace failed')
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[12vh] max-h-[82vh] max-w-3xl translate-y-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-4 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <Search className="h-4 w-4"/>
            Find and replace
          </DialogTitle>
          <DialogDescription className="sr-only">
            Search block content in this workspace and review replacements before applying them.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 border-b px-5 pb-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="find-replace-find">Find</Label>
            <Input
              id="find-replace-find"
              value={find}
              autoFocus
              onChange={event => {
                const next = event.currentTarget.value
                setFind(next)
                if (!next.trim()) {
                  setSearchResult({query: '', matches: [], truncated: false})
                  setSelectedIds(new Set())
                  setLoading(false)
                }
              }}
              placeholder="Text to find"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="find-replace-replace">Replace</Label>
            <Input
              id="find-replace-replace"
              value={replace}
              onChange={event => setReplace(event.currentTarget.value)}
              placeholder="Replacement"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={options.matchCase}
              onCheckedChange={checked => setOption('matchCase', checked === true)}
            />
            Match case
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={options.wholeWord}
              onCheckedChange={checked => setOption('wholeWord', checked === true)}
            />
            Whole word
          </label>
        </div>

        <div className="min-h-0 overflow-y-auto px-5">
          <div className="mb-2 flex min-h-8 items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>
              {loading
                ? 'Searching...'
                : trimmedFind
                  ? `${matches.length} block${matches.length === 1 ? '' : 's'}`
                  : 'Type text to search'}
              {searchResult.truncated && ' (limited)'}
            </span>
            {matches.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAllSelected(selectedIds.size !== matches.length)}
              >
                {selectedIds.size === matches.length ? 'Clear' : 'Select all'}
              </Button>
            )}
          </div>

          <div className="grid gap-2 pb-4">
            {matches.map(match => {
              const checked = selectedIds.has(match.blockId)
              return (
                <label
                  key={match.blockId}
                  className={cn(
                    'grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-md border p-3 text-sm',
                    checked ? 'border-primary/50 bg-accent/40' : 'bg-background',
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={next => toggleSelected(match.blockId, next === true)}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-foreground">{match.preview}</span>
                    <span className="block truncate text-xs text-muted-foreground">{match.blockId}</span>
                  </span>
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {match.matchCount}
                  </span>
                </label>
              )
            })}
          </div>
        </div>

        <DialogFooter className="border-t px-5 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={repo.isReadOnly || applying || matches.length === 0}
            onClick={() => void applyReplace(matches)}
          >
            Replace all shown
          </Button>
          <Button
            type="button"
            disabled={repo.isReadOnly || applying || selectedItems.length === 0}
            onClick={() => void applyReplace(selectedItems)}
          >
            Replace selected
            {selectedReplacementCount > 0 ? ` (${selectedReplacementCount})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
