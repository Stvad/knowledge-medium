/** FindTypeInstancesDialog — "Find blocks to retag as this type."
 *
 *  Step 1 of the extract-type flow delegates here after creating the
 *  type, and the dialog is also usable standalone on any existing
 *  block-type block.
 *
 *  Step 1 (configure): list the type's declared properties. For each
 *  picked property the user can optionally enter a value via the
 *  property's normal property-panel editor (Date picker, ref
 *  autocomplete, etc.). Picked properties without a value match on
 *  presence only ("the property is set, any value"); picked
 *  properties with a value require exact match.
 *
 *  Step 2 (confirm): candidate list with checkboxes — blocks whose
 *  property bag covers the picked subset AND aren't already tagged
 *  with this type. */

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { useRepo } from '@/context/repo.js'
import { isRefCodec, isRefListCodec, type BlockData } from '@/data/api'
import {
  blockTypeLabelProp,
  getBlockTypes,
} from '@/data/properties'
import {
  findCandidatesByPropertyShape,
  retagBlocks,
  type PropertyShapeFilter,
} from '@/data/typeExtraction'
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults.js'
import { ReferenceSearch } from '@/components/propertyEditors/RefPropertyEditor.js'
import type { Block } from '@/data/block'
import type { AnyPropertySchema } from '@/data/api'
import { useHandle } from '@/hooks/block.js'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.js'
import { X } from 'lucide-react'
import type { DialogContextProps } from '@/utils/dialogs.js'
import {
  buildTypeShapeChoices,
  type PropertyShapeChoice,
} from './PropertyShapePicker'

type DialogStep = 'configure' | 'confirm'

const formatCandidateLabel = (data: BlockData): string => {
  const content = data.content?.trim() ?? ''
  if (content.length > 0) return content
  return `(empty block ${data.id.slice(0, 8)})`
}

const typeLabelOf = (typeBlock: BlockData): string => {
  const raw = typeBlock.properties[blockTypeLabelProp.name]
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  return typeBlock.content?.trim() || `(unlabeled ${typeBlock.id.slice(0, 8)})`
}

const isMeaningfulValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

/** Normalize the user-entered editor value for a ref / refList
 *  property into the array of target ids `PropertyShapeFilter.targetIds`
 *  expects. Drops empties and de-dupes. */
const collectTargetIds = (value: unknown): readonly string[] => {
  const ids: string[] = []
  if (typeof value === 'string' && value.trim() !== '') {
    ids.push(value.trim())
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.trim() !== '') ids.push(item.trim())
    }
  }
  return Array.from(new Set(ids))
}

/** Hard cap on candidates surfaced to the user at once. Above this
 *  the picker becomes unwieldy (every row is a checkbox + live block
 *  label) and we'd rather make the user narrow their filter. The cap
 *  is local to this dialog — `findCandidatesByPropertyShape`'s own
 *  default (1000) was too low for the retag flow and produced
 *  suspicious round counts. When the result length equals the cap we
 *  show an inline truncation hint. */
const CANDIDATE_DISPLAY_LIMIT = 5000

export interface FindTypeInstancesDialogProps {
  typeBlockId: string
}

export function FindTypeInstancesDialog({
  typeBlockId,
  resolve,
  cancel,
}: DialogContextProps<void> & FindTypeInstancesDialogProps) {
  const repo = useRepo()
  const [typeBlock, setTypeBlock] = useState<BlockData | null>(null)
  const [step, setStep] = useState<DialogStep>('configure')
  const [choices, setChoices] = useState<readonly PropertyShapeChoice[]>([])
  const [candidates, setCandidates] = useState<readonly BlockData[]>([])
  const [truncated, setTruncated] = useState(false)
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const data = await repo.load(typeBlockId)
      if (cancelled) return
      if (!data) {
        setError(`Type block ${typeBlockId} not found`)
        return
      }
      setTypeBlock(data)
      setChoices(buildTypeShapeChoices(repo, data))
    })()
    return () => { cancelled = true }
  }, [repo, typeBlockId])

  const pickedChoices = useMemo(
    () => choices.filter(c => c.picked),
    [choices],
  )
  const canSearch = pickedChoices.length > 0 && !busy
  const canRetag = candidates.length > 0 && confirmed.size > 0 && !busy

  const handleSearch = async () => {
    if (!typeBlock) return
    setError(null)
    setBusy(true)
    try {
      // For each picked property, build a PropertyShapeFilter. Ref /
      // refList properties get `targetIds` (permissive contains —
      // candidate's refList must include all picked ids); scalars
      // get `value` (exact match); empty values fall back to presence.
      const shape: PropertyShapeFilter[] = pickedChoices.map(c => {
        const schema = repo.propertySchemas.get(c.name)
        const isRef = schema && (isRefCodec(schema.codec) || isRefListCodec(schema.codec))
        if (isRef) {
          const targetIds = collectTargetIds(c.value)
          return targetIds.length > 0
            ? {name: c.name, targetIds}
            : {name: c.name}
        }
        return isMeaningfulValue(c.value)
          ? {name: c.name, value: c.value}
          : {name: c.name}
      })
      const ids = await findCandidatesByPropertyShape(repo, {
        workspaceId: typeBlock.workspaceId,
        shape,
        // Exclude the type-definition block itself — it'd otherwise
        // surface as a self-match (its properties_json carries the
        // block-type:* fields, not the type's instance fields, so it
        // typically wouldn't match — but exclude defensively).
        exclude: [typeBlock.id],
        limit: CANDIDATE_DISPLAY_LIMIT,
      })
      setTruncated(ids.length >= CANDIDATE_DISPLAY_LIMIT)
      const rows = await Promise.all(ids.map(id => repo.load(id)))
      // Drop blocks that already carry this type — retagBlocks would
      // be a no-op for them and they clutter the picker.
      const live = rows.filter((r): r is BlockData =>
        r !== null && !getBlockTypes(r).includes(typeBlock.id),
      )
      setCandidates(live)
      setConfirmed(new Set(live.map(r => r.id)))
      setStep('confirm')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to find candidates')
    } finally {
      setBusy(false)
    }
  }

  const handleSubmit = async () => {
    if (!typeBlock) return
    setError(null)
    setBusy(true)
    try {
      const instanceIds = candidates
        .map(c => c.id)
        .filter(id => confirmed.has(id))
      if (instanceIds.length > 0) {
        await retagBlocks(repo, {typeId: typeBlock.id, instanceIds})
      }
      resolve()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retag')
      setBusy(false)
    }
  }

  const typeLabel = typeBlock ? typeLabelOf(typeBlock) : ''

  return (
    <Dialog open onOpenChange={next => { if (!next) cancel() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {typeBlock ? `Find blocks to retag as “${typeLabel}”` : 'Find blocks to retag'}
          </DialogTitle>
          <DialogDescription>
            {step === 'configure'
              ? 'Pick which of this type’s properties to match on. Optionally enter a value to require exact match instead of just presence.'
              : `Review the candidates and confirm which should be retagged as ${typeLabel}.`}
          </DialogDescription>
        </DialogHeader>

        {step === 'configure' && typeBlock && (
          <div className="min-w-0 space-y-4">
            <div className="space-y-2">
              <Label>Type properties</Label>
              {choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This type declares no user-defined properties — there’s nothing to match candidates against. Add property-schema refs to the type’s block-type:properties first.
                </p>
              ) : (
                <TypeInstanceRows
                  choices={choices}
                  onChange={setChoices}
                  typeBlockId={typeBlock.id}
                  disabled={busy}
                />
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="ghost" onClick={cancel} disabled={busy}>Cancel</Button>
              <Button onClick={handleSearch} disabled={!canSearch}>
                {busy ? 'Searching…' : 'Find candidates'}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'confirm' && typeBlock && (
          <div className="min-w-0 space-y-4">
            <p className="text-sm">
              {candidates.length === 0
                ? `No untagged blocks match this shape.`
                : `${candidates.length.toLocaleString()} block${candidates.length === 1 ? '' : 's'} match this shape and aren’t yet tagged as ${typeLabel}.`}
            </p>
            {truncated && (
              <p className="text-sm text-amber-600 dark:text-amber-500">
                More candidates exist — results were capped at {CANDIDATE_DISPLAY_LIMIT.toLocaleString()}. Narrow the filter to see the rest.
              </p>
            )}
            {candidates.length > 0 && (
              <ul className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
                {candidates.map(candidate => (
                  <li key={candidate.id} className="flex items-center gap-3 rounded px-2 py-1 hover:bg-muted/60">
                    <Checkbox
                      id={`find-type-instances-confirm-${candidate.id}`}
                      checked={confirmed.has(candidate.id)}
                      onCheckedChange={next => {
                        setConfirmed(prev => {
                          const out = new Set(prev)
                          if (next === true) out.add(candidate.id)
                          else out.delete(candidate.id)
                          return out
                        })
                      }}
                      disabled={busy}
                    />
                    <Label
                      htmlFor={`find-type-instances-confirm-${candidate.id}`}
                      className="min-w-0 flex-1 cursor-pointer truncate text-sm"
                    >
                      {formatCandidateLabel(candidate)}
                    </Label>
                  </li>
                ))}
              </ul>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep('configure')} disabled={busy}>
                Back
              </Button>
              <Button onClick={handleSubmit} disabled={busy || (candidates.length > 0 && !canRetag)}>
                {busy
                  ? 'Retagging…'
                  : candidates.length === 0
                    ? 'Done'
                    : `Retag ${confirmed.size} block${confirmed.size === 1 ? '' : 's'}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Row list for the find-type-instances picker. Each row is the
 *  property's checkbox + name on the left, and the property-panel
 *  Editor (resolved via the normal codec → preset chain) on the right
 *  for capturing an optional value filter.
 *
 *  The Editor's `block` slot is filled with the type-block facade so
 *  ref/refList editors (which need repo + workspace context) work
 *  unmodified. The type block is never written to by these editors —
 *  they only call our local `onChange`. */
function TypeInstanceRows({
  choices,
  onChange,
  typeBlockId,
  disabled,
}: {
  choices: readonly PropertyShapeChoice[]
  onChange: (next: readonly PropertyShapeChoice[]) => void
  typeBlockId: string
  disabled: boolean
}) {
  const repo = useRepo()
  const ownerBlock = useMemo(() => repo.block(typeBlockId), [repo, typeBlockId])
  return (
    <ul className="max-h-96 min-w-0 space-y-1 overflow-auto rounded-md border p-2">
      {choices.map((choice, idx) => {
        const display = resolvePropertyDisplay({
          name: choice.name,
          encodedValue: undefined,
          schemas: repo.propertySchemas,
          uis: repo.propertyEditorOverrides,
          presets: repo.valuePresets,
        })
        const Editor = display.Editor
        const setChoice = (next: Partial<PropertyShapeChoice>) => {
          onChange(choices.map((c, i) => (i === idx ? {...c, ...next} : c)))
        }
        const isRef = isRefCodec(display.schema.codec)
        const isRefList = isRefListCodec(display.schema.codec)
        return (
          <li
            key={choice.name}
            className="flex min-w-0 items-start gap-3 rounded px-2 py-1.5 hover:bg-muted/60"
          >
            <Checkbox
              id={`find-type-instances-pick-${idx}`}
              checked={choice.picked}
              onCheckedChange={next => setChoice({picked: next === true})}
              disabled={disabled}
              className="mt-1.5"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <Label
                htmlFor={`find-type-instances-pick-${idx}`}
                className="cursor-pointer truncate font-mono text-sm"
              >
                {choice.name}
              </Label>
              <div className={choice.picked ? '' : 'opacity-50 pointer-events-none'}>
                {isRef || isRefList ? (
                  <RefFilterEditor
                    schema={display.schema}
                    owner={ownerBlock}
                    isList={isRefList}
                    value={choice.value}
                    onChange={(next: unknown) => setChoice({value: next})}
                  />
                ) : Editor !== undefined ? (
                  <Editor
                    value={choice.value}
                    onChange={(next: unknown) => setChoice({value: next})}
                    block={ownerBlock}
                    schema={display.schema}
                  />
                ) : (
                  <div className="text-xs text-muted-foreground/70">
                    No editor registered for {display.shape}.
                  </div>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

const EMPTY_IDS: readonly string[] = Object.freeze([])

/** Compact ref / refList editor for the filter context.
 *
 *  Reuses the autocomplete (`ReferenceSearch`) from the standard
 *  RefPropertyEditor so users see the same blocks they'd see in any
 *  other ref picker. Replaces the full `BlockEmbed` display with a
 *  one-line chip per picked block — `BlockEmbed` is meant for "show me
 *  this block in context" and renders an entire BlockComponent, which
 *  is overkill (and visually broken) for a filter input.
 *
 *  `isList === false` collapses the editor to a single picked value
 *  (`ref` codec); `true` accumulates a list (`refList`). The shape is
 *  `string | undefined` and `readonly string[]` respectively, matching
 *  what the schema codecs decode to. */
function RefFilterEditor({
  schema,
  owner,
  isList,
  value,
  onChange,
}: {
  schema: AnyPropertySchema
  owner: Block
  isList: boolean
  value: unknown
  onChange: (next: unknown) => void
}) {
  const targetTypes = useMemo(() => {
    if (isRefCodec(schema.codec) || isRefListCodec(schema.codec)) {
      return schema.codec.targetTypes
    }
    return EMPTY_IDS
  }, [schema])

  const pickedIds: readonly string[] = useMemo(() => {
    if (isList) return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : EMPTY_IDS
    return typeof value === 'string' && value.length > 0 ? [value] : EMPTY_IDS
  }, [isList, value])

  const removeId = (id: string) => {
    if (isList) onChange(pickedIds.filter(x => x !== id))
    else onChange('')
  }

  const addId = (id: string) => {
    if (isList) {
      if (pickedIds.includes(id)) return
      onChange([...pickedIds, id])
    } else {
      onChange(id)
    }
  }

  // For `ref` we hide the picker once a value is set; the chip's X
  // clears it. For `refList` the picker stays so the user can keep
  // adding ids.
  const showPicker = isList || pickedIds.length === 0

  return (
    <div className="min-w-0 space-y-1.5">
      {pickedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {pickedIds.map(id => (
            <RefChip key={id} blockId={id} onRemove={() => removeId(id)} />
          ))}
        </div>
      )}
      {showPicker && (
        <ReferenceSearch
          owner={owner}
          excludeIds={pickedIds}
          targetTypes={targetTypes}
          placeholder="Search blocks"
          selectionMode={isList ? 'multiple' : 'single'}
          onPick={addId}
        />
      )}
    </div>
  )
}

/** One-line chip showing the picked block's label + remove button.
 *  Reactive: re-renders if the referenced block's content/aliases
 *  change while the dialog is open. */
function RefChip({blockId, onRemove}: {blockId: string; onRemove: () => void}) {
  const repo = useRepo()
  const handle = useMemo(() => repo.block(blockId), [repo, blockId])
  const label = useHandle(handle, {
    selector: data => labelForBlockData(data, `(${blockId.slice(0, 8)})`),
  })
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-sm">
      <span className="min-w-0 truncate" title={label}>{label}</span>
      <button
        type="button"
        className="shrink-0 rounded-sm text-muted-foreground hover:text-destructive"
        aria-label={`Remove ${label}`}
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          onRemove()
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  )
}
