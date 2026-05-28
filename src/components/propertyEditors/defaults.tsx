/**
 * Property editor resolution helpers.
 *
 * The lookup chain is:
 *   1. Resolve the schema by name.
 *   2. Resolve an exact `PropertyEditorOverride.Editor`.
 *   3. Resolve a fallback editor contribution by matching the schema/codec.
 *   4. Use that fallback editor for primitive codec shapes too.
 *
 * Unknown properties synthesize a degraded fallback schema from the encoded JSON shape
 * and run through the same fallback editor chain.
 */

import {
  useCallback,
  useState,
  type ComponentType,
  type FocusEvent,
  type KeyboardEvent,
} from 'react'
import { Plus, X } from 'lucide-react'
import {
  ChangeScope,
  codecs,
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
  type AnyValuePreset,
  type PropertyEditor,
  type PropertyEditorProps,
  type PropertySchema,
} from '@/data/api'
import { Block } from '@/data/block'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input, type InputProps } from '@/components/ui/input'
import { usePropertyEditingActivation } from '@/components/propertyPanel/usePropertyEditingActivation'

const INLINE_INPUT_CLASS =
  'h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/55 focus-visible:border-transparent focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-60'

const readOnlyForBlock = (block: unknown): boolean =>
  block instanceof Block && block.repo.isReadOnly

interface TextDraft {
  draft: string
  dirty: boolean
  setDraft: (next: string) => void
}

interface TextDraftState {
  committedValue: string
  draft: string
  dirty: boolean
}

const useTextDraft = (committedValue: string): TextDraft => {
  const [state, setState] = useState<TextDraftState>({
    committedValue,
    draft: committedValue,
    dirty: false,
  })

  // Guarded derived state: external committed changes replace a clean draft,
  // while dirty text stays local until that exact commit echoes back.
  let current = state
  if (state.committedValue !== committedValue) {
    current = state.dirty && state.draft !== committedValue
      ? {...state, committedValue}
      : {committedValue, draft: committedValue, dirty: false}
    setState(current)
  }

  const setDraft = useCallback((next: string) => {
    setState(prev => ({
      ...prev,
      draft: next,
      dirty: next !== prev.committedValue,
    }))
  }, [])

  return {draft: current.draft, dirty: current.dirty, setDraft}
}

type DraftInputProps = Omit<
  InputProps,
  'defaultValue' | 'onBlur' | 'onChange' | 'onFocus' | 'value'
> & {
  committedValue: string
  block: unknown
  onCommit: (text: string) => void
}

function DraftInput({
  committedValue,
  block,
  disabled,
  onCommit,
  onKeyDown,
  readOnly = false,
  ...props
}: DraftInputProps) {
  const {draft, dirty, setDraft} = useTextDraft(committedValue)
  const focusHandlers = usePropertyEditingActivation(block)
  const locked = readOnly || disabled === true
  const commit = useCallback((text: string) => {
    if (locked) return
    if (!dirty && text === committedValue) return
    onCommit(text)
  }, [committedValue, dirty, locked, onCommit])

  const handleFocus = (event: FocusEvent<HTMLInputElement>) => {
    focusHandlers.onFocus(event)
  }
  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    commit(event.currentTarget.value)
    focusHandlers.onBlur()
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commit(event.currentTarget.value)
    }
    onKeyDown?.(event)
  }

  return (
    <Input
      {...props}
      disabled={disabled}
      readOnly={readOnly}
      value={draft}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onChange={(event) => {
        if (!locked) setDraft(event.target.value)
      }}
      onKeyDown={handleKeyDown}
    />
  )
}

// ──── Primitive fallback editors ────

export function UrlPropertyEditor({value, onChange, block}: PropertyEditorProps<unknown>) {
  const readOnly = readOnlyForBlock(block)
  const text = value === undefined || value === null ? '' : String(value)
  return (
    <DraftInput
      type="url"
      className={INLINE_INPUT_CLASS}
      committedValue={text}
      placeholder="https://…"
      readOnly={readOnly}
      block={block}
      onCommit={onChange}
    />
  )
}

export function StringPropertyEditor({value, onChange, block}: PropertyEditorProps<unknown>) {
  const readOnly = readOnlyForBlock(block)
  const text = value === undefined || value === null ? '' : String(value)
  return (
    <DraftInput
      className={INLINE_INPUT_CLASS}
      committedValue={text}
      placeholder="Empty"
      readOnly={readOnly}
      block={block}
      onCommit={onChange}
    />
  )
}

export function NumberPropertyEditor({value, onChange, block}: PropertyEditorProps<unknown>) {
  const readOnly = readOnlyForBlock(block)
  const text = value === undefined || value === null ? '' : String(value)
  return (
    <DraftInput
      type="number"
      className={INLINE_INPUT_CLASS}
      committedValue={text}
      placeholder="Empty"
      readOnly={readOnly}
      block={block}
      onCommit={(text) => {
        const n = parseFloat(text)
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

function ListItemInput({
  block,
  disabled,
  value,
  onCommit,
}: {
  block: unknown
  disabled: boolean
  value: string
  onCommit: (next: string) => void
}) {
  return (
    <DraftInput
      committedValue={value}
      onCommit={onCommit}
      block={block}
      className="h-7 text-xs md:text-sm"
      placeholder="Enter value..."
      disabled={disabled}
    />
  )
}

export function ListPropertyEditor({value, onChange, block}: PropertyEditorProps<unknown>) {
  const readOnly = readOnlyForBlock(block)
  const newItemFocusHandlers = usePropertyEditingActivation(block)
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
          <ListItemInput
            block={block}
            value={item}
            disabled={readOnly}
            onCommit={(next) => updateItem(index, next)}
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
            onFocus={newItemFocusHandlers.onFocus}
            onBlur={newItemFocusHandlers.onBlur}
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
  const text = JSON.stringify(value ?? {})
  return (
    <DraftInput
      className={`${INLINE_INPUT_CLASS} font-mono`}
      committedValue={text}
      placeholder="Empty"
      readOnly={readOnly}
      block={block}
      onCommit={(text) => {
        try {
          onChange(JSON.parse(text))
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
    <DraftInput
      type="date"
      className={INLINE_INPUT_CLASS}
      committedValue={isoString}
      placeholder="Empty"
      readOnly={readOnly}
      block={block}
      onCommit={(text) => {
        onChange(text ? new Date(text) : undefined)
      }}
    />
  )
}

// ──── Lookup-chain helper ────

/** Default value used when the property panel adds a new property of a
 *  given primitive type. Returns undefined for codec types without a
 *  natural empty value (e.g. unknown plugin types) — the caller picks
 *  a sensible fallback. */
export const defaultValueForShape = (type: string): unknown => {
  switch (type) {
    case 'string':  return ''
    case 'number':  return 0
    case 'boolean': return false
    case 'list':    return [] as unknown[]
    case 'object':  return {}
    case 'date':    return undefined
    case 'url':     return ''
    default:        return ''
  }
}

/** Lossy type inference used when no schema is registered for a
 *  property name. Inspects the encoded JSON value and returns one of
 *  the known JSON-primitive types (`'string' | 'number' | 'boolean' |
 *  'list' | 'object'`) so the panel can still render an editor. */
export const inferTypeFromValue = (value: unknown): string => {
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'object' && value !== null) return 'object'
  return 'string'
}

/** Build a degraded fallback `PropertySchema` for a property whose
 *  actual schema isn't registered. Used at read sites by the unknown-
 *  schema renderer fallback path: when the registry doesn't know the
 *  name, we still need *some* schema reference so the panel can run
 *  encoded JSON through a codec and pick an editor. The resulting
 *  schema is intentionally type-loose (`unsafeIdentity`) and never
 *  persisted — it exists only to keep the read path rendering. */
export const degradedFallbackSchema = (name: string, type: string): PropertySchema<unknown> => ({
  name,
  codec: type === 'list'
    ? codecs.list(codecs.unsafeIdentity<unknown>()) as PropertySchema<unknown>['codec']
    : codecs.unsafeIdentity<unknown>(type),
  defaultValue: defaultValueForShape(type),
  changeScope: ChangeScope.BlockDefault,
})

/** Result of resolving a property's display: which schema (registered
 *  or ad-hoc), which codec type, and which UI Editor to render with.
 *  The `isKnown` flag drives the "schema not registered" UI hint.
 *
 *  Editor lookup goes through the matching ValuePreset by codec type
 *  (per user-defined-properties.md §1-edit), with per-name overrides
 *  winning first. */
export interface PropertyDisplayInfo {
  schema: AnyPropertySchema
  /** Codec type (open string). */
  shape: string
  /** Editor selected by the resolver. Comes from the per-name
   *  `PropertyEditorOverride.Editor` if present, else the matching
   *  `ValuePreset.Editor`. Undefined when no preset is registered for
   *  the codec type — the unknown-schema fallback path renders nothing. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Editor?: PropertyEditor<any>
  /** Glyph for the property's row button / config sheet — picked from
   *  the per-name `PropertyEditorOverride.Glyph` if present, else the
   *  matching `ValuePreset.Glyph`. Undefined falls back to the
   *  type-keyed glyph table in `PropertyShapeGlyph`. */
  Glyph?: ComponentType<{className?: string}>
  /** True iff a real `PropertySchema` was found in the registry; false
   *  when we synthesised a degraded fallback schema from `inferTypeFromValue`. */
  isKnown: boolean
}

/** Resolution chain (per user-defined-properties §1-edit):
 *
 *    1. Look up the schema in `repo.propertySchemas` by `name`.
 *    2. Look up any per-name override in `repo.propertyEditorOverrides`.
 *    3. If schema is known → use the override `Editor` if any, else
 *       the `ValuePreset.Editor` matching `codec.type`.
 *    4. If schema is unknown → infer a primitive type from the JSON
 *       value, build an ad-hoc schema, and use the matching preset's
 *       editor (or fall through to undefined if no preset matches).
 */
export const resolvePropertyDisplay = (args: {
  name: string
  encodedValue: unknown
  schemas: ReadonlyMap<string, AnyPropertySchema>
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>
  presets: ReadonlyMap<string, AnyValuePreset>
}): PropertyDisplayInfo => {
  const known = args.schemas.get(args.name)
  if (known) {
    const ui = args.uis.get(args.name)
    const preset = args.presets.get(known.codec.type)
    return {
      schema: known,
      shape: known.codec.type,
      Editor: ui?.Editor ?? preset?.Editor,
      Glyph: ui?.Glyph ?? preset?.Glyph,
      isKnown: true,
    }
  }
  const shape = inferTypeFromValue(args.encodedValue)
  const schema = degradedFallbackSchema(args.name, shape)
  const preset = args.presets.get(schema.codec.type)
  return {
    schema,
    shape,
    Editor: preset?.Editor,
    Glyph: preset?.Glyph,
    isKnown: false,
  }
}
