import {
  FormEvent,
  KeyboardEvent,
  ReactElement,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react'
import { FilterX, Plus, Settings2, X } from 'lucide-react'
import { useRepo } from '@/context/repo.tsx'
import { useHandle } from '@/hooks/block.ts'
import { usePropertySchemas } from '@/hooks/propertySchemas.ts'
import { type BlockPredicate } from '@/data/api'
import { Button } from '@/components/ui/button.tsx'
import { Input } from '@/components/ui/input.tsx'
import { FloatingListbox } from '@/components/ui/floating-listbox.tsx'
import { cn } from '@/lib/utils.ts'
import {
  labelForBlockData,
  searchLinkTargetIdCandidates,
  type LinkTargetIdCandidate,
} from '@/utils/linkTargetAutocomplete.ts'
import {
  normalizeBacklinksFilter,
  type BacklinksFilter,
} from './query.ts'

const SEARCH_LIMIT = 6
const DEBOUNCE_MS = 80

type FilterMode = 'include' | 'exclude'

interface BacklinkFiltersProps {
  workspaceId: string
  filter: BacklinksFilter
  onChange: (filter: BacklinksFilter) => void
  baseFilter?: BacklinksFilter
  baseLabel?: string
  baseConfigLabel?: string
  onBaseConfigClick?: () => void
  readOnly?: boolean
}

const truncate = (text: string, max = 72): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const predicateKey = (p: BlockPredicate): string => JSON.stringify(p)

const RefChipBody = ({id}: {id: string}) => {
  const repo = useRepo()
  const block = useMemo(() => repo.block(id), [repo, id])
  const label = useHandle(block, {selector: data => labelForBlockData(data, id)})
  return <span className="truncate max-w-[18ch]" title={label}>{label}</span>
}

const ContainmentChipBody = ({id}: {id: string}) => {
  const repo = useRepo()
  const block = useMemo(() => repo.block(id), [repo, id])
  const label = useHandle(block, {selector: data => labelForBlockData(data, id)})
  const text = `in ${label}`
  return <span className="truncate max-w-[18ch]" title={text}>{text}</span>
}

const WhereChipBody = ({where}: {where: Readonly<Record<string, unknown>>}) => {
  const text = Object.entries(where)
    .map(([name, value]) => `${name}=${value === null ? '∅' : String(value)}`)
    .join(', ')
  return <span className="truncate max-w-[24ch]" title={text}>{text}</span>
}

const PredicateChip = ({
  predicate,
  mode,
  readOnly = false,
  onRemove,
}: {
  predicate: BlockPredicate
  mode: FilterMode
  readOnly?: boolean
  onRemove: () => void
}) => {
  let body: ReactElement
  if (predicate.referencedBy) {
    body = <RefChipBody id={predicate.referencedBy.id} />
  } else if (predicate.id !== undefined) {
    body = <ContainmentChipBody id={predicate.id} />
  } else if (predicate.where) {
    body = <WhereChipBody where={predicate.where} />
  } else {
    body = <span>?</span>
  }
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs',
        mode === 'include'
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
          : 'border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-200',
      )}
    >
      {body}
      {!readOnly && (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Remove filter"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  )
}

const RefPredicateInput = ({
  workspaceId,
  mode,
  excludeIds,
  readOnly = false,
  onAdd,
}: {
  workspaceId: string
  mode: FilterMode
  excludeIds: ReadonlySet<string>
  readOnly?: boolean
  onAdd: (id: string) => void
}) => {
  const repo = useRepo()
  const listboxId = useId()
  const [formElement, setFormElement] = useState<HTMLFormElement | null>(null)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [results, setResults] = useState<LinkTargetIdCandidate[]>([])
  const [activeIndex, setActiveIndex] = useState(-1)
  const trimmed = query.trim()
  const popupOpen = focused && trimmed.length > 0 && results.length > 0
  const activeCandidate = activeIndex >= 0 ? results[activeIndex] : undefined

  useEffect(() => {
    if (!workspaceId || !trimmed) return

    let cancelled = false
    const timer = setTimeout(async () => {
      const nextResults = await searchLinkTargetIdCandidates(repo, {
        workspaceId,
        query: trimmed,
        limit: SEARCH_LIMIT,
        excludeIds,
      })
      if (cancelled) return

      setResults(nextResults)
      setActiveIndex(nextResults.length > 0 ? 0 : -1)
    }, DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [excludeIds, repo, trimmed, workspaceId])

  const add = async (id?: string) => {
    if (readOnly) return
    const nextId = id ?? results[0]?.id
    if (nextId) {
      onAdd(nextId)
      setQuery('')
      setResults([])
      setActiveIndex(-1)
      return
    }
    if (!trimmed) return
    const exact = await repo.query.aliasLookup({workspaceId, alias: trimmed}).load()
    if (!exact) return
    onAdd(exact.id)
    setQuery('')
    setResults([])
    setActiveIndex(-1)
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void add()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault()
      setFocused(true)
      setActiveIndex(index => (index < 0 ? 0 : (index + 1) % results.length))
      return
    }
    if (event.key === 'ArrowUp' && results.length > 0) {
      event.preventDefault()
      setFocused(true)
      setActiveIndex(index => (index <= 0 ? results.length - 1 : index - 1))
      return
    }
    if (event.key === 'Enter' && popupOpen && activeCandidate) {
      event.preventDefault()
      void add(activeCandidate.id)
      return
    }
    if (event.key === 'Escape') {
      setQuery('')
      setResults([])
      setActiveIndex(-1)
    }
  }

  return (
    <form ref={setFormElement} className="flex min-w-0 flex-1 gap-1" onSubmit={handleSubmit}>
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
        placeholder={mode === 'include' ? 'Include reference' : 'Exclude reference'}
        className="h-8 min-w-0 text-xs"
        disabled={readOnly}
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
        disabled={readOnly}
        title={mode === 'include' ? 'Add include filter' : 'Add exclude filter'}
        aria-label={mode === 'include' ? 'Add include filter' : 'Add exclude filter'}
      >
        <Plus className="h-4 w-4" />
      </Button>
      <FloatingListbox
        id={listboxId}
        open={popupOpen}
        anchorElement={formElement}
        maxWidth={384}
        maxHeight={224}
        className="text-xs shadow-md"
      >
        {results.map((result, index) => (
          <button
            type="button"
            key={result.id}
            id={`${listboxId}-option-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            onMouseEnter={() => setActiveIndex(index)}
            onMouseDown={event => {
              event.preventDefault()
              void add(result.id)
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
      </FloatingListbox>
    </form>
  )
}

const PropertyPredicateInput = ({
  mode,
  readOnly = false,
  onAdd,
}: {
  mode: FilterMode
  readOnly?: boolean
  onAdd: (predicate: BlockPredicate) => void
}) => {
  const schemas = usePropertySchemas()
  const queryable = useMemo(() => {
    return Array.from(schemas.values())
      .filter(s => s.codec.where !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [schemas])
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const schema = useMemo(() => schemas.get(name), [schemas, name])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (readOnly || !schema) return
    let coerced: unknown = value
    if (value === '') {
      coerced = null
    } else if (schema.codec.type === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) return
      coerced = n
    } else if (schema.codec.type === 'boolean') {
      coerced = value === 'true'
    }
    onAdd({scope: 'ancestor', where: {[name]: coerced}})
    setName('')
    setValue('')
  }

  if (queryable.length === 0) return null

  return (
    <form className="flex min-w-0 gap-1" onSubmit={submit}>
      <select
        value={name}
        onChange={e => {
          setName(e.target.value)
          setValue('')
        }}
        disabled={readOnly}
        className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
        aria-label={mode === 'include' ? 'Include property' : 'Exclude property'}
      >
        <option value="">— property —</option>
        {queryable.map(s => (
          <option key={s.name} value={s.name}>{s.name}</option>
        ))}
      </select>
      {schema?.codec.type === 'boolean' ? (
        <select
          value={value}
          onChange={e => setValue(e.target.value)}
          disabled={readOnly}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
          aria-label="value"
        >
          <option value="">— value —</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <Input
          value={value}
          onChange={e => setValue(e.target.value)}
          disabled={readOnly || !schema}
          placeholder={schema ? `${schema.codec.type} value` : 'value'}
          className="h-8 min-w-0 flex-1 text-xs"
          aria-label="value"
        />
      )}
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        disabled={readOnly || !schema || !value}
        title={mode === 'include' ? 'Add include property filter' : 'Add exclude property filter'}
        aria-label={mode === 'include' ? 'Add include property filter' : 'Add exclude property filter'}
      >
        <Plus className="h-4 w-4" />
      </Button>
    </form>
  )
}

export function BacklinkFilters({
  workspaceId,
  filter,
  onChange,
  baseFilter,
  baseLabel = 'Defaults',
  baseConfigLabel = 'Open defaults config',
  onBaseConfigClick,
  readOnly = false,
}: BacklinkFiltersProps) {
  const normalized = useMemo(() => normalizeBacklinksFilter(filter), [filter])
  const normalizedBase = useMemo(() => normalizeBacklinksFilter(baseFilter), [baseFilter])
  const active = normalized.include.length > 0 || normalized.exclude.length > 0
  const baseActive = normalizedBase.include.length > 0 || normalizedBase.exclude.length > 0

  const refIdsInList = (predicates: readonly BlockPredicate[]): Set<string> => {
    const out = new Set<string>()
    for (const p of predicates) {
      if (p.referencedBy) out.add(p.referencedBy.id)
      if (p.id !== undefined) out.add(p.id)
    }
    return out
  }
  const includeRefIds = useMemo(() => refIdsInList(normalized.include), [normalized.include])
  const excludeRefIds = useMemo(() => refIdsInList(normalized.exclude), [normalized.exclude])

  const addPredicate = (mode: FilterMode, predicate: BlockPredicate) => {
    if (readOnly) return
    const key = predicateKey(predicate)
    const include = mode === 'include'
      ? [predicate, ...normalized.include.filter(p => predicateKey(p) !== key)]
      : normalized.include.filter(p => predicateKey(p) !== key)
    const exclude = mode === 'exclude'
      ? [predicate, ...normalized.exclude.filter(p => predicateKey(p) !== key)]
      : normalized.exclude.filter(p => predicateKey(p) !== key)
    onChange({include, exclude})
  }

  const removePredicate = (mode: FilterMode, predicate: BlockPredicate) => {
    if (readOnly) return
    const key = predicateKey(predicate)
    onChange({
      include: mode === 'include'
        ? normalized.include.filter(p => predicateKey(p) !== key)
        : normalized.include,
      exclude: mode === 'exclude'
        ? normalized.exclude.filter(p => predicateKey(p) !== key)
        : normalized.exclude,
    })
  }

  return (
    <div className="mt-3 flex flex-col gap-2 border-l border-border/80 pl-3">
      {baseActive && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="text-xs font-medium text-muted-foreground">{baseLabel}</div>
            {onBaseConfigClick && (
              <button
                type="button"
                onClick={onBaseConfigClick}
                className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title={baseConfigLabel}
                aria-label={baseConfigLabel}
              >
                <Settings2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <div className="flex min-w-0 flex-wrap gap-1">
              {normalizedBase.include.map(p => (
                <PredicateChip
                  key={`base-inc-${predicateKey(p)}`}
                  predicate={p}
                  mode="include"
                  readOnly
                  onRemove={() => undefined}
                />
              ))}
            </div>
            <div className="flex min-w-0 flex-wrap gap-1">
              {normalizedBase.exclude.map(p => (
                <PredicateChip
                  key={`base-exc-${predicateKey(p)}`}
                  predicate={p}
                  mode="exclude"
                  readOnly
                  onRemove={() => undefined}
                />
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <RefPredicateInput
            workspaceId={workspaceId}
            mode="include"
            excludeIds={includeRefIds}
            readOnly={readOnly}
            onAdd={id => addPredicate('include', {scope: 'ancestor', referencedBy: {id}})}
          />
          <PropertyPredicateInput
            mode="include"
            readOnly={readOnly}
            onAdd={p => addPredicate('include', p)}
          />
          {normalized.include.length > 0 && (
            <div className="flex min-w-0 flex-wrap gap-1">
              {normalized.include.map(p => (
                <PredicateChip
                  key={`inc-${predicateKey(p)}`}
                  predicate={p}
                  mode="include"
                  readOnly={readOnly}
                  onRemove={() => removePredicate('include', p)}
                />
              ))}
            </div>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <RefPredicateInput
            workspaceId={workspaceId}
            mode="exclude"
            excludeIds={excludeRefIds}
            readOnly={readOnly}
            onAdd={id => addPredicate('exclude', {scope: 'ancestor', referencedBy: {id}})}
          />
          <PropertyPredicateInput
            mode="exclude"
            readOnly={readOnly}
            onAdd={p => addPredicate('exclude', p)}
          />
          {normalized.exclude.length > 0 && (
            <div className="flex min-w-0 flex-wrap gap-1">
              {normalized.exclude.map(p => (
                <PredicateChip
                  key={`exc-${predicateKey(p)}`}
                  predicate={p}
                  mode="exclude"
                  readOnly={readOnly}
                  onRemove={() => removePredicate('exclude', p)}
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
            disabled={readOnly}
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
