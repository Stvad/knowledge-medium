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
import { useRepo } from '@/context/repo.tsx'
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
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults.tsx'
import {
  openFindTypeInstancesDialogEvent,
  type OpenFindTypeInstancesDialogEventDetail,
} from './events'
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

export function FindTypeInstancesDialog() {
  const repo = useRepo()
  const [open, setOpen] = useState(false)
  const [typeBlock, setTypeBlock] = useState<BlockData | null>(null)
  const [step, setStep] = useState<DialogStep>('configure')
  const [choices, setChoices] = useState<readonly PropertyShapeChoice[]>([])
  const [candidates, setCandidates] = useState<readonly BlockData[]>([])
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const handleOpen = async (event: Event) => {
      const detail = (event as CustomEvent<OpenFindTypeInstancesDialogEventDetail>).detail
      const data = await repo.load(detail.typeBlockId)
      if (!data) {
        setError(`Type block ${detail.typeBlockId} not found`)
        return
      }
      setTypeBlock(data)
      setChoices(buildTypeShapeChoices(repo, data))
      setCandidates([])
      setConfirmed(new Set())
      setError(null)
      setBusy(false)
      setStep('configure')
      setOpen(true)
    }
    window.addEventListener(openFindTypeInstancesDialogEvent, handleOpen)
    return () => window.removeEventListener(openFindTypeInstancesDialogEvent, handleOpen)
  }, [repo])

  const close = () => {
    setOpen(false)
    setTypeBlock(null)
    setChoices([])
    setCandidates([])
    setConfirmed(new Set())
    setError(null)
    setBusy(false)
    setStep('configure')
  }

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
      })
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
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retag')
      setBusy(false)
    }
  }

  const typeLabel = typeBlock ? typeLabelOf(typeBlock) : ''

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
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
              <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
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
                : `${candidates.length} block${candidates.length === 1 ? '' : 's'} match this shape and aren’t yet tagged as ${typeLabel}.`}
            </p>
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
                {Editor !== undefined ? (
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
