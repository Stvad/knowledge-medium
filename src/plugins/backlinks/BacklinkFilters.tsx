import {
  FormEvent,
  MouseEvent,
  ReactElement,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react'
import { FilterX, Plus, Settings2, X } from 'lucide-react'
import { truncate } from '@/utils/string'
import { useAutocompleteListbox } from '@/hooks/useAutocompleteListbox.js'
import { useDebouncedValue } from '@/hooks/useDebouncedValue.js'
import { useRepo } from '@/context/repo.js'
import { useHandle } from '@/hooks/block.js'
import { usePropertySchemas } from '@/hooks/propertySchemas.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { refTargetFilterDefaultsFacet } from '@/data/facets.js'
import { type BlockPredicate } from '@/data/api'
import {
  propertyFilterOperatorArity,
  resolvePropertyFilter,
  type PropertyFilterAffordance,
  type PropertyFilterInputKind,
  type PropertyFilterOperatorId,
} from './propertyFilter.ts'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { FloatingListbox } from '@/components/ui/floating-listbox.js'
import { cn } from '@/lib/utils.js'
import {
  labelForBlockData,
  searchLinkTargetIdCandidates,
  type LinkTargetIdCandidate,
} from '@/utils/linkTargetAutocomplete.js'
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
  onBaseConfigClick?: (event: MouseEvent) => void
  readOnly?: boolean
}


const predicateKey = (p: BlockPredicate): string => JSON.stringify(p)

const OPERATOR_LABELS: Readonly<Record<PropertyFilterOperatorId, string>> = {
  eq: '=', lt: '<', lte: '≤', gt: '>', gte: '≥',
  between: 'between',
  'exists-true': 'is set',
  'exists-false': 'is unset',
}

/** Render a `where[name]: value` clause as a short, human-readable
 *  string for chips. Unwraps single-key `target` traversals so a chip
 *  reads "next-review-date < 2026-05-18" rather than exposing the
 *  internal ref-traversal shape. */
const formatPredicateClause = (name: string, value: unknown): string => {
  if (value === null) return `${name}=∅`
  if (value instanceof Date || typeof value !== 'object') {
    return `${name}=${formatScalar(value)}`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 1) {
    const [op, operand] = entries[0]!
    if (op === 'target' && operand && typeof operand === 'object') {
      // Unwrap to the inner clause but keep the outer property name.
      // Empty target → "ref is set"; single-key target → unwrap.
      const innerEntries = Object.entries(operand as Record<string, unknown>)
      if (innerEntries.length === 0) return `${name} is set`
      if (innerEntries.length === 1) {
        return formatPredicateClause(name, innerEntries[0]![1])
      }
    }
    if (op === 'exists') {
      return operand === false ? `${name}=∅` : `${name} is set`
    }
    if (op === 'between' && Array.isArray(operand) && operand.length === 2) {
      return `${name} ∈ [${formatScalar(operand[0])}, ${formatScalar(operand[1])}]`
    }
    const sym = OPERATOR_LABELS[op as PropertyFilterOperatorId]
    if (sym !== undefined) return `${name} ${sym} ${formatScalar(operand)}`
  }
  return `${name}=${JSON.stringify(value)}`
}

const formatScalar = (value: unknown): string => {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (value === null) return '∅'
  return String(value)
}

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
    .map(([name, value]) => formatPredicateClause(name, value))
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

type RefPredicateKind = 'refs' | 'contains'

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
  onAdd: (kind: RefPredicateKind, id: string) => void
}) => {
  const repo = useRepo()
  const listboxId = useId()
  const [formElement, setFormElement] = useState<HTMLFormElement | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<RefPredicateKind>('refs')
  const [focused, setFocused] = useState(false)
  const [results, setResults] = useState<LinkTargetIdCandidate[]>([])
  const trimmed = query.trim()
  const debouncedQuery = useDebouncedValue(trimmed, DEBOUNCE_MS)
  const popupOpen = focused && trimmed.length > 0 && results.length > 0

  const commitId = (id: string) => {
    if (readOnly) return
    onAdd(kind, id)
    setQuery('')
    setResults([])
  }

  const { activeIndex, setActiveIndex, activeDescendantId, onKeyDown, getOptionProps } =
    useAutocompleteListbox({
      itemCount: results.length,
      setOpen: setFocused,
      wrap: true,
      listboxId,
      onCommit: index => {
        const candidate = results[index]
        if (!candidate) return false
        commitId(candidate.id)
        return true
      },
    })

  useEffect(() => {
    // Only search once the debounce has settled (`trimmed === debouncedQuery`),
    // but keep raw `trimmed` in the deps so every keystroke re-runs the effect
    // and its cleanup cancels any in-flight search immediately. Without that, a
    // late result for the previous text could repopulate `results` for the
    // new/cleared input and Enter/the "+" button would commit a stale block.
    if (!workspaceId || !debouncedQuery || trimmed !== debouncedQuery) return

    let cancelled = false
    void searchLinkTargetIdCandidates(repo, {
      workspaceId,
      query: debouncedQuery,
      limit: SEARCH_LIMIT,
      excludeIds,
    }).then(nextResults => {
      if (cancelled) return
      setResults(nextResults)
      setActiveIndex(0)
    })

    return () => {
      cancelled = true
    }
  }, [excludeIds, repo, debouncedQuery, trimmed, setActiveIndex, workspaceId])

  // Submit (the "+" button / Enter without an open list) adds the first
  // match, falling back to an exact alias lookup for a typed-but-unlisted
  // name.
  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (readOnly) return
    const fallbackId = results[0]?.id
    if (fallbackId) {
      commitId(fallbackId)
      return
    }
    if (!trimmed) return
    const exact = await repo.query.aliasLookup({workspaceId, alias: trimmed}).load()
    if (exact) commitId(exact.id)
  }

  return (
    <form ref={setFormElement} className="flex min-w-0 flex-1 gap-1" onSubmit={handleSubmit}>
      <select
        value={kind}
        onChange={e => setKind(e.target.value as RefPredicateKind)}
        disabled={readOnly}
        className="h-8 shrink-0 rounded-md border bg-background px-1 text-xs"
        aria-label="Predicate kind"
        title={
          kind === 'refs'
            ? 'Match blocks whose context references the selected block'
            : 'Match blocks contained within the selected block'
        }
      >
        <option value="refs">refs</option>
        <option value="contains">in</option>
      </select>
      <Input
        value={query}
        onChange={event => {
          const next = event.target.value
          setQuery(next)
          if (!next.trim()) setResults([])
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={event => {
          if (event.key === 'Escape') {
            setQuery('')
            setResults([])
            return
          }
          onKeyDown(event)
        }}
        placeholder={mode === 'include' ? 'Include reference' : 'Exclude reference'}
        className="h-8 min-w-0 text-xs"
        disabled={readOnly}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={Boolean(popupOpen)}
        aria-controls={popupOpen ? listboxId : undefined}
        aria-activedescendant={popupOpen ? activeDescendantId : undefined}
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
            {...getOptionProps(index)}
            className={cn(
              'flex w-full min-w-0 flex-col rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              index === activeIndex ? 'bg-accent' : '',
            )}
          >
            <span className="truncate font-medium">{result.label}</span>
            {result.detail && result.detail !== result.label && (
              <span className="truncate text-muted-foreground">{truncate(result.detail, 72)}</span>
            )}
          </button>
        ))}
      </FloatingListbox>
    </form>
  )
}

const htmlInputType = (kind: PropertyFilterInputKind): 'date' | 'number' | 'text' =>
  kind === 'date' ? 'date' : kind === 'number' ? 'number' : 'text'

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
  const runtime = useAppRuntime()
  const refTargetDefaults = runtime.read(refTargetFilterDefaultsFacet)
  const queryable = useMemo(() => {
    return Array.from(schemas.values())
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [schemas])
  const [name, setName] = useState('')
  const [op, setOp] = useState<PropertyFilterOperatorId>('eq')
  const [value, setValue] = useState('')
  const [valueHi, setValueHi] = useState('')
  const schema = useMemo(() => schemas.get(name), [schemas, name])
  const affordance: PropertyFilterAffordance | undefined = useMemo(
    () => schema ? resolvePropertyFilter(schema, schemas, refTargetDefaults) : undefined,
    [schema, schemas, refTargetDefaults],
  )
  const arity = propertyFilterOperatorArity(op)
  const inputKind: PropertyFilterInputKind = affordance?.inputKind ?? 'text'
  const inputType = htmlInputType(inputKind)
  const defaultOperatorFor = (propertyName: string): PropertyFilterOperatorId => {
    const nextSchema = schemas.get(propertyName)
    if (!nextSchema) return 'eq'
    return resolvePropertyFilter(nextSchema, schemas, refTargetDefaults).operators[0] ?? 'eq'
  }

  const reset = () => {
    setName('')
    setOp('eq')
    setValue('')
    setValueHi('')
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (readOnly || !schema || !affordance) return
    const rawValues = arity === 2 ? [value, valueHi] : arity === 1 ? [value] : []
    const predicate = affordance.build(name, op, rawValues)
    if (!predicate) return
    onAdd(predicate)
    reset()
  }

  if (queryable.length === 0) return null

  const valueAriaLabel = mode === 'include' ? 'Include value' : 'Exclude value'
  const operators = affordance?.operators ?? []

  return (
    <form className="flex min-w-0 gap-1" onSubmit={submit}>
      <select
        value={name}
        onChange={e => {
          const nextName = e.target.value
          setName(nextName)
          setOp(defaultOperatorFor(nextName))
          setValue('')
          setValueHi('')
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
      {schema && operators.length > 1 && (
        <select
          value={op}
          onChange={e => setOp(e.target.value as PropertyFilterOperatorId)}
          disabled={readOnly}
          className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
          aria-label="operator"
        >
          {operators.map(o => (
            <option key={o} value={o}>{OPERATOR_LABELS[o]}</option>
          ))}
        </select>
      )}
      {inputKind === 'boolean' && arity === 1 ? (
        <select
          value={value}
          onChange={e => setValue(e.target.value)}
          disabled={readOnly}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
          aria-label={valueAriaLabel}
        >
          <option value="">(unset)</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : arity >= 1 ? (
        <Input
          type={inputType}
          value={value}
          onChange={e => setValue(e.target.value)}
          disabled={readOnly || !schema}
          placeholder={schema ? (inputType === 'text' ? schema.codec.type : inputType) : 'value'}
          className="h-8 min-w-0 flex-1 text-xs"
          aria-label={valueAriaLabel}
        />
      ) : null}
      {arity === 2 && (
        <Input
          type={inputType}
          value={valueHi}
          onChange={e => setValueHi(e.target.value)}
          disabled={readOnly || !schema}
          placeholder="and"
          className="h-8 min-w-0 flex-1 text-xs"
          aria-label={`${valueAriaLabel} (upper bound)`}
        />
      )}
      <Button
        type="submit"
        variant="ghost"
        size="icon"
        className="h-8 w-8 shrink-0"
        disabled={readOnly || !schema}
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
            onAdd={(kind, id) => addPredicate('include',
              kind === 'refs'
                ? {scope: 'ancestor', referencedBy: {id}}
                : {scope: 'ancestor', id},
            )}
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
            onAdd={(kind, id) => addPredicate('exclude',
              kind === 'refs'
                ? {scope: 'ancestor', referencedBy: {id}}
                : {scope: 'ancestor', id},
            )}
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
