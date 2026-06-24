/** ExtractTypeDialog — Step 1 of the extract-type flow: pure type
 *  assembly from a prototype.
 *
 *  The user picks which of the prototype's properties belong on the
 *  new type and names it. No values, no match-value, no candidate
 *  preview — those concerns live in the "find candidates for this
 *  type" dialog, which is also a standalone command and is what
 *  Step 2 of the extract flow delegates to.
 *
 *  On submit:
 *   1. `createTypeBlock` materialises a fresh block-type block with
 *      the caller's label + picked schema refList.
 *   2. The dialog resolves with the new type id; the `extractType`
 *      action then opens the find-type-instances dialog on it, so the
 *      user lands directly in the candidate-finding flow with the new
 *      type's properties pre-listed. */

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useRepo } from '@/context/repo.js'
import type { BlockData } from '@/data/api'
import { createTypeBlock } from '@/data/typeExtraction'
import type { DialogContextProps } from '@/utils/dialogs.js'
import {
  PropertyShapePicker,
  buildPropertyShapeChoices,
  type PropertyShapeChoice,
} from './PropertyShapePicker'

export interface ExtractTypeDialogProps {
  prototypeBlockId: string
}

export interface ExtractTypeDialogResult {
  typeBlockId: string
}

export function ExtractTypeDialog({
  prototypeBlockId,
  resolve,
  cancel,
}: DialogContextProps<ExtractTypeDialogResult> & ExtractTypeDialogProps) {
  const repo = useRepo()
  const [prototype, setPrototype] = useState<BlockData | null>(null)
  const [typeName, setTypeName] = useState('')
  const [choices, setChoices] = useState<readonly PropertyShapeChoice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const data = await repo.load(prototypeBlockId)
      if (cancelled) return
      if (!data) {
        setError(`Block ${prototypeBlockId} not found`)
        return
      }
      setPrototype(data)
      setChoices(buildPropertyShapeChoices(repo, data))
    })()
    return () => { cancelled = true }
  }, [repo, prototypeBlockId])

  const pickedChoices = useMemo(
    () => choices.filter(c => c.picked),
    [choices],
  )
  const pickedSchemaBlockIds = useMemo(
    () => pickedChoices.filter(c => c.schemaBlockId !== undefined).map(c => c.schemaBlockId!),
    [pickedChoices],
  )
  const droppedFromTypeCount = pickedChoices.length - pickedSchemaBlockIds.length

  const canCreate =
    typeName.trim() !== '' &&
    pickedSchemaBlockIds.length > 0 &&
    !busy

  const handleCreate = async () => {
    if (!prototype) return
    setError(null)
    setBusy(true)
    try {
      const typeId = await createTypeBlock(repo, {
        workspaceId: prototype.workspaceId,
        label: typeName.trim(),
        propertySchemaIds: pickedSchemaBlockIds,
      })
      resolve({typeBlockId: typeId})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create type')
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={next => { if (!next) cancel() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Extract type from this block</DialogTitle>
          <DialogDescription>
            Name the new type and pick which of this block’s properties belong on it.
            You’ll then be prompted to find blocks to retag as the new type.
          </DialogDescription>
        </DialogHeader>

        {prototype && (
          <div className="min-w-0 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="extract-type-name">Type name</Label>
              <Input
                id="extract-type-name"
                autoFocus
                placeholder="Task"
                value={typeName}
                onChange={e => setTypeName(e.target.value)}
                disabled={busy}
              />
            </div>

            <div className="space-y-2">
              <Label>Properties</Label>
              {choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This block has no extractable properties. Set some properties on it before extracting a type.
                </p>
              ) : (
                <PropertyShapePicker
                  choices={choices}
                  onChange={setChoices}
                  disabled={busy}
                  idPrefix="extract-pick"
                  showNoSchemaNote
                  showMatchValue={false}
                  showValuePreview={false}
                />
              )}
              {droppedFromTypeCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {droppedFromTypeCount} picked propert{droppedFromTypeCount === 1 ? 'y has' : 'ies have'} no user-defined schema and can’t be added to the new type definition.
                </p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="ghost" onClick={cancel} disabled={busy}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!canCreate}>
                {busy ? 'Creating…' : 'Create type'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
