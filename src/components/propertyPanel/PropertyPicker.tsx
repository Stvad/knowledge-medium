/** PropertyPicker — name-autocomplete + glyph-create entry for picking
 *  or materializing a property schema. Shared between AddPropertyForm
 *  (the block's "+ Field" surface) and BlockTypeBlockRenderer's
 *  Properties section. Doesn't know what the caller does with the
 *  picked schema; just exposes onAdd (existing schema OR plain
 *  {name, presetId}) and onConfigureNewSchema (glyph-click — materialize
 *  + open in side panel for further config).
 *
 *  Layout-free by design: callers wrap it in their own grid/list/etc. */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Input } from '@/components/ui/input'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { propertyEditorOverridesFacet, valuePresetsFacet } from '@/data/facets.js'
import { usePropertySchemas } from '@/hooks/propertySchemas.js'
import type {
  AnyPropertyEditorOverride,
  AnyPropertySchema,
  AnyValuePreset,
} from '@/data/api'
import { FloatingListbox } from '@/components/ui/floating-listbox.js'
import { PropertyShapeGlyph, PropertyShapeButton } from './shapeUi'
import { propertyShapeLabel } from './shapes'
import { usePropertyEditingActivation } from './usePropertyEditingActivation'
import type { Block } from '@/data/block'

export const DEFAULT_PRESET_ID = 'ref'
export const FALLBACK_PRESET_ID = 'string'
const MAX_SUGGESTIONS = 8

export interface AddPropertyArgs {
  /** Existing registered schema the user picked from autocomplete (if any). */
  adopted?: AnyPropertySchema
  /** Property name. If `adopted` is set, this equals `adopted.name`. */
  name: string
  /** Preset id. If `adopted` is set, this equals `adopted.codec.type`. */
  presetId: string
}

export interface ConfigureNewSchemaArgs {
  name: string
  presetId: string
}

interface NameSuggestion {
  schema: AnyPropertySchema
  preset?: AnyValuePreset
}

const filterSuggestions = (
  query: string,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>,
  presets: ReadonlyMap<string, AnyValuePreset>,
  excludedNames: ReadonlySet<string>,
  filterSchema: ((schema: AnyPropertySchema) => boolean) | undefined,
): readonly NameSuggestion[] => {
  const q = query.trim().toLowerCase()
  const out: NameSuggestion[] = []
  for (const schema of schemas.values()) {
    if (excludedNames.has(schema.name)) continue
    const ui = uis.get(schema.name)
    if (ui?.hidden) continue
    if (q !== '' && !schema.name.toLowerCase().includes(q)) continue
    if (filterSchema && !filterSchema(schema)) continue
    out.push({schema, preset: presets.get(schema.codec.type)})
    if (out.length >= MAX_SUGGESTIONS) break
  }
  return out.sort((a, b) => a.schema.name.localeCompare(b.schema.name))
}

export interface PropertyPickerProps {
  /** Picked an existing schema or asked for a new one. */
  onAdd: (args: AddPropertyArgs) => void | Promise<void>
  /** Glyph-click materializes a new schema and opens its block in a
   *  side panel. Returns the registered schema so the picker can adopt
   *  it as a confirmed submit. */
  onConfigureNewSchema: (
    args: ConfigureNewSchemaArgs,
  ) => Promise<AnyPropertySchema | undefined>
  /** Names to hide from suggestions (e.g. already-picked schemas). */
  excludedNames?: ReadonlyArray<string>
  /** Optional predicate to narrow the suggestion list further. Returning
   *  false on a schema hides it from autocomplete. Inline-create still
   *  works for names not in `usePropertySchemas` — the predicate only
   *  gates EXISTING suggestions, not what the user can type. */
  filterSchema?: (schema: AnyPropertySchema) => boolean
  /** Placeholder text shown in the name input. */
  placeholder?: string
  /** Optional className overrides for the input shell. */
  inputClassName?: string
  /** Auto-focus the input on mount. */
  autoFocus?: boolean
  /** Seed value for the name input. The picker remounts on prop change
   *  via the caller's `key` if a fresh seed is needed mid-lifecycle. */
  initialName?: string
  /** Called when the user presses Escape with the suggestions list
   *  already closed. Lets the parent cancel its outer container
   *  (e.g. the "+ Field" toggle in AddPropertyForm). */
  onEscape?: () => void
  /** Block the picker is adding a property to. When provided, the name
   *  input activates `PROPERTY_EDITING` on focus so block-scoped
   *  bindings stop firing while the user types. Optional so callers
   *  without an obvious target block can omit it (activation just no-ops). */
  block?: Block
}

export function PropertyPicker({
  onAdd,
  onConfigureNewSchema,
  excludedNames,
  filterSchema,
  placeholder = 'Field',
  inputClassName,
  autoFocus = false,
  initialName = '',
  onEscape,
  block,
}: PropertyPickerProps) {
  const propertyEditingFocus = usePropertyEditingActivation(block)
  const runtime = useAppRuntime()
  const presets = runtime.read(valuePresetsFacet)
  const uis = runtime.read(propertyEditorOverridesFacet)
  const schemas = usePropertySchemas()

  const presetEntries = useMemo(
    () => Array.from(presets.values()).sort((a, b) => a.label.localeCompare(b.label)),
    [presets],
  )
  const initialPresetId = useMemo(() => {
    if (presets.has(DEFAULT_PRESET_ID)) return DEFAULT_PRESET_ID
    if (presets.has(FALLBACK_PRESET_ID)) return FALLBACK_PRESET_ID
    return presetEntries[0]?.id ?? FALLBACK_PRESET_ID
  }, [presetEntries, presets])

  const [propertyName, setPropertyName] = useState(initialName)
  const [presetId, setPresetId] = useState<string>(initialPresetId)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const [nameInputEl, setNameInputEl] = useState<HTMLInputElement | null>(null)
  const listboxId = useId()

  const excludedNamesSet = useMemo(
    () => new Set(excludedNames ?? []),
    [excludedNames],
  )

  const preset = presets.get(presetId)

  const focusNameInput = useCallback(() => {
    const focus = () => {
      localInputRef.current?.focus()
      localInputRef.current?.setSelectionRange(0, localInputRef.current.value.length)
    }
    if (typeof requestAnimationFrame === 'undefined') focus()
    else requestAnimationFrame(focus)
  }, [])

  useEffect(() => {
    if (autoFocus) focusNameInput()
  }, [autoFocus, focusNameInput])

  const suggestions = useMemo(
    () => filterSuggestions(propertyName, schemas, uis, presets, excludedNamesSet, filterSchema),
    [propertyName, schemas, uis, presets, excludedNamesSet, filterSchema],
  )

  const reset = useCallback(() => {
    setPropertyName('')
    setPresetId(initialPresetId)
    setSuggestionsOpen(false)
    setActiveSuggestion(0)
  }, [initialPresetId])

  const submit = useCallback(async (adopted?: AnyPropertySchema) => {
    const name = (adopted?.name ?? propertyName).trim()
    if (!name || submitting) return
    setSubmitting(true)
    try {
      await onAdd(adopted
        ? {adopted, name, presetId: adopted.codec.type}
        : {name, presetId},
      )
      reset()
    } finally {
      setSubmitting(false)
    }
  }, [onAdd, presetId, propertyName, reset, submitting])

  const handleGlyphClick = useCallback(async () => {
    const name = propertyName.trim()
    if (!name) {
      focusNameInput()
      return
    }
    if (submitting) return
    const schema = await onConfigureNewSchema({name, presetId})
    if (!schema) return
    void submit(schema)
  }, [focusNameInput, onConfigureNewSchema, presetId, propertyName, submit, submitting])

  const showSuggestions = suggestionsOpen && suggestions.length > 0

  return (
    <>
      <PropertyShapeButton
        shape={presetId}
        Glyph={preset?.Glyph}
        schemaUnknown
        label="New field"
        onClick={handleGlyphClick}
      />
      <div className="relative min-w-0">
        <Input
          ref={(el) => {
            localInputRef.current = el
            setNameInputEl(el)
          }}
          placeholder={placeholder}
          value={propertyName}
          onChange={(event) => {
            setPropertyName(event.target.value)
            setSuggestionsOpen(true)
            setActiveSuggestion(0)
          }}
          onFocus={(event) => {
            propertyEditingFocus.onFocus(event)
            setSuggestionsOpen(true)
          }}
          onBlur={() => {
            propertyEditingFocus.onBlur()
            setTimeout(() => setSuggestionsOpen(false), 100)
          }}
          aria-controls={showSuggestions ? listboxId : undefined}
          aria-activedescendant={
            showSuggestions ? `${listboxId}-${activeSuggestion}` : undefined
          }
          className={inputClassName ?? 'h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:ring-0'}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && showSuggestions) {
              event.preventDefault()
              setActiveSuggestion(i => Math.min(suggestions.length - 1, i + 1))
              return
            }
            if (event.key === 'ArrowUp' && showSuggestions) {
              event.preventDefault()
              setActiveSuggestion(i => Math.max(0, i - 1))
              return
            }
            if ((event.key === 'Enter' || event.key === 'Tab')) {
              event.preventDefault()
              const picked = showSuggestions ? suggestions[activeSuggestion] : undefined
              void submit(picked?.schema)
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              if (suggestionsOpen) { setSuggestionsOpen(false); return }
              onEscape?.()
            }
          }}
        />
        <FloatingListbox
          open={showSuggestions}
          anchorElement={nameInputEl}
          id={listboxId}
          role="listbox"
        >
          {suggestions.map((s, i) => (
            <button
              key={s.schema.name}
              type="button"
              role="option"
              id={`${listboxId}-${i}`}
              aria-selected={i === activeSuggestion}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { void submit(s.schema) }}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted ${
                i === activeSuggestion ? 'bg-muted' : ''
              }`}
            >
              <PropertyShapeGlyph
                shape={s.schema.codec.type}
                Glyph={uis.get(s.schema.name)?.Glyph ?? s.preset?.Glyph}
                className="text-muted-foreground"
              />
              <span className="flex-1 truncate">{s.schema.name}</span>
              <span className="text-xs text-muted-foreground">
                {s.preset?.label ?? propertyShapeLabel(s.schema.codec.type)}
              </span>
            </button>
          ))}
        </FloatingListbox>
      </div>
    </>
  )
}
