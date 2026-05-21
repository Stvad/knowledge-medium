/** PropertyShapePicker — shared subcomponent for the property-subset
 *  picker used by both `ExtractTypeDialog` (step 1 of extract-type)
 *  and `FindSimilarDialog` (step 1 of find-similar).
 *
 *  Renders a checkbox list of the prototype block's properties with a
 *  per-row "match value" toggle. Reading from `propertyShapeChoices`
 *  utility keeps the picker stateless; the parent owns the choices
 *  array and the per-row update callback.
 *
 *  Why a shared component, not a shared function: the dialog flows
 *  diverge after the picker (extract-type asks for a type name and
 *  runs createTypeBlock + retagBlocks; find-similar shows a clickable
 *  result list that navigates on click). The picker is the only
 *  meaningfully-shared UI piece. */

import { useMemo } from 'react'
import type { Repo } from '@/data/repo'
import {
  aliasesProp,
  blockTypePropertiesProp,
  rendererNameProp,
  rendererProp,
  typesProp,
} from '@/data/properties'
import { isRefCodec, isRefListCodec, type BlockData } from '@/data/api'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { useRepo } from '@/context/repo.tsx'
import { useHandle } from '@/hooks/block.ts'
import { labelForBlockData } from '@/utils/linkTargetAutocomplete.ts'

export interface PropertyShapeChoice {
  /** Property name as it appears on the prototype's properties_json. */
  name: string
  /** Whether this property goes into the candidate query AND (for
   *  extract-type) into the new type's properties refList. */
  picked: boolean
  /** When true, the find-candidates query filters by exact value
   *  match rather than just "property is set." */
  matchValue: boolean
  /** Raw value off the prototype, used for both display and the
   *  optional value filter. */
  value: unknown
  /** Resolved property-schema block id for this name (only present
   *  for user-defined schemas). Find-similar ignores this; extract-
   *  type only includes choices with a resolved id in the new type's
   *  properties refList. */
  schemaBlockId: string | undefined
  /** Codec kind for this property's schema, used by the value preview
   *  to decide whether to render block labels (ref/refList) or fall
   *  back to JSON-stringified text. `undefined` for properties with no
   *  resolved schema or scalar codecs. */
  refKind: 'ref' | 'refList' | undefined
}

const refKindFor = (repo: Repo, name: string): 'ref' | 'refList' | undefined => {
  const schema = repo.propertySchemas.get(name)
  if (!schema) return undefined
  if (isRefListCodec(schema.codec)) return 'refList'
  if (isRefCodec(schema.codec)) return 'ref'
  return undefined
}

/** Properties that never make sense to extract from a prototype.
 *  System bookkeeping, the types list itself, aliases (page identity),
 *  and renderer overrides (UI state). Same exclusion list as
 *  `roam-import/typeCandidates.ts` uses for the same reason. */
const isExcludedFromExtract = (name: string): boolean =>
  name.startsWith('system:') ||
  name === typesProp.name ||
  name === aliasesProp.name ||
  name === rendererProp.name ||
  name === rendererNameProp.name

export const buildPropertyShapeChoices = (
  repo: Repo,
  prototype: BlockData,
): readonly PropertyShapeChoice[] => {
  const entries = Object.entries(prototype.properties)
    .filter(([name, value]) => !isExcludedFromExtract(name) && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return entries.map(([name, value]) => ({
    name,
    picked: true,
    matchValue: false,
    value,
    schemaBlockId: repo.userSchemas.getSchemaBlockId(name),
    refKind: refKindFor(repo, name),
  }))
}

/** Build picker choices from an existing block-type block's properties
 *  refList. Unlike `buildPropertyShapeChoices` which reads a prototype's
 *  properties_json (instance values), this reads the TYPE definition
 *  — each entry corresponds to a property-schema block the type's
 *  refList points at. No per-property `value` field (the type itself
 *  carries no instance values), so callers should pass
 *  `showMatchValue=false` to the picker. */
export const buildTypeShapeChoices = (
  repo: Repo,
  typeBlock: BlockData,
): readonly PropertyShapeChoice[] => {
  const raw = typeBlock.properties[blockTypePropertiesProp.name]
  const schemaIds = raw === undefined
    ? blockTypePropertiesProp.defaultValue
    : blockTypePropertiesProp.codec.decode(raw)
  const out: PropertyShapeChoice[] = []
  for (const schemaId of schemaIds) {
    const schema = repo.userSchemas.getSchemaForBlockId(schemaId)
    if (!schema) continue
    out.push({
      name: schema.name,
      picked: true,
      matchValue: false,
      value: undefined,
      schemaBlockId: schemaId,
      refKind: refKindFor(repo, schema.name),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export const formatPropertyValue = (value: unknown): string => {
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

export interface PropertyShapePickerProps {
  choices: readonly PropertyShapeChoice[]
  onChange: (next: readonly PropertyShapeChoice[]) => void
  disabled?: boolean
  /** Stable prefix so multiple instances of the picker on the same
   *  page (unlikely but cheap to guard) keep their checkbox ids
   *  distinct. */
  idPrefix?: string
  /** Whether to show the "(no user schema)" note inline. Find-similar
   *  doesn't care because it uses the property name directly for the
   *  candidate query; extract-type wants the note to explain why some
   *  properties won't be added to the new type definition. */
  showNoSchemaNote?: boolean
  /** Show the per-row "match value" toggle. Default true. The
   *  find-type-instances flow passes false: the type definition
   *  carries no per-property instance values to match against. */
  showMatchValue?: boolean
  /** Show the value preview row (the muted line under the property
   *  name). Default true. Extract-type Step 1 passes false: type
   *  assembly is pure name selection, not value matching. */
  showValuePreview?: boolean
  /** Replacement string shown in the value preview slot when the
   *  choice has no value (e.g. find-type-instances, where the type
   *  definition has no instance values). Default '' (renders empty). */
  emptyValuePlaceholder?: string
}

/** Reactive label for a single block id. Subscribes to the block via
 *  repo.block + useHandle so the preview updates if the referenced
 *  block's content/aliases change while the dialog is open. Falls back
 *  to a shortened id for blocks that fail to load. */
const RefLabel = ({id}: {id: string}) => {
  const repo = useRepo()
  const handle = useMemo(() => repo.block(id), [repo, id])
  const fallback = `(${id.slice(0, 8)})`
  const label = useHandle(handle, {selector: data => labelForBlockData(data, fallback)})
  return <>{label}</>
}

const ValuePreview = ({
  choice,
  emptyValuePlaceholder,
}: {
  choice: PropertyShapeChoice
  emptyValuePlaceholder: string
}) => {
  if (choice.value === undefined) return <>{emptyValuePlaceholder}</>
  if (choice.refKind === 'refList' && Array.isArray(choice.value)) {
    const ids = choice.value.filter((v): v is string => typeof v === 'string')
    if (ids.length === 0) return <>{emptyValuePlaceholder}</>
    return (
      <>
        {ids.map((id, i) => (
          <span key={id}>
            {i > 0 && ', '}
            <RefLabel id={id} />
          </span>
        ))}
      </>
    )
  }
  if (choice.refKind === 'ref' && typeof choice.value === 'string') {
    return <RefLabel id={choice.value} />
  }
  return <>{formatPropertyValue(choice.value)}</>
}

export function PropertyShapePicker({
  choices,
  onChange,
  disabled = false,
  idPrefix = 'shape-pick',
  showNoSchemaNote = false,
  showMatchValue = true,
  showValuePreview = true,
  emptyValuePlaceholder = '',
}: PropertyShapePickerProps) {
  if (choices.length === 0) return null
  return (
    <ul className="max-h-72 min-w-0 space-y-1 overflow-auto rounded-md border p-2">
      {choices.map((choice, idx) => {
        const hasNoSchema = choice.schemaBlockId === undefined
        return (
          <li
            key={choice.name}
            className="flex min-w-0 items-center gap-3 rounded px-2 py-1 hover:bg-muted/60"
          >
            <Checkbox
              id={`${idPrefix}-${idx}`}
              checked={choice.picked}
              onCheckedChange={next => {
                onChange(choices.map((c, i) =>
                  i === idx ? {...c, picked: next === true} : c,
                ))
              }}
              disabled={disabled}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Label
                  htmlFor={`${idPrefix}-${idx}`}
                  className="cursor-pointer truncate font-mono text-sm"
                >
                  {choice.name}
                </Label>
                {showNoSchemaNote && hasNoSchema && (
                  <span
                    className="text-xs text-muted-foreground"
                    title="No user-defined property-schema for this name. Kernel and plugin properties can't be added to a user type yet."
                  >
                    (no user schema)
                  </span>
                )}
              </div>
              {showValuePreview && (
                <div className="truncate text-xs text-muted-foreground">
                  <ValuePreview choice={choice} emptyValuePlaceholder={emptyValuePlaceholder} />
                </div>
              )}
            </div>
            {showMatchValue && (
              <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={choice.matchValue}
                  onCheckedChange={next => {
                    onChange(choices.map((c, i) =>
                      i === idx ? {...c, matchValue: next === true} : c,
                    ))
                  }}
                  disabled={disabled || !choice.picked}
                />
                match value
              </label>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Convert a choice list into the `shape` arg accepted by
 *  `findCandidatesByPropertyShape`. */
export const choicesToShape = (
  choices: readonly PropertyShapeChoice[],
): readonly { name: string; value?: unknown }[] =>
  choices
    .filter(c => c.picked)
    .map(c => ({name: c.name, ...(c.matchValue ? {value: c.value} : {})}))
