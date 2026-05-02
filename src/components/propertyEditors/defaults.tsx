/**
 * Kernel default property editors per `PropertyKind` (spec §5.6.1).
 *
 * The §5.6.1 rendering chain says: look up the schema by name; look up
 * the UI contribution; if no per-property `Editor` is contributed, fall
 * back to the default editor for the schema's `kind`. These components
 * are that fallback — they ship from the kernel and are reached by
 * `resolvePropertyDisplay` (this module) and consumed by
 * `BlockProperties.tsx`.
 *
 * Plugins that want a custom shape register a `PropertyUiContribution`
 * keyed on the same `PropertySchema.name`; the contribution's `Editor`
 * overrides the default for that property only.
 */

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
  ChangeScope,
  codecs,
  type AnyPropertySchema,
  type AnyPropertyUiContribution,
  type PropertyEditor,
  type PropertyKind,
  type PropertySchema,
} from '@/data/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

// ──── List editor ────

interface ListEditorProps {
  value: unknown[]
  onChange: (next: unknown[]) => void
  readOnly: boolean
}

export function DefaultListPropertyEditor({value, onChange, readOnly}: ListEditorProps) {
  const [newItem, setNewItem] = useState('')
  const items = value.map(v => typeof v === 'string' ? v : String(v))

  const addItem = () => {
    if (newItem.trim()) {
      onChange([...items, newItem.trim()])
      setNewItem('')
    }
  }
  const removeItem = (index: number) => {
    onChange(items.filter((_, i) => i !== index))
  }
  const updateItem = (index: number, next: string) => {
    onChange(items.map((item, i) => i === index ? next : item))
  }

  return (
    <div className="space-y-2">
      {items.map((item, index) => (
        <div key={index} className="flex gap-2 items-center">
          <Input
            value={item}
            onChange={(e) => updateItem(index, e.target.value)}
            className="text-xs md:text-sm"
            placeholder="Enter value..."
            disabled={readOnly}
          />
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeItem(index)}
              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <div className="flex gap-2 items-center">
          <Input
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addItem()
              }
            }}
            className="text-xs md:text-sm"
            placeholder="Add new item..."
          />
          <Button variant="ghost" size="sm" onClick={addItem} className="h-8 w-8 p-0">
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

// ──── Per-kind value editor ────

interface DefaultValueEditorProps {
  kind: PropertyKind
  value: unknown
  onChange: (next: unknown) => void
  readOnly: boolean
}

/** Single switch on `kind`. The §5.6.1 default UI for every primitive
 *  property; plugin-contributed `PropertyUiContribution.Editor`s
 *  override per-property. */
export function DefaultPropertyValueEditor({kind, value, onChange, readOnly}: DefaultValueEditorProps) {
  if (kind === 'list') {
    return (
      <DefaultListPropertyEditor
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
        readOnly={readOnly}
      />
    )
  }

  if (kind === 'boolean') {
    return (
      <select
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs md:text-sm disabled:cursor-not-allowed disabled:opacity-50"
        value={String(value ?? false)}
        onChange={(e) => onChange(e.target.value === 'true')}
        disabled={readOnly}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }

  if (kind === 'number') {
    return (
      <Input
        type="number"
        className="text-xs md:text-sm"
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => {
          const n = parseFloat(e.target.value)
          onChange(Number.isNaN(n) ? undefined : n)
        }}
        disabled={readOnly}
      />
    )
  }

  if (kind === 'object') {
    return (
      <Input
        className="text-xs md:text-sm font-mono"
        value={JSON.stringify(value ?? {})}
        onChange={(e) => {
          try {
            onChange(JSON.parse(e.target.value))
          } catch {
            // Ignore malformed JSON during typing; the editor restores
            // on next render if the user navigates away.
          }
        }}
        disabled={readOnly}
      />
    )
  }

  if (kind === 'date') {
    const isoString = value instanceof Date
      ? value.toISOString().slice(0, 10)
      : (typeof value === 'string' && value ? value.slice(0, 10) : '')
    return (
      <Input
        type="date"
        className="text-xs md:text-sm"
        value={isoString}
        onChange={(e) => {
          const text = e.target.value
          if (!text) onChange(undefined)
          else onChange(new Date(text))
        }}
        disabled={readOnly}
      />
    )
  }

  // Default: string.
  return (
    <Input
      className="text-xs md:text-sm"
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      disabled={readOnly}
    />
  )
}

// ──── Lookup-chain helper ────

/** Default value used when the property panel adds a new property of a
 *  given kind. Mirrors the shape `defaultValue` would carry on a real
 *  schema — strings are empty, numbers zero, etc. */
export const defaultValueForKind = (kind: PropertyKind): unknown => {
  switch (kind) {
    case 'string':  return ''
    case 'number':  return 0
    case 'boolean': return false
    case 'list':    return [] as unknown[]
    case 'object':  return {}
    case 'date':    return undefined
  }
}

/** Lossy kind inference used when no schema is registered for a
 *  property name (spec §5.6.1 fallback). The §5.6.1 unknown-schema
 *  fallback inspects the encoded JSON shape and picks a kind so the
 *  panel can still render an editor. */
export const inferKindFromValue = (value: unknown): PropertyKind => {
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'object' && value !== null) return 'object'
  return 'string'
}

/** Build an ad-hoc `PropertySchema` for a property whose actual schema
 *  isn't registered. Used by the unknown-schema fallback and by the
 *  add-property form: both need a schema reference to feed `block.set`,
 *  which encodes the value through the codec before storage. */
export const adhocSchema = (name: string, kind: PropertyKind): PropertySchema<unknown> => ({
  name,
  codec: kind === 'list'
    ? codecs.list(codecs.unsafeIdentity<unknown>()) as PropertySchema<unknown>['codec']
    : codecs.unsafeIdentity<unknown>(),
  defaultValue: defaultValueForKind(kind),
  changeScope: ChangeScope.BlockDefault,
  kind,
})

/** Result of resolving a property's display: which schema (registered
 *  or ad-hoc), which kind, and which UI Editor to render with. The
 *  `isKnown` flag drives the "schema not registered" UI hint per
 *  §5.6.1.
 *
 *  Schema/Editor types use the variance-erased `Any*` aliases so
 *  contributions typed as `PropertySchema<Date | undefined>` etc. can
 *  flow through the registry without widening to `<unknown>` (which
 *  would fail under `strictFunctionTypes` for the same reason
 *  `AnyMutator` exists). */
export interface PropertyDisplayInfo {
  schema: AnyPropertySchema
  kind: PropertyKind
  /** Custom Editor from a registered `PropertyUiContribution`, or
   *  `undefined` when only the kernel default applies. Callers should
   *  fall back to `DefaultPropertyValueEditor` when this is undefined.
   *  The element type is the variance-erased editor signature; render
   *  sites pass through the decoded value with confidence. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customEditor?: PropertyEditor<any>
  /** True iff a real `PropertySchema` was found in the registry; false
   *  when we synthesised an ad-hoc schema from `inferKindFromValue`. */
  isKnown: boolean
}

/** Implements the §5.6.1 lookup chain:
 *
 *    1. Look up the schema in `propertySchemasFacet`'s registry by `name`.
 *    2. Look up the matching UI contribution in `propertyUiFacet`.
 *    3. If schema is known → use the contributed `Editor` if any, else
 *       fall back to the default editor for the schema's `kind`.
 *    4. If schema is unknown → infer a kind from the JSON value, build
 *       an ad-hoc schema, render via the default editor for that kind.
 *
 *  Returns enough information for the caller to render and to wire
 *  `block.set` via `schema` (codec encodes to storage). */
export const resolvePropertyDisplay = (args: {
  name: string
  encodedValue: unknown
  schemas: ReadonlyMap<string, AnyPropertySchema>
  uis: ReadonlyMap<string, AnyPropertyUiContribution>
}): PropertyDisplayInfo => {
  const known = args.schemas.get(args.name)
  if (known) {
    const ui = args.uis.get(args.name)
    return {
      schema: known,
      kind: known.kind,
      customEditor: ui?.Editor,
      isKnown: true,
    }
  }
  const kind = inferKindFromValue(args.encodedValue)
  return {
    schema: adhocSchema(args.name, kind),
    kind,
    customEditor: undefined,
    isKnown: false,
  }
}
