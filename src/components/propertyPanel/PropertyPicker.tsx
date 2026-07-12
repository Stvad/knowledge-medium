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
import { propertyEditorOverridesFacet } from '@/data/facets.js'
import {readValuePresets} from '@/data/valuePresetRegistry'
import { selectablePresets } from '@/components/propertyEditors/selectablePresets.js'
import { usePropertySchemas } from '@/hooks/propertySchemas.js'
import type {
  AnyPropertyEditorOverride,
  AnyPropertySchema,
  AnyJoinedValuePreset,
} from '@/data/api'
import { FloatingListbox } from '@/components/ui/floating-listbox.js'
import { useAutocompleteListbox } from '@/hooks/useAutocompleteListbox.js'
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
  preset?: AnyJoinedValuePreset
}

const filterSuggestions = (
  query: string,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>,
  presets: ReadonlyMap<string, AnyJoinedValuePreset>,
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
  /** Block the picker is adding a property to. Required so the name
   *  input can activate `PROPERTY_EDITING` on focus, shadowing
   *  block-scoped bindings while the user types. */
  block: Block
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
  const presets = readValuePresets(runtime)
  const uis = runtime.read(propertyEditorOverridesFacet)
  const schemas = usePropertySchemas()

  const presetEntries = useMemo(() => selectablePresets(presets), [presets])
  const initialPresetId = useMemo(() => {
    if (presets.has(DEFAULT_PRESET_ID)) return DEFAULT_PRESET_ID
    if (presets.has(FALLBACK_PRESET_ID)) return FALLBACK_PRESET_ID
    return presetEntries[0]?.id ?? FALLBACK_PRESET_ID
  }, [presetEntries, presets])

  const [propertyName, setPropertyName] = useState(initialName)
  const [presetId, setPresetId] = useState<string>(initialPresetId)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const [nameInputEl, setNameInputEl] = useState<HTMLInputElement | null>(null)
  const listboxId = useId()
  // reset() (declared above the listbox hook) clears the highlighted suggestion
  // through this ref, kept pointed at the hook's stable setter below.
  const resetActiveIndexRef = useRef<() => void>(() => {})

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
    // Clear the highlighted suggestion too. This picker stays mounted after
    // submit() (e.g. in BlockTypeBlockRenderer), so a leftover activeIndex
    // would make the next property's Enter/arrow start from a stale row.
    // Routed through a ref because the listbox setter is declared below.
    resetActiveIndexRef.current()
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

  const { activeIndex, setActiveIndex, activeDescendantId, onKeyDown, getOptionProps } =
    useAutocompleteListbox({
      itemCount: suggestions.length,
      setOpen: setSuggestionsOpen,
      commitOnTab: true,
      listboxId,
      onCommit: index => {
        // With no visible suggestions, Enter/Tab materializes the typed
        // name as a new field (submit(undefined)); otherwise it adopts the
        // chosen suggestion.
        const picked = showSuggestions ? suggestions[index] : undefined
        void submit(picked?.schema)
        return true
      },
    })

  useEffect(() => {
    resetActiveIndexRef.current = () => setActiveIndex(0)
  })

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
            setActiveIndex(0)
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
          aria-activedescendant={showSuggestions ? activeDescendantId : undefined}
          className={inputClassName ?? 'h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:ring-0'}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              if (suggestionsOpen) { setSuggestionsOpen(false); return }
              onEscape?.()
              return
            }
            onKeyDown(event)
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
              {...getOptionProps(i)}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted ${
                i === activeIndex ? 'bg-muted' : ''
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
