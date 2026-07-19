import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
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
import { useRepo } from '@/context/repo.js'
import { showError, showSuccess } from '@/utils/toast.js'
import { cn } from '@/lib/utils.js'
import {
  DEFAULT_FIND_REPLACE_MAX_BLOCKS,
  FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
  FIND_REPLACE_SEARCH_CONTENT_QUERY,
} from './dataExtension.ts'
import { findReplaceToggle } from './toggleStore.ts'
import type {
  ApplyContentReplaceResult,
  ContentReplacePlanItem,
  ContentSearchMatch,
  ContentSearchResult,
  FindReplaceOptions,
  RetryableContentReplaceSkip,
} from './types.ts'

const DEBOUNCE_MS = 120

const defaultOptions: FindReplaceOptions = {
  matchCase: false,
  wholeWord: false,
}

const resultSummary = (result: ApplyContentReplaceResult): string => {
  const changed = `${result.replacements} replacement${result.replacements === 1 ? '' : 's'} in ${result.updatedBlocks} block${result.updatedBlocks === 1 ? '' : 's'}`
  const skipped = result.skippedChangedBlocks + result.skippedUnavailableBlocks
  const base = skipped === 0 ? changed : `${changed}; ${skipped} skipped`
  // Codec skips get their own clause, named: "3 skipped" reads like a stale
  // match, while these were refused because the new text wouldn't parse as
  // the property's value — the user needs to know WHICH property to go fix
  // (#404 item 5; the original values are untouched).
  if (result.skippedUnparseableProperty === 0) return base
  const names = result.unparseableProperties.map(name => `"${name}"`).join(', ')
  const count = result.skippedUnparseableProperty
  return `${base}; ${count} left unchanged — the new text is not a valid value for `
    + `propert${result.unparseableProperties.length === 1 ? 'y' : 'ies'} ${names}`
}

const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`

const blockMatchCountLabel = (blockCount: number, matchCount: number): string =>
  `${pluralize(blockCount, 'block')} · ${pluralize(matchCount, 'match', 'matches')}`

export function FindReplaceDialog() {
  const repo = useRepo()
  const open = useSyncExternalStore(
    findReplaceToggle.subscribe,
    findReplaceToggle.isOpen,
    findReplaceToggle.isOpen,
  )
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
  // Value rows a replace would leave unparseable, held back for an explicit
  // "replace anyway" (#404 item 5). Null = no pending decision.
  const [pendingForce, setPendingForce] = useState<RetryableContentReplaceSkip[] | null>(null)

  const trimmedFind = find.trim()
  const matches = useMemo(
    () => searchResult.query === trimmedFind ? searchResult.matches : [],
    [searchResult, trimmedFind],
  )
  const selectedItems = useMemo(
    () => matches.filter(match => selectedIds.has(match.blockId)),
    [matches, selectedIds],
  )
  const totalMatchCount = matches.reduce((sum, match) => sum + match.matchCount, 0)
  const selectedReplacementCount = selectedItems.reduce((sum, match) => sum + match.matchCount, 0)

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

  const closeAndReset = () => {
    setSearchResult({query: '', matches: [], truncated: false})
    setSelectedIds(new Set())
    setPendingForce(null)
    setFind('')
    setReplace('')
    findReplaceToggle.close()
  }

  const runReplace = async (items: ContentReplacePlanItem[], force: boolean) => {
    const workspaceId = repo.activeWorkspaceId
    if (!workspaceId || !trimmedFind || items.length === 0 || repo.isReadOnly) return

    setApplying(true)
    try {
      const result = await repo.run<ApplyContentReplaceResult>(
        FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
        {workspaceId, find: trimmedFind, replace, options, items, force},
      )
      showSuccess(resultSummary(result))
      // Safe rows already applied. If any value rows would break their
      // property's codec, hold the dialog open and let the user force just
      // those (or leave them) instead of deciding for them (#404 item 5).
      if (!force && result.retryableSkips.length > 0) {
        setPendingForce(result.retryableSkips)
        return
      }
      closeAndReset()
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Replace failed')
    } finally {
      setApplying(false)
    }
  }

  const applyReplace = (items: ContentSearchMatch[]) =>
    runReplace(
      items.map(item => ({blockId: item.blockId, originalContent: item.originalContent})),
      false,
    )

  const forcePending = () => {
    if (!pendingForce) return
    void runReplace(
      pendingForce.map(skip => ({blockId: skip.blockId, originalContent: skip.originalContent})),
      true,
    )
  }

  const pendingProperties = useMemo(
    () => pendingForce === null
      ? []
      : [...new Set(pendingForce.map(skip => skip.property))].sort(),
    [pendingForce],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        // Backdrop/escape close bypasses closeAndReset — drop any pending
        // force decision so it can't resurface on the next open.
        if (!next) setPendingForce(null)
        findReplaceToggle.set(next)
      }}
    >
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
                  ? blockMatchCountLabel(matches.length, totalMatchCount)
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
                  <span
                    className="rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    title={pluralize(match.matchCount, 'match')}
                    aria-label={pluralize(match.matchCount, 'match')}
                  >
                    {match.matchCount}x
                  </span>
                </label>
              )
            })}
          </div>
        </div>

        {pendingForce !== null && (
          <div className="mx-5 rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            <p className="text-foreground">
              {pluralize(pendingForce.length, 'row')} left unchanged — the new text isn&apos;t a
              valid value for {pendingProperties.length === 1 ? 'property' : 'properties'}{' '}
              {pendingProperties.map(name => `"${name}"`).join(', ')}.
            </p>
            <p className="mt-1 text-muted-foreground">
              Replacing anyway stores the text and those properties will show no value until you fix
              it (undo restores them).
            </p>
          </div>
        )}

        <DialogFooter className="flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:space-x-0">
          {pendingForce !== null ? (
            <>
              <div className="text-sm text-muted-foreground">
                {pluralize(pendingForce.length, 'row')} awaiting your decision
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={applying}
                  onClick={closeAndReset}
                >
                  Leave them
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={repo.isReadOnly || applying}
                  onClick={forcePending}
                >
                  Replace anyway ({pendingForce.length})
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="text-sm text-muted-foreground">
                Selected: {blockMatchCountLabel(selectedItems.length, selectedReplacementCount)}
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => findReplaceToggle.close()}
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
                </Button>
              </div>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
