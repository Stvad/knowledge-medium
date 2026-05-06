/**
 * Property editor resolution helpers.
 *
 * The lookup chain is:
 *   1. Resolve the schema by name.
 *   2. Resolve an exact `PropertyUiContribution.Editor`.
 *   3. Resolve a fallback editor contribution by matching the schema/codec.
 *   4. Use that fallback editor for primitive codec shapes too.
 *
 * Unknown properties synthesize an ad-hoc schema from the encoded JSON shape
 * and run through the same fallback editor chain.
 */

import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
  ChangeScope,
  codecs,
  type AnyPropertyEditorFallbackContribution,
  type AnyPropertySchema,
  type AnyPropertyUiContribution,
  type CodecShape,
  type PropertyEditorProps,
  type PropertySchema,
} from '@/data/api'
import { Block } from '@/data/block'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'

const INLINE_INPUT_CLASS =
  'h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/55 focus-visible:border-transparent focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-60'

const readOnlyForBlock = (block: unknown): boolean =>
  block instanceof Block && block.repo.isReadOnly

// ──── Primitive fallback editors ────

export function StringPropertyEditor({value, onChange, block}: PropertyEditorProps<unknown>) {
  const readOnly = readOnlyForBlock(block)
  return (
    <Input
      className={INLINE_INPUT_CLASS}
      value={value === undefined || value === null ? '' : String(value)}
      placeholder="Empty"
      readOnly={readOnly}
      onChange={(event) => {
        if (!readOnly) onChange(event.target.value)
      }}
    />
  )
}

export function NumberPropertyEditor({value, onChange, block}: PropertyEditorProps<unknown>) {
  const readOnly = readOnlyForBlock(block)
  return (
    <Input
      type="number"
      className={INLINE_INPUT_CLASS}
      value={value === undefined || value === null ? '' : String(value)}
      placeholder="Empty"
      readOnly={readOnly}
      onChange={(event) => {
        if (readOnly) return
        const n = parseFloat(event.target.value)
        onChange(Number.isNaN(n) ? undefined : n)
      }}
    />
  )
}

export function BooleanPropertyEditor({
  value,
  onChange,
  block,
  schema,
}: PropertyEditorProps<boolean>) {
  const readOnly = readOnlyForBlock(block)
  return (
    <div className="flex h-7 items-center">
      <Checkbox
        aria-label={schema?.name ? `Toggle ${schema.name}` : 'Toggle boolean value'}
        checked={value === true}
        disabled={readOnly}
        onCheckedChange={(checked) => {
          if (!readOnly) onChange(checked === true)
        }}
      />
    </div>
  )
}

export function ListPropertyEditor({value, onChange, block}: PropertyEditorProps<unknown>) {
  const readOnly = readOnlyForBlock(block)
  const [newItem, setNewItem] = useState('')
  const items = Array.isArray(value)
    ? value.map(v => typeof v === 'string' ? v : String(v))
    : []

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
            className="h-7 text-xs md:text-sm"
            placeholder="Enter value..."
            disabled={readOnly}
          />
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => removeItem(index)}
              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            >
              <X className="h-3.5 w-3.5" />
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
            className="h-7 text-xs md:text-sm"
            placeholder="Add new item..."
          />
          <Button variant="ghost" size="sm" onClick={addItem} className="h-7 w-7 p-0">
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

export function ObjectPropertyEditor({value, onChange, block}: PropertyEditorProps<unknown>) {
  const readOnly = readOnlyForBlock(block)
  return (
    <Input
      className={`${INLINE_INPUT_CLASS} font-mono`}
      value={JSON.stringify(value ?? {})}
      placeholder="Empty"
      readOnly={readOnly}
      onChange={(event) => {
        if (readOnly) return
        try {
          onChange(JSON.parse(event.target.value))
        } catch {
          // Keep the editor forgiving while the user is typing malformed JSON.
        }
      }}
    />
  )
}

export function DatePropertyEditor({value, onChange, block}: PropertyEditorProps<unknown>) {
  const readOnly = readOnlyForBlock(block)
  const isoString = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : (typeof value === 'string' && value ? value.slice(0, 10) : '')
  return (
    <Input
      type="date"
      className={INLINE_INPUT_CLASS}
      value={isoString}
      placeholder="Empty"
      readOnly={readOnly}
      onChange={(event) => {
        if (readOnly) return
        const text = event.target.value
        onChange(text ? new Date(text) : undefined)
      }}
    />
  )
}

// ──── Lookup-chain helper ────

/** Default value used when the property panel adds a new property of a
 *  given shape. Mirrors the shape `defaultValue` would carry on a real
 *  schema — strings are empty, numbers zero, etc. */
export const defaultValueForShape = (shape: CodecShape): unknown => {
  switch (shape) {
    case 'string':  return ''
    case 'number':  return 0
    case 'boolean': return false
    case 'list':    return [] as unknown[]
    case 'object':  return {}
    case 'date':    return undefined
  }
}

/** Lossy shape inference used when no schema is registered for a
 *  property name (spec §5.6.1 fallback). The §5.6.1 unknown-schema
 *  fallback inspects the encoded JSON shape and picks a shape so the
 *  panel can still render an editor. */
export const inferShapeFromValue = (value: unknown): CodecShape => {
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
export const adhocSchema = (name: string, shape: CodecShape): PropertySchema<unknown> => ({
  name,
  codec: shape === 'list'
    ? codecs.list(codecs.unsafeIdentity<unknown>()) as PropertySchema<unknown>['codec']
    : codecs.unsafeIdentity<unknown>(shape),
  defaultValue: defaultValueForShape(shape),
  changeScope: ChangeScope.BlockDefault,
})

/** Result of resolving a property's display: which schema (registered
 *  or ad-hoc), which primitive shape, and which UI Editor to render with. The
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
  shape: CodecShape
  /** Editor selected by the resolver. Usually this is a registered
   *  `PropertyUiContribution.Editor`; schema/codec fallback editor
   *  contributions are considered second. Undefined means no fallback
   *  contribution was registered for the schema. */
  Editor?: AnyPropertyEditorFallbackContribution['Editor']
  /** True iff a real `PropertySchema` was found in the registry; false
   *  when we synthesised an ad-hoc schema from `inferShapeFromValue`. */
  isKnown: boolean
}

const fallbackEditorForSchema = (
  schema: AnyPropertySchema,
  fallbacks: readonly AnyPropertyEditorFallbackContribution[],
): AnyPropertyEditorFallbackContribution['Editor'] | undefined =>
  fallbacks.find(fallback => fallback.matches(schema))?.Editor

/** Implements the §5.6.1 lookup chain:
 *
 *    1. Look up the schema in `propertySchemasFacet`'s registry by `name`.
 *    2. Look up the matching UI contribution in `propertyUiFacet`.
 *    3. If schema is known → use the contributed `Editor` if any, else
 *       any matching fallback editor contribution.
 *    4. If schema is unknown → infer a shape from the JSON value, build
 *       an ad-hoc schema, and run the same fallback editor chain.
 *
 *  Returns enough information for the caller to render and to wire
 *  `block.set` via `schema` (codec encodes to storage). */
export const resolvePropertyDisplay = (args: {
  name: string
  encodedValue: unknown
  schemas: ReadonlyMap<string, AnyPropertySchema>
  uis: ReadonlyMap<string, AnyPropertyUiContribution>
  editorFallbacks: readonly AnyPropertyEditorFallbackContribution[]
}): PropertyDisplayInfo => {
  const known = args.schemas.get(args.name)
  if (known) {
    const ui = args.uis.get(args.name)
    return {
      schema: known,
      shape: known.codec.shape,
      Editor: ui?.Editor ?? fallbackEditorForSchema(known, args.editorFallbacks),
      isKnown: true,
    }
  }
  const shape = inferShapeFromValue(args.encodedValue)
  const schema = adhocSchema(args.name, shape)
  return {
    schema,
    shape,
    Editor: fallbackEditorForSchema(schema, args.editorFallbacks),
    isKnown: false,
  }
}
