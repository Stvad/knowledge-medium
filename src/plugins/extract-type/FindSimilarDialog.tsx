/** FindSimilarDialog — "Find blocks with similar properties."
 *
 *  Standalone surface for the candidate-discovery half of the
 *  extract-type flow. Same property-subset picker as extract-type
 *  step 1, but the result is just a navigable list — no type creation,
 *  no retag. Useful when you want to ask "what else looks like this?"
 *  without committing to canonizing the shape as a type.
 *
 *  Step 1 (configure): pick which of the prototype's properties to
 *  search for, with optional per-property value match.
 *
 *  Step 2 (results): click a candidate row to navigate to it; the
 *  dialog closes on navigation. */

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
import { useRepo } from '@/context/repo.tsx'
import { useNavigateFromGlobalCommand } from '@/utils/navigation.ts'
import type { BlockData } from '@/data/api'
import { findCandidatesByPropertyShape } from '@/data/typeExtraction'
import {
  openFindSimilarDialogEvent,
  type OpenFindSimilarDialogEventDetail,
} from './events'
import {
  PropertyShapePicker,
  buildPropertyShapeChoices,
  choicesToShape,
  type PropertyShapeChoice,
} from './PropertyShapePicker'

type DialogStep = 'configure' | 'results'

const formatCandidateLabel = (data: BlockData): string => {
  const content = data.content?.trim() ?? ''
  if (content.length > 0) return content
  return `(empty block ${data.id.slice(0, 8)})`
}

export function FindSimilarDialog() {
  const repo = useRepo()
  const navigate = useNavigateFromGlobalCommand()
  const [open, setOpen] = useState(false)
  const [prototypeId, setPrototypeId] = useState<string | null>(null)
  const [prototype, setPrototype] = useState<BlockData | null>(null)
  const [step, setStep] = useState<DialogStep>('configure')
  const [choices, setChoices] = useState<readonly PropertyShapeChoice[]>([])
  const [candidates, setCandidates] = useState<readonly BlockData[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const handleOpen = async (event: Event) => {
      const detail = (event as CustomEvent<OpenFindSimilarDialogEventDetail>).detail
      const data = await repo.load(detail.prototypeBlockId)
      if (!data) {
        setError(`Block ${detail.prototypeBlockId} not found`)
        return
      }
      setPrototypeId(detail.prototypeBlockId)
      setPrototype(data)
      setChoices(buildPropertyShapeChoices(repo, data))
      setCandidates([])
      setError(null)
      setBusy(false)
      setStep('configure')
      setOpen(true)
    }
    window.addEventListener(openFindSimilarDialogEvent, handleOpen)
    return () => window.removeEventListener(openFindSimilarDialogEvent, handleOpen)
  }, [repo])

  const close = () => {
    setOpen(false)
    setPrototypeId(null)
    setPrototype(null)
    setChoices([])
    setCandidates([])
    setError(null)
    setBusy(false)
    setStep('configure')
  }

  const pickedChoices = useMemo(
    () => choices.filter(c => c.picked),
    [choices],
  )
  const canSearch = pickedChoices.length > 0 && !busy

  const handleSearch = async () => {
    if (!prototype || !prototypeId) return
    setError(null)
    setBusy(true)
    try {
      const ids = await findCandidatesByPropertyShape(repo, {
        workspaceId: prototype.workspaceId,
        shape: choicesToShape(pickedChoices),
        exclude: [prototypeId],
      })
      const rows = await Promise.all(ids.map(id => repo.load(id)))
      const live = rows.filter((r): r is BlockData => r !== null)
      setCandidates(live)
      setStep('results')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to search')
    } finally {
      setBusy(false)
    }
  }

  const handleNavigate = (candidate: BlockData) => {
    navigate({blockId: candidate.id, workspaceId: candidate.workspaceId})
    close()
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Find blocks with similar properties</DialogTitle>
          <DialogDescription>
            {step === 'configure'
              ? 'Pick which of this block’s properties to search for. Toggle "match value" to require an exact match instead of just "the property is set."'
              : 'Click a result to navigate to it.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'configure' && prototype && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Properties</Label>
              {choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This block has no searchable properties.
                </p>
              ) : (
                <PropertyShapePicker
                  choices={choices}
                  onChange={setChoices}
                  disabled={busy}
                  idPrefix="find-similar-pick"
                />
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
              <Button onClick={handleSearch} disabled={!canSearch}>
                {busy ? 'Searching…' : 'Search'}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'results' && (
          <div className="space-y-4">
            <p className="text-sm">
              {candidates.length === 0
                ? 'No other blocks match this shape.'
                : `${candidates.length} match${candidates.length === 1 ? '' : 'es'}. The prototype is excluded.`}
            </p>
            {candidates.length > 0 && (
              <ul className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
                {candidates.map(candidate => (
                  <li key={candidate.id}>
                    <button
                      type="button"
                      className="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-muted/60"
                      onClick={() => handleNavigate(candidate)}
                    >
                      {formatCandidateLabel(candidate)}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="ghost" onClick={() => setStep('configure')} disabled={busy}>
                Back
              </Button>
              <Button onClick={close}>Close</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
