import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { Plus, Search, X } from 'lucide-react'
import {
  isRefCodec,
  isRefListCodec,
  type PropertyEditorProps,
  type PropertySchema,
} from '@/data/api'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.tsx'
import { getBlockTypes } from '@/data/properties.ts'
import { useWorkspaceId } from '@/hooks/block.ts'
import { BlockEmbed } from '@/markdown/blockrefs/BlockEmbed.tsx'
import { BlockRefAncestorsProvider } from '@/markdown/blockrefs/cycleGuard.tsx'
import {
  labelForBlockData,
  searchLinkTargetIdCandidates,
  type LinkTargetIdCandidate,
} from '@/utils/linkTargetAutocomplete.ts'

const SEARCH_LIMIT = 12
const EMPTY_REFS: readonly string[] = Object.freeze([])

const normalizeId = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const normalizeIds = (value: readonly string[]): readonly string[] =>
  Array.from(new Set(value.map(normalizeId).filter(Boolean)))

const targetTypesForSchema = (schema?: PropertySchema<unknown>): readonly string[] => {
  if (!schema) return EMPTY_REFS
  if (isRefCodec(schema.codec) || isRefListCodec(schema.codec)) return schema.codec.targetTypes
  return EMPTY_REFS
}

const compactDetail = (text: string): string =>
  text.replace(/\s+/g, ' ').trim()

const candidateLabel = (candidate: LinkTargetIdCandidate): string =>
  compactDetail(candidate.label) || candidate.id

const candidateDetail = (candidate: LinkTargetIdCandidate): string =>
  compactDetail(candidate.detail)

const blockMatchesTargetTypes = async (
  repo: Repo,
  blockId: string,
  targetTypes: readonly string[],
): Promise<boolean> => {
  if (targetTypes.length === 0) return true
  const data = await repo.block(blockId).load()
  if (!data) return false
  const types = getBlockTypes(data)
  return targetTypes.some(type => types.includes(type))
}

const filterByTargetTypes = async (
  repo: Repo,
  candidates: readonly LinkTargetIdCandidate[],
  targetTypes: readonly string[],
): Promise<LinkTargetIdCandidate[]> => {
  if (targetTypes.length === 0) return [...candidates]
  const checks = await Promise.all(candidates.map(async candidate => ({
    candidate,
    matches: await blockMatchesTargetTypes(repo, candidate.id, targetTypes),
  })))
  const filtered = checks.filter(check => check.matches).map(check => check.candidate)
  // Target types are advisory metadata for the picker. Some existing
  // reference targets, especially deterministic alias/date targets, may
  // predate type materialization; do not turn a useful search result
  // into an empty menu just because the target lacks the expected type.
  return filtered.length > 0 ? filtered : [...candidates]
}

const searchReferenceCandidates = async (
  repo: Repo,
  {
    workspaceId,
    query,
    excludeIds,
    targetTypes,
  }: {
    workspaceId: string
    query: string
    excludeIds: Iterable<string>
    targetTypes: readonly string[]
  },
): Promise<LinkTargetIdCandidate[]> => {
  if (!workspaceId) return []
  const excluded = new Set(Array.from(excludeIds).map(normalizeId).filter(Boolean))
  const trimmed = query.trim()

  let candidates: LinkTargetIdCandidate[]
  if (trimmed) {
    candidates = await searchLinkTargetIdCandidates(repo, {
      workspaceId,
      query: trimmed,
      limit: SEARCH_LIMIT,
      excludeIds: excluded,
    })
  } else {
    const [aliasRows, recentBlocks] = await Promise.all([
      repo.query.aliasMatches({
        workspaceId,
        filter: '',
        limit: SEARCH_LIMIT,
      }).load(),
      repo.query.recentBlocks({
        workspaceId,
        limit: SEARCH_LIMIT,
      }).load(),
    ])
    const seen = new Set(excluded)
    candidates = []
    for (const row of aliasRows) {
      if (seen.has(row.blockId)) continue
      seen.add(row.blockId)
      candidates.push({
        id: row.blockId,
        label: row.alias,
        detail: row.content,
      })
    }
    for (const block of recentBlocks ?? []) {
      if (seen.has(block.id)) continue
      seen.add(block.id)
      candidates.push({
        id: block.id,
        label: labelForBlockData(block, block.id),
        detail: block.content,
      })
    }
  }

  return (await filterByTargetTypes(repo, candidates, targetTypes)).slice(0, SEARCH_LIMIT)
}

function ReferenceEmbed({
  owner,
  blockId,
  readOnly,
  onRemove,
}: {
  owner: Block
  blockId: string
  readOnly: boolean
  onRemove: () => void
}) {
  const blockContext = useBlockContext()
  const panelId = blockContext.panelId ?? `property:${owner.id}`

  return (
    <div className="group/ref relative min-w-0 rounded-md border border-border/40 bg-background/60 pr-8">
      <NestedBlockContextProvider overrides={{panelId}}>
        <BlockRefAncestorsProvider ancestor={owner.id}>
          <BlockEmbed blockId={blockId} />
        </BlockRefAncestorsProvider>
      </NestedBlockContextProvider>
      {!readOnly && (
        <button
          type="button"
          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-muted hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/ref:opacity-100"
          aria-label="Remove block reference"
          onClick={event => {
            event.preventDefault()
            event.stopPropagation()
            onRemove()
          }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

function EmptyReference() {
  return (
    <div className="h-7 truncate py-1 text-sm text-muted-foreground/55">
      Empty
    </div>
  )
}

function ReferenceSearch({
  owner,
  excludeIds,
  targetTypes,
  placeholder,
  onPick,
}: {
  owner: Block
  excludeIds: readonly string[]
  targetTypes: readonly string[]
  placeholder: string
  onPick: (blockId: string) => void
}) {
  const listboxId = useId()
  const workspaceId = useWorkspaceId(owner, owner.repo.activeWorkspaceId ?? '')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [candidates, setCandidates] = useState<LinkTargetIdCandidate[]>([])
  const normalizedExcludeIds = useMemo(() => normalizeIds(excludeIds), [excludeIds])

  useEffect(() => {
    if (!open) return
    let cancelled = false

    void Promise.resolve().then(() => {
      if (!cancelled) setLoading(true)
      return searchReferenceCandidates(owner.repo, {
        workspaceId,
        query,
        excludeIds: normalizedExcludeIds,
        targetTypes,
      })
    }).then(next => {
      if (cancelled) return
      setCandidates(next)
      setActiveIndex(0)
    }).catch(error => {
      if (!cancelled) {
        console.error('[RefPropertyEditor] block search failed', error)
        setCandidates([])
      }
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [normalizedExcludeIds, open, owner.repo, query, targetTypes, workspaceId])

  const pick = (candidate: LinkTargetIdCandidate) => {
    onPick(candidate.id)
    setQuery('')
    setOpen(false)
  }

  const commitActive = (): boolean => {
    const candidate = candidates[activeIndex] ?? candidates[0]
    if (!candidate) return false
    pick(candidate)
    return true
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(index => Math.min(index + 1, Math.max(candidates.length - 1, 0)))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => Math.max(index - 1, 0))
      return
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      if (commitActive()) event.preventDefault()
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
      <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-md border border-transparent bg-transparent px-0 focus-within:border-input focus-within:px-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/55"
          value={query}
          placeholder={placeholder}
          role="combobox"
          aria-label="Search block reference"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onChange={event => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onKeyDown={handleKeyDown}
        />
      </div>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1 max-h-64 w-[min(28rem,100%)] overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-lg"
        >
          {candidates.length > 0 ? candidates.map((candidate, index) => {
            const label = candidateLabel(candidate)
            const detail = candidateDetail(candidate)
            return (
              <button
                key={`${candidate.id}:${candidate.label}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left ${
                  index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                }`}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => pick(candidate)}
              >
                <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {detail && detail !== label && (
                  <span className="max-w-[11rem] truncate text-xs text-muted-foreground">{detail}</span>
                )}
              </button>
            )
          }) : (
            <div className="px-2 py-1.5 text-muted-foreground">
              {loading ? 'Searching...' : 'No matching blocks'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RefPropertyEditorInner({
  value,
  onChange,
  block,
  schema,
}: PropertyEditorProps<string> & {block: Block}) {
  const blockId = normalizeId(value)
  const readOnly = block.repo.isReadOnly
  const targetTypes = useMemo(
    () => targetTypesForSchema(schema as PropertySchema<unknown> | undefined),
    [schema],
  )

  if (blockId) {
    return (
      <ReferenceEmbed
        owner={block}
        blockId={blockId}
        readOnly={readOnly}
        onRemove={() => onChange('')}
      />
    )
  }

  if (readOnly) return <EmptyReference />

  return (
    <ReferenceSearch
      owner={block}
      excludeIds={EMPTY_REFS}
      targetTypes={targetTypes}
      placeholder="Search blocks"
      onPick={onChange}
    />
  )
}

function RefListPropertyEditorInner({
  value,
  onChange,
  block,
  schema,
}: PropertyEditorProps<readonly string[]> & {block: Block}) {
  const blockIds = useMemo(() => normalizeIds(value), [value])
  const readOnly = block.repo.isReadOnly
  const targetTypes = useMemo(
    () => targetTypesForSchema(schema as PropertySchema<unknown> | undefined),
    [schema],
  )

  const remove = (blockId: string) => {
    onChange(blockIds.filter(id => id !== blockId))
  }

  const add = (blockId: string) => {
    const normalized = normalizeId(blockId)
    if (!normalized || blockIds.includes(normalized)) return
    onChange([...blockIds, normalized])
  }

  return (
    <div className="min-w-0 space-y-1.5">
      {blockIds.map(blockId => (
        <ReferenceEmbed
          key={blockId}
          owner={block}
          blockId={blockId}
          readOnly={readOnly}
          onRemove={() => remove(blockId)}
        />
      ))}
      {!readOnly && (
        <ReferenceSearch
          owner={block}
          excludeIds={blockIds}
          targetTypes={targetTypes}
          placeholder={blockIds.length > 0 ? 'Add block' : 'Search blocks'}
          onPick={add}
        />
      )}
      {readOnly && blockIds.length === 0 && <EmptyReference />}
    </div>
  )
}

export function RefPropertyEditor(props: PropertyEditorProps<string>) {
  if (!(props.block instanceof Block)) return <EmptyReference />
  return <RefPropertyEditorInner {...props} block={props.block} />
}

export function RefListPropertyEditor(props: PropertyEditorProps<readonly string[]>) {
  if (!(props.block instanceof Block)) return <EmptyReference />
  return <RefListPropertyEditorInner {...props} block={props.block} />
}
