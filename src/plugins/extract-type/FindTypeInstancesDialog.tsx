/** FindTypeInstancesDialog — "Find instances of this type."
 *
 *  Invoked on an existing block-type block. Mirrors the second half
 *  of the extract-type flow:
 *
 *  Step 1 (configure): pre-filled picker showing the type's declared
 *  properties (resolved from `block-type:properties` refList). User
 *  can deselect any to broaden the match. No type-name input (the
 *  type already exists), no match-value toggle (the type carries no
 *  per-property instance values to compare against).
 *
 *  Step 2 (confirm): candidate list with checkboxes — blocks whose
 *  property bag covers the picked subset AND aren't already tagged
 *  with this type. User unchecks any false positives, clicks
 *  "Retag N blocks." */

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
import type { BlockData } from '@/data/api'
import {
  blockTypeLabelProp,
  getBlockTypes,
} from '@/data/properties'
import {
  findCandidatesByPropertyShape,
  retagBlocks,
} from '@/data/typeExtraction'
import {
  openFindTypeInstancesDialogEvent,
  type OpenFindTypeInstancesDialogEventDetail,
} from './events'
import {
  PropertyShapePicker,
  buildTypeShapeChoices,
  choicesToShape,
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
      const ids = await findCandidatesByPropertyShape(repo, {
        workspaceId: typeBlock.workspaceId,
        shape: choicesToShape(pickedChoices),
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
            {typeBlock ? `Find instances of “${typeLabel}”` : 'Find instances of type'}
          </DialogTitle>
          <DialogDescription>
            {step === 'configure'
              ? 'Pick which of this type’s properties to search for. Deselect any to broaden the match.'
              : `Review the candidates and confirm which should be retagged as ${typeLabel}.`}
          </DialogDescription>
        </DialogHeader>

        {step === 'configure' && typeBlock && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Type properties</Label>
              {choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This type declares no user-defined properties — there’s nothing to match candidates against. Add property-schema refs to the type’s block-type:properties first.
                </p>
              ) : (
                <PropertyShapePicker
                  choices={choices}
                  onChange={setChoices}
                  disabled={busy}
                  idPrefix="find-type-instances-pick"
                  showMatchValue={false}
                  emptyValuePlaceholder="—"
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
          <div className="space-y-4">
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
