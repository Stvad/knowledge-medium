/** ExtractTypeDialog — the two-step UI for the extract-type-from-
 *  prototype flow.
 *
 *  Step 1 (configure): user names the new type and picks which of the
 *  prototype's properties belong on the type definition. Optional
 *  "match value" toggle per row decides whether the candidate query
 *  filters on the property's exact value or just on "the property is
 *  set."
 *
 *  Step 2 (confirm): show the list of blocks that match the picked
 *  shape (excluding the prototype itself) with checkboxes. User
 *  unchecks any false positives and clicks "Create type & retag." */

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
import { Checkbox } from '@/components/ui/checkbox'
import { useRepo } from '@/context/repo.tsx'
import {
  aliasesProp,
  rendererNameProp,
  rendererProp,
  typesProp,
} from '@/data/properties'
import type { BlockData } from '@/data/api'
import {
  createTypeBlock,
  findCandidatesByPropertyShape,
  retagBlocks,
} from '@/data/typeExtraction'
import {
  openExtractTypeDialogEvent,
  type OpenExtractTypeDialogEventDetail,
} from './events'

type DialogStep = 'configure' | 'confirm'

interface PropertyChoice {
  /** Property name as it appears on the prototype's properties_json. */
  name: string
  /** Whether this property goes into the new type's properties refList
   *  AND into the find-candidates shape filter. */
  picked: boolean
  /** When true, the find-candidates query filters by exact value match
   *  rather than just "property is set." */
  matchValue: boolean
  /** Raw value off the prototype, used for both display and the
   *  optional value filter. */
  value: unknown
  /** Resolved property-schema block id for this name. Used to populate
   *  `block-type:properties` (refList over property-schema blocks).
   *  When the property has no user-defined schema (kernel/plugin
   *  schema, or unresolved), the row is disabled — it can't be
   *  promoted into the new type's refList because there's no block
   *  to point at. (Temporary; the eventual block-id keying for
   *  properties_json + kernel-schemas-as-blocks resolves this.) */
  schemaBlockId: string | undefined
}

/** Property names that are never relevant to extract from a prototype
 *  — they're either system bookkeeping (`system:*`), the type list
 *  itself (typesProp — the user is creating a type, not propagating
 *  an existing one), aliases (page identity, not a property shape),
 *  or renderer overrides (block-level UI state, not part of the
 *  type). The same pattern lives in roam-import's typeCandidates.ts
 *  for the same reason. */
const isExcludedFromExtract = (name: string): boolean =>
  name.startsWith('system:') ||
  name === typesProp.name ||
  name === aliasesProp.name ||
  name === rendererProp.name ||
  name === rendererNameProp.name

const formatPropertyValue = (value: unknown): string => {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

const formatCandidateLabel = (data: BlockData): string => {
  const content = data.content?.trim() ?? ''
  if (content.length > 0) return content
  return `(empty block ${data.id.slice(0, 8)})`
}

export function ExtractTypeDialog() {
  const repo = useRepo()
  const [open, setOpen] = useState(false)
  const [prototypeId, setPrototypeId] = useState<string | null>(null)
  const [prototype, setPrototype] = useState<BlockData | null>(null)
  const [step, setStep] = useState<DialogStep>('configure')
  const [typeName, setTypeName] = useState('')
  const [choices, setChoices] = useState<readonly PropertyChoice[]>([])
  const [candidates, setCandidates] = useState<readonly BlockData[]>([])
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // ──── Open / close on event ───────────────────────────────────────

  useEffect(() => {
    const handleOpen = async (event: Event) => {
      const detail = (event as CustomEvent<OpenExtractTypeDialogEventDetail>).detail
      const data = await repo.load(detail.prototypeBlockId)
      if (!data) {
        setError(`Block ${detail.prototypeBlockId} not found`)
        return
      }
      const props = Object.entries(data.properties)
        .filter(([name, value]) => !isExcludedFromExtract(name) && value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
      const initialChoices: PropertyChoice[] = props.map(([name, value]) => ({
        name,
        picked: true,
        matchValue: false,
        value,
        schemaBlockId: repo.userSchemas.getSchemaBlockId(name),
      }))
      setPrototypeId(detail.prototypeBlockId)
      setPrototype(data)
      setTypeName('')
      setChoices(initialChoices)
      setCandidates([])
      setConfirmed(new Set())
      setError(null)
      setBusy(false)
      setStep('configure')
      setOpen(true)
    }
    window.addEventListener(openExtractTypeDialogEvent, handleOpen)
    return () => window.removeEventListener(openExtractTypeDialogEvent, handleOpen)
  }, [repo])

  const close = () => {
    setOpen(false)
    setPrototypeId(null)
    setPrototype(null)
    setChoices([])
    setCandidates([])
    setConfirmed(new Set())
    setError(null)
    setBusy(false)
    setStep('configure')
    setTypeName('')
  }

  // ──── Derived ─────────────────────────────────────────────────────

  const pickedChoices = useMemo(
    () => choices.filter(c => c.picked),
    [choices],
  )
  const pickedSchemaBlockIds = useMemo(
    () => pickedChoices.filter(c => c.schemaBlockId !== undefined).map(c => c.schemaBlockId!),
    [pickedChoices],
  )
  const droppedFromTypeCount = pickedChoices.length - pickedSchemaBlockIds.length

  const canFindCandidates =
    typeName.trim() !== '' &&
    pickedChoices.length > 0 &&
    !busy

  const canRetag = candidates.length > 0 && confirmed.size > 0 && !busy

  // ──── Step 1 → Step 2 ─────────────────────────────────────────────

  const handleFindCandidates = async () => {
    if (!prototype || !prototypeId) return
    setError(null)
    setBusy(true)
    try {
      const shape = pickedChoices.map(c => ({
        name: c.name,
        ...(c.matchValue ? {value: c.value} : {}),
      }))
      const ids = await findCandidatesByPropertyShape(repo, {
        workspaceId: prototype.workspaceId,
        shape,
        exclude: [prototypeId],
      })
      const rows = await Promise.all(ids.map(id => repo.load(id)))
      const live = rows.filter((r): r is BlockData => r !== null)
      setCandidates(live)
      setConfirmed(new Set(live.map(r => r.id)))
      setStep('confirm')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to find candidates')
    } finally {
      setBusy(false)
    }
  }

  // ──── Step 2 → submit ─────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!prototype) return
    setError(null)
    setBusy(true)
    try {
      const typeId = await createTypeBlock(repo, {
        workspaceId: prototype.workspaceId,
        label: typeName.trim(),
        propertySchemaIds: pickedSchemaBlockIds,
      })
      const instanceIds = candidates
        .map(c => c.id)
        .filter(id => confirmed.has(id))
      if (instanceIds.length > 0) {
        await retagBlocks(repo, {typeId, instanceIds})
      }
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create type')
      setBusy(false)
    }
  }

  // ──── Rendering ───────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Extract type from this block</DialogTitle>
          <DialogDescription>
            {step === 'configure'
              ? 'Name the type and pick which of this block’s properties belong on it. Blocks that share the picked shape become retag candidates in the next step.'
              : 'Review the blocks that match the picked shape. Uncheck any you don’t want retagged.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'configure' && prototype && (
          <div className="space-y-4">
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
                <ul className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
                  {choices.map((choice, idx) => {
                    const disabled = choice.schemaBlockId === undefined
                    return (
                      <li
                        key={choice.name}
                        className="flex items-center gap-3 rounded px-2 py-1 hover:bg-muted/60"
                      >
                        <Checkbox
                          id={`extract-pick-${idx}`}
                          checked={choice.picked}
                          onCheckedChange={next => {
                            setChoices(prev => prev.map((c, i) =>
                              i === idx ? {...c, picked: next === true} : c,
                            ))
                          }}
                          disabled={busy}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <Label
                              htmlFor={`extract-pick-${idx}`}
                              className="cursor-pointer truncate font-mono text-sm"
                            >
                              {choice.name}
                            </Label>
                            {disabled && (
                              <span
                                className="text-xs text-muted-foreground"
                                title="No user-defined property-schema for this name. Kernel and plugin properties can't be added to a user type yet."
                              >
                                (no user schema)
                              </span>
                            )}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {formatPropertyValue(choice.value)}
                          </div>
                        </div>
                        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <Checkbox
                            checked={choice.matchValue}
                            onCheckedChange={next => {
                              setChoices(prev => prev.map((c, i) =>
                                i === idx ? {...c, matchValue: next === true} : c,
                              ))
                            }}
                            disabled={busy || !choice.picked}
                          />
                          match value
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
              {droppedFromTypeCount > 0 && (
                <p className="text-xs text-muted-foreground">
                  {droppedFromTypeCount} picked propert{droppedFromTypeCount === 1 ? 'y has' : 'ies have'} no user-defined schema and will be used for candidate matching only, not added to the new type definition.
                </p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
              <Button onClick={handleFindCandidates} disabled={!canFindCandidates}>
                {busy ? 'Searching…' : 'Find candidates'}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <p className="text-sm">
              {candidates.length === 0
                ? 'No other blocks match this shape. The new type will be created with the prototype as its only instance, if you proceed.'
                : `${candidates.length} block${candidates.length === 1 ? '' : 's'} match this shape. The prototype is excluded.`}
            </p>
            {candidates.length > 0 && (
              <ul className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
                {candidates.map(candidate => (
                  <li key={candidate.id} className="flex items-center gap-3 rounded px-2 py-1 hover:bg-muted/60">
                    <Checkbox
                      id={`extract-confirm-${candidate.id}`}
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
                      htmlFor={`extract-confirm-${candidate.id}`}
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
                  ? 'Creating…'
                  : candidates.length === 0
                    ? 'Create type'
                    : `Create type & retag ${confirmed.size} block${confirmed.size === 1 ? '' : 's'}`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
