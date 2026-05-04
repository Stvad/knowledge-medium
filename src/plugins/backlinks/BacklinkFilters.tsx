import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { FilterX, Plus, X } from 'lucide-react'
import type { BlockData } from '@/data/api'
import { aliasesProp } from '@/data/properties.ts'
import { useRepo } from '@/context/repo.tsx'
import { useData } from '@/hooks/block.ts'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { cn } from '@/lib/utils.ts'
import {
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

const SEARCH_LIMIT = 6
const DEBOUNCE_MS = 80

type FilterMode = 'include' | 'remove'

interface FilterCandidate {
  id: string
  label: string
  detail: string
}

interface BacklinkFiltersProps {
  workspaceId: string
  filter: BacklinksFilter
  onChange: (filter: BacklinksFilter) => void
}

const labelForBlockData = (data: BlockData | null | undefined, fallback: string): string => {
  const aliases = data?.properties[aliasesProp.name]
  if (Array.isArray(aliases)) {
    const alias = aliases.find((value): value is string => typeof value === 'string' && value.trim() !== '')
    if (alias) return alias
  }
  const content = data?.content?.trim()
  return content || fallback
}

const truncate = (text: string, max = 72): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const FilterChip = ({
  id,
  mode,
  onRemove,
}: {
  id: string
  mode: FilterMode
  onRemove: (id: string) => void
}) => {
  const repo = useRepo()
  const block = useMemo(() => repo.block(id), [repo, id])
  const data = useData(block)
  const label = labelForBlockData(data, id)

  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs',
        mode === 'include'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
          : 'border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-200',
      )}
      title={label}
    >
      <span className="truncate max-w-[18ch]">{label}</span>
      <button
        type="button"
        onClick={() => onRemove(id)}
        className="shrink-0 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={`Remove ${label}`}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}

const BacklinkFilterInput = ({
  workspaceId,
  mode,
  currentIds,
  onAdd,
}: {
  workspaceId: string
  mode: FilterMode
  currentIds: readonly string[]
  onAdd: (id: string) => void
}) => {
  const repo = useRepo()
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [results, setResults] = useState<FilterCandidate[]>([])
  const trimmed = query.trim()
  const currentIdSet = useMemo(() => new Set(currentIds), [currentIds])

  useEffect(() => {
    if (!workspaceId || !trimmed) {
      return
    }

    let cancelled = false
    const timer = setTimeout(async () => {
      const [aliasRows, blockRows] = await Promise.all([
        repo.query.aliasMatches({workspaceId, filter: trimmed, limit: SEARCH_LIMIT}).load(),
        repo.query.searchByContent({workspaceId, query: trimmed, limit: SEARCH_LIMIT}).load(),
      ])
      if (cancelled) return

      const seen = new Set<string>(currentIdSet)
      const candidates: FilterCandidate[] = []
      for (const row of aliasRows) {
        if (seen.has(row.blockId)) continue
        seen.add(row.blockId)
        candidates.push({
          id: row.blockId,
          label: row.alias,
          detail: row.content,
        })
      }
      for (const block of blockRows) {
        if (seen.has(block.id)) continue
        seen.add(block.id)
        candidates.push({
          id: block.id,
          label: labelForBlockData(block, block.id),
          detail: block.content,
        })
      }
      setResults(candidates.slice(0, SEARCH_LIMIT))
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [currentIdSet, repo, trimmed, workspaceId])

  const add = async (id?: string) => {
    const nextId = id ?? results[0]?.id
    if (nextId) {
      onAdd(nextId)
      setQuery('')
      setResults([])
      return
    }
    if (!trimmed) return
    const exact = await repo.query.aliasLookup({workspaceId, alias: trimmed}).load()
    if (!exact) return
    onAdd(exact.id)
    setQuery('')
    setResults([])
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void add()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setQuery('')
      setResults([])
    }
  }

  return (
    <form className="relative flex min-w-0 flex-1 gap-1" onSubmit={handleSubmit}>
      <Input
        value={query}
        onChange={event => {
          const next = event.target.value
          setQuery(next)
          if (!next.trim()) setResults([])
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
        placeholder={mode === 'include' ? 'Include reference' : 'Remove reference'}
        className="h-8 min-w-0 text-xs"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        title={mode === 'include' ? 'Add include filter' : 'Add remove filter'}
        aria-label={mode === 'include' ? 'Add include filter' : 'Add remove filter'}
      >
        <Plus className="h-4 w-4" />
      </Button>
      {focused && trimmed && results.length > 0 && (
        <div className="absolute left-0 right-9 top-9 z-20 max-h-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md">
          {results.map(result => (
            <button
              type="button"
              key={result.id}
              onMouseDown={event => {
                event.preventDefault()
                void add(result.id)
              }}
              className="flex w-full min-w-0 flex-col rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="truncate font-medium">{result.label}</span>
              {result.detail && result.detail !== result.label && (
                <span className="truncate text-muted-foreground">{truncate(result.detail)}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </form>
  )
}

export function BacklinkFilters({
  workspaceId,
  filter,
  onChange,
}: BacklinkFiltersProps) {
  const normalized = useMemo(() => normalizeBacklinksFilter(filter), [filter])
  const active = normalized.includeIds.length > 0 || normalized.removeIds.length > 0

  const addFilter = (mode: FilterMode, id: string) => {
    const includeIds = mode === 'include'
      ? [id, ...normalized.includeIds.filter(existing => existing !== id)]
      : normalized.includeIds.filter(existing => existing !== id)
    const removeIds = mode === 'remove'
      ? [id, ...normalized.removeIds.filter(existing => existing !== id)]
      : normalized.removeIds.filter(existing => existing !== id)
    onChange({includeIds, removeIds})
  }

  const removeFilter = (mode: FilterMode, id: string) => {
    onChange({
      includeIds: mode === 'include'
        ? normalized.includeIds.filter(existing => existing !== id)
        : normalized.includeIds,
      removeIds: mode === 'remove'
        ? normalized.removeIds.filter(existing => existing !== id)
        : normalized.removeIds,
    })
  }

  return (
    <div className="mt-3 flex flex-col gap-2 border-l border-border/80 pl-3">
      <div className="grid gap-2 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <BacklinkFilterInput
            workspaceId={workspaceId}
            mode="include"
            currentIds={normalized.includeIds}
            onAdd={id => addFilter('include', id)}
          />
          {normalized.includeIds.length > 0 && (
            <div className="flex min-w-0 flex-wrap gap-1">
              {normalized.includeIds.map(id => (
                <FilterChip
                  key={id}
                  id={id}
                  mode="include"
                  onRemove={() => removeFilter('include', id)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <BacklinkFilterInput
            workspaceId={workspaceId}
            mode="remove"
            currentIds={normalized.removeIds}
            onAdd={id => addFilter('remove', id)}
          />
          {normalized.removeIds.length > 0 && (
            <div className="flex min-w-0 flex-wrap gap-1">
              {normalized.removeIds.map(id => (
                <FilterChip
                  key={id}
                  id={id}
                  mode="remove"
                  onRemove={() => removeFilter('remove', id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {active && (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => onChange({})}
          >
            <FilterX className="h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      )}
    </div>
  )
}
