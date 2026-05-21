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

import type { Repo } from '@/data/repo'
import {
  aliasesProp,
  rendererNameProp,
  rendererProp,
  typesProp,
} from '@/data/properties'
import type { BlockData } from '@/data/api'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

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
  }))
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
}

export function PropertyShapePicker({
  choices,
  onChange,
  disabled = false,
  idPrefix = 'shape-pick',
  showNoSchemaNote = false,
}: PropertyShapePickerProps) {
  if (choices.length === 0) return null
  return (
    <ul className="max-h-72 space-y-1 overflow-auto rounded-md border p-2">
      {choices.map((choice, idx) => {
        const hasNoSchema = choice.schemaBlockId === undefined
        return (
          <li
            key={choice.name}
            className="flex items-center gap-3 rounded px-2 py-1 hover:bg-muted/60"
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
              <div className="truncate text-xs text-muted-foreground">
                {formatPropertyValue(choice.value)}
              </div>
            </div>
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
