import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react'
import { Plus, X } from 'lucide-react'
import {
  type PropertyEditorProps,
} from '@/data/api'
import { useRepo } from '@/context/repo.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { cn } from '@/lib/utils.ts'
import {
  searchLinkTargetValueCandidates,
  type LinkTargetValueCandidate,
} from '@/utils/linkTargetAutocomplete.ts'
import {
  normalizeGroupedBacklinksConfig,
  type GroupedBacklinksConfig,
} from './config.ts'

const SEARCH_LIMIT = 6
const DEBOUNCE_MS = 80

type TagTone = 'high' | 'low' | 'excluded'

const truncate = (text: string, max = 72): string =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text

const uniqueStrings = (values: readonly string[]): string[] =>
  Array.from(new Set(values.map(value => value.trim()).filter(Boolean)))

const isReadOnlyBlock = (block: unknown): boolean => {
  if (!block || typeof block !== 'object') return false
  const repo = (block as { repo?: { isReadOnly?: unknown } }).repo
  return repo?.isReadOnly === true
}

const toneClass = (tone: TagTone): string => {
  switch (tone) {
    case 'high':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
    case 'low':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200'
    case 'excluded':
      return 'border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-200'
  }
}

const TagChip = ({
  value,
  tone,
  readOnly,
  onRemove,
}: {
  value: string
  tone: TagTone
  readOnly: boolean
  onRemove: () => void
}) => (
  <span
    className={cn(
      'inline-flex min-w-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs',
      toneClass(tone),
    )}
    title={value}
  >
    <span className="max-w-[18ch] truncate">{value}</span>
    {!readOnly && (
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label={`Remove ${value}`}
      >
        <X className="h-3 w-3" />
      </button>
    )}
  </span>
)

const ConfigTagInput = ({
  label,
  placeholder,
  tone,
  values,
  readOnly,
  onChange,
}: {
  label: string
  placeholder: string
  tone: TagTone
  values: readonly string[]
  readOnly: boolean
  onChange: (next: string[]) => void
}) => {
  const repo = useRepo()
  const listboxId = useId()
  const workspaceId = repo.activeWorkspaceId ?? ''
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [results, setResults] = useState<LinkTargetValueCandidate[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const currentValues = useMemo(() => uniqueStrings(values), [values])
  const currentValueSet = useMemo(() => new Set(currentValues), [currentValues])
  const trimmed = query.trim()
  const popupOpen = focused && trimmed.length > 0 && results.length > 0
  const activeCandidate = activeIndex >= 0 ? results[activeIndex] : undefined

  useEffect(() => {
    if (!workspaceId || !trimmed) return

    let cancelled = false
    const timer = setTimeout(async () => {
      const nextResults = await searchLinkTargetValueCandidates(repo, {
        workspaceId,
        query: trimmed,
        limit: SEARCH_LIMIT,
        excludeValues: currentValueSet,
      })
      if (cancelled) return

      setResults(nextResults)
      setActiveIndex(nextResults.length > 0 ? 0 : -1)
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [currentValueSet, repo, trimmed, workspaceId])

  const add = (value?: string) => {
    if (readOnly) return
    const nextValue = (value ?? activeCandidate?.value ?? trimmed).trim()
    if (!nextValue) return
    onChange(uniqueStrings([...currentValues, nextValue]))
    setQuery('')
    setResults([])
    setActiveIndex(-1)
  }

  const remove = (value: string) => {
    if (readOnly) return
    onChange(currentValues.filter(existing => existing !== value))
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    add()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      setFocused(true)
      setActiveIndex(index => (
        index < 0 ? 0 : (index + 1) % results.length
      ))
      return
    }
    if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      setFocused(true)
      setActiveIndex(index => (
        index <= 0 ? results.length - 1 : index - 1
      ))
      return
    }
    if (event.key === 'Enter' && popupOpen && activeCandidate) {
      event.preventDefault()
      add(activeCandidate.value)
      return
    }
    if (event.key === 'Escape') {
      setQuery('')
      setResults([])
      setActiveIndex(-1)
    }
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {currentValues.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1">
          {currentValues.map(value => (
            <TagChip
              key={value}
              value={value}
              tone={tone}
              readOnly={readOnly}
              onRemove={() => remove(value)}
            />
          ))}
        </div>
      )}
      {!readOnly && (
        <form className="relative flex min-w-0 flex-1 gap-1" onSubmit={handleSubmit}>
          <Input
            value={query}
            onChange={event => {
              const next = event.target.value
              setQuery(next)
              if (!next.trim()) {
                setResults([])
                setActiveIndex(-1)
              }
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="h-8 min-w-0 text-xs"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={Boolean(popupOpen)}
            aria-controls={popupOpen ? listboxId : undefined}
            aria-activedescendant={
              popupOpen && activeCandidate ? `${listboxId}-option-${activeIndex}` : undefined
            }
          />
          <Button
            type="submit"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            disabled={!trimmed}
            title={`Add ${label.toLowerCase()}`}
            aria-label={`Add ${label.toLowerCase()}`}
          >
            <Plus className="h-4 w-4" />
          </Button>
          {popupOpen && (
            <div
              id={listboxId}
              role="listbox"
              className="absolute left-0 right-9 top-9 z-20 max-h-56 overflow-auto rounded-md border border-border bg-popover p-1 shadow-md"
            >
              {results.map((result, index) => (
                <button
                  type="button"
                  key={result.key}
                  id={`${listboxId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={event => {
                    event.preventDefault()
                    add(result.value)
                  }}
                  className={cn(
                    'flex w-full min-w-0 flex-col rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    index === activeIndex ? 'bg-accent' : '',
                  )}
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
      )}
    </div>
  )
}

const regexError = (pattern: string): string | null => {
  if (!pattern.trim()) return null
  try {
    new RegExp(pattern)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid regex'
  }
}

const PatternListInput = ({
  label,
  values,
  readOnly,
  onChange,
}: {
  label: string
  values: readonly string[]
  readOnly: boolean
  onChange: (next: string[]) => void
}) => {
  const [newPattern, setNewPattern] = useState('')
  const patterns = useMemo(() => uniqueStrings(values), [values])

  const addPattern = () => {
    if (readOnly) return
    const pattern = newPattern.trim()
    if (!pattern) return
    onChange(uniqueStrings([...patterns, pattern]))
    setNewPattern('')
  }

  const updatePattern = (index: number, next: string) => {
    if (readOnly) return
    onChange(patterns.map((pattern, patternIndex) => patternIndex === index ? next : pattern))
  }

  const removePattern = (index: number) => {
    if (readOnly) return
    onChange(patterns.filter((_, patternIndex) => patternIndex !== index))
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {patterns.map((pattern, index) => {
        const error = regexError(pattern)
        return (
          <div key={index} className="space-y-1">
            <div className="flex min-w-0 gap-1">
              <Input
                value={pattern}
                onChange={event => updatePattern(index, event.target.value)}
                className={cn(
                  'h-8 min-w-0 font-mono text-xs',
                  error ? 'border-destructive focus-visible:ring-destructive' : '',
                )}
                aria-invalid={Boolean(error)}
                title={error ?? pattern}
                disabled={readOnly}
              />
              {!readOnly && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                  onClick={() => removePattern(index)}
                  aria-label={`Remove ${pattern}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            {error && (
              <div className="text-xs text-destructive">{truncate(error, 96)}</div>
            )}
          </div>
        )
      })}
      {!readOnly && (
        <div className="flex min-w-0 gap-1">
          <Input
            value={newPattern}
            onChange={event => setNewPattern(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addPattern()
              }
            }}
            placeholder="Add pattern"
            className="h-8 min-w-0 font-mono text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={addPattern}
            disabled={!newPattern.trim()}
            aria-label={`Add ${label.toLowerCase()}`}
            title={`Add ${label.toLowerCase()}`}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

export const GroupedBacklinksDefaultsEditor = ({
  value,
  onChange,
  block,
}: PropertyEditorProps<GroupedBacklinksConfig>) => {
  const readOnly = isReadOnlyBlock(block)
  const config = useMemo(() => normalizeGroupedBacklinksConfig(value), [value])

  const update = (key: keyof GroupedBacklinksConfig, next: string[]) => {
    if (readOnly) return
    onChange({...config, [key]: uniqueStrings(next)})
  }

  return (
    <div className="space-y-3">
      <ConfigTagInput
        label="High priority"
        placeholder="Add tag"
        tone="high"
        values={config.highPriorityTags}
        readOnly={readOnly}
        onChange={next => update('highPriorityTags', next)}
      />
      <ConfigTagInput
        label="Low priority"
        placeholder="Add tag"
        tone="low"
        values={config.lowPriorityTags}
        readOnly={readOnly}
        onChange={next => update('lowPriorityTags', next)}
      />
      <ConfigTagInput
        label="Excluded tags"
        placeholder="Add tag"
        tone="excluded"
        values={config.excludedTags}
        readOnly={readOnly}
        onChange={next => update('excludedTags', next)}
      />
      <PatternListInput
        label="Excluded patterns"
        values={config.excludedPatterns}
        readOnly={readOnly}
        onChange={next => update('excludedPatterns', next)}
      />
    </div>
  )
}
