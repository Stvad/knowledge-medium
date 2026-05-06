import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { type PropertyEditorProps } from '@/data/api'
import { typesFacet } from '@/data/facets.ts'
import { Block } from '@/data/block'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'

interface TypeOption {
  id: string
  label: string
  description?: string
}

const normalizedTypes = (value: readonly string[]): readonly string[] =>
  Array.from(new Set(value.map(type => type.trim()).filter(Boolean)))

export function TypesPropertyEditor({
  value,
  block,
}: PropertyEditorProps<readonly string[]>) {
  const runtime = useAppRuntime()
  const listboxId = useId()
  const typedBlock = block instanceof Block ? block : null
  const readOnly = typedBlock?.repo.isReadOnly ?? true
  const selected = useMemo(() => normalizedTypes(value), [value])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const typesRegistry = runtime.read(typesFacet)
  const options = useMemo<TypeOption[]>(() => Array.from(typesRegistry.values()).map(type => ({
    id: type.id,
    label: type.label ?? type.id,
    description: type.description,
  })), [typesRegistry])
  const optionsById = useMemo(() => new Map(options.map(option => [option.id, option])), [options])
  const queryText = query.trim().toLowerCase()
  const filtered = useMemo(() => options.filter(option => {
    if (selectedSet.has(option.id)) return false
    if (!queryText) return true
    return option.id.toLowerCase().includes(queryText) ||
      option.label.toLowerCase().includes(queryText)
  }), [options, queryText, selectedSet])

  const setTypes = (nextTypes: readonly string[]) => {
    if (!typedBlock || readOnly) return
    void typedBlock.repo.setBlockTypes(typedBlock.id, normalizedTypes(nextTypes))
  }

  const addType = (typeId: string) => {
    if (!typesRegistry.has(typeId) || selectedSet.has(typeId)) return
    setTypes([...selected, typeId])
    setQuery('')
    setOpen(false)
  }

  const removeType = (typeId: string) => {
    setTypes(selected.filter(selectedType => selectedType !== typeId))
  }

  const commitCurrentQuery = (): boolean => {
    const exact = options.find(option =>
      option.id.toLowerCase() === queryText ||
      option.label.toLowerCase() === queryText)
    const option = exact && !selectedSet.has(exact.id)
      ? exact
      : filtered[activeIndex] ?? filtered[0]
    if (!option) return false
    addType(option.id)
    return true
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (readOnly) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(index => Math.min(index + 1, Math.max(filtered.length - 1, 0)))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => Math.max(index - 1, 0))
      return
    }

    if ((event.key === 'Enter' || event.key === 'Tab') && query.trim()) {
      if (commitCurrentQuery()) event.preventDefault()
      return
    }

    if (event.key === 'Backspace' && !query && selected.length > 0) {
      event.preventDefault()
      removeType(selected[selected.length - 1])
      return
    }

    if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div
      className="relative min-w-0"
      onBlur={() => {
        window.setTimeout(() => setOpen(false), 120)
      }}
    >
      <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-transparent bg-transparent px-0 py-0.5 focus-within:border-input focus-within:px-1.5">
        {selected.map(typeId => {
          const option = optionsById.get(typeId)
          const label = option?.label ?? typeId
          return (
            <span
              key={typeId}
              className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
              title={option?.description ?? typeId}
            >
              <span className="truncate">{label}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={`Remove ${label} type`}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => removeType(typeId)}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          )
        })}
        <input
          className="h-6 min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/55 disabled:cursor-not-allowed disabled:opacity-60"
          value={query}
          placeholder="Add type"
          disabled={readOnly}
          role="combobox"
          aria-label="Add block type"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onChange={event => {
            setQuery(event.target.value)
            setActiveIndex(0)
            setOpen(true)
          }}
          onKeyDown={handleInputKeyDown}
        />
      </div>

      {open && !readOnly && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1 max-h-56 w-[min(22rem,100%)] overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-lg"
        >
          {filtered.length > 0 ? filtered.map((option, index) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left ${
                index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
              }`}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => addType(option.id)}
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.label !== option.id && (
                <span className="truncate text-xs text-muted-foreground">{option.id}</span>
              )}
            </button>
          )) : (
            <div className="px-2 py-1.5 text-muted-foreground">No matching types</div>
          )}
        </div>
      )}
    </div>
  )
}
