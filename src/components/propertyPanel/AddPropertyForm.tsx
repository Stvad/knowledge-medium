/** AddPropertyForm — the panel's "add a field" entry point. After
 *  Phase 3 lands, the form picks a ValuePreset (default: 'ref')
 *  rather than a primitive shape, autocompletes the name input from
 *  the registered schemas, and on submit either adopts an existing
 *  schema or asks UserSchemasService.addSchema to create a new one
 *  before the property's initial value is written. */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  consumePendingPropertyCreateRequest,
  focusPropertyRowByNameWhenReady,
  subscribePropertyCreateRequests,
} from '@/utils/propertyNavigation.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { propertyEditorOverridesFacet, valuePresetsFacet } from '@/data/facets.ts'
import { usePropertySchemas } from '@/hooks/propertySchemas.ts'
import type { AnyPropertySchema, AnyValuePreset } from '@/data/api'
import { FloatingListbox } from '@/components/ui/floating-listbox.tsx'
import { PropertyShapeGlyph, PropertyShapeButton } from './shapeUi'
import { propertyShapeLabel } from './shapes'
import { PROPERTY_ROW_GRID_STYLE } from './layout'
import { FieldConfigSheet } from './FieldConfigSheet'

const DEFAULT_PRESET_ID = 'ref'
const FALLBACK_PRESET_ID = 'string'
const MAX_SUGGESTIONS = 8

export interface AddPropertyArgs {
  /** Existing registered schema the user picked from autocomplete (if any). */
  adopted?: AnyPropertySchema
  /** Otherwise: new schema name + chosen preset id + caller-supplied
   *  config that should round through `preset.configCodec`. */
  name: string
  presetId: string
  config?: unknown
}

interface NameSuggestion {
  schema: AnyPropertySchema
  preset?: AnyValuePreset
}

const filterSuggestions = (
  query: string,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, import('@/data/api').AnyPropertyEditorOverride>,
  presets: ReadonlyMap<string, AnyValuePreset>,
): readonly NameSuggestion[] => {
  const q = query.trim().toLowerCase()
  const out: NameSuggestion[] = []
  for (const schema of schemas.values()) {
    const ui = uis.get(schema.name)
    if (ui?.hidden) continue
    if (q !== '' && !schema.name.toLowerCase().includes(q)) continue
    out.push({schema, preset: presets.get(schema.codec.type)})
    if (out.length >= MAX_SUGGESTIONS) break
  }
  return out.sort((a, b) => a.schema.name.localeCompare(b.schema.name))
}

export function AddPropertyForm({
  blockId,
  onAdd,
}: {
  blockId: string
  onAdd: (args: AddPropertyArgs) => void | Promise<void>
}) {
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

  const initialConfigForPreset = useCallback((id: string): unknown => {
    const p = presets.get(id)
    if (!p) return undefined
    return p.configCodec ? p.defaultConfig ?? {} : undefined
  }, [presets])

  const [initialRequest] = useState(() => consumePendingPropertyCreateRequest(blockId))
  const [isOpen, setIsOpen] = useState(Boolean(initialRequest))
  const [propertyName, setPropertyName] = useState(initialRequest?.initialName ?? '')
  const [presetId, setPresetIdState] = useState<string>(initialPresetId)
  const [config, setConfig] = useState<unknown>(() => initialConfigForPreset(initialPresetId))
  const [configOpen, setConfigOpen] = useState(false)
  const [suggestionsOpen, setSuggestionsOpen] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  // useState for the input element so FloatingListbox's anchor stays
  // stable across renders and the ref-during-render lint stays quiet.
  const [nameInputEl, setNameInputEl] = useState<HTMLInputElement | null>(null)
  const listboxId = useId()

  const preset = presets.get(presetId)

  /** Set the preset and re-initialize config in one render tick. */
  const setPresetId = useCallback((next: string) => {
    setPresetIdState(next)
    setConfig(initialConfigForPreset(next))
  }, [initialConfigForPreset])

  const focusNameInput = useCallback(() => {
    const focus = () => {
      nameInputRef.current?.focus()
      nameInputRef.current?.setSelectionRange(0, nameInputRef.current.value.length)
    }
    if (typeof requestAnimationFrame === 'undefined') focus()
    else requestAnimationFrame(focus)
  }, [])

  const openForm = useCallback((initialName = '') => {
    setPropertyName(initialName)
    setPresetId(initialPresetId)
    setConfigOpen(false)
    setSuggestionsOpen(false)
    setIsOpen(true)
    focusNameInput()
  }, [focusNameInput, initialPresetId])

  useEffect(() => {
    return subscribePropertyCreateRequests(blockId, detail => openForm(detail.initialName))
  }, [blockId, openForm])

  useEffect(() => {
    if (isOpen) focusNameInput()
  }, [focusNameInput, isOpen])

  const suggestions = useMemo(
    () => filterSuggestions(propertyName, schemas, uis, presets),
    [propertyName, schemas, uis, presets],
  )

  const submit = useCallback(async (adopted?: AnyPropertySchema) => {
    const name = (adopted?.name ?? propertyName).trim()
    if (!name || submitting) return
    setSubmitting(true)
    try {
      await onAdd(adopted
        ? {adopted, name, presetId: adopted.codec.type, config: undefined}
        : {name, presetId, config},
      )
      setPropertyName('')
      setPresetId(initialPresetId)
      setConfig(undefined)
      setConfigOpen(false)
      setSuggestionsOpen(false)
      setIsOpen(false)
      focusPropertyRowByNameWhenReady(blockId, name)
    } finally {
      setSubmitting(false)
    }
  }, [blockId, config, initialPresetId, onAdd, presetId, propertyName, submitting])

  if (!isOpen) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-fit gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
        title="Add field"
        onClick={() => openForm()}
      >
        <Plus className="h-3.5 w-3.5" />
        Field
      </Button>
    )
  }

  const showSuggestions = suggestionsOpen && suggestions.length > 0
  const presetOptionIds = presetEntries.map(p => p.id)

  return (
    <div
      className="grid items-center gap-2 border-b border-border/40 py-0.5 text-sm"
      style={PROPERTY_ROW_GRID_STYLE}
    >
      <PropertyShapeButton
        shape={presetId}
        Glyph={preset?.Glyph}
        schemaUnknown
        label="New field"
        onClick={() => setConfigOpen(true)}
      />
      <div className="relative min-w-0">
        <Input
          ref={(el) => {
            nameInputRef.current = el
            setNameInputEl(el)
          }}
          placeholder="Field"
          value={propertyName}
          onChange={(event) => {
            setPropertyName(event.target.value)
            setSuggestionsOpen(true)
            setActiveSuggestion(0)
          }}
          onFocus={() => setSuggestionsOpen(true)}
          onBlur={() => {
            // Defer the close so a click on the listbox can fire first.
            setTimeout(() => setSuggestionsOpen(false), 100)
          }}
          aria-controls={showSuggestions ? listboxId : undefined}
          aria-activedescendant={
            showSuggestions ? `${listboxId}-${activeSuggestion}` : undefined
          }
          className="h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:ring-0"
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
              setConfigOpen(false)
              setIsOpen(false)
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
      <PropertyEmptyValue presetId={presetId} />
      <div />
      <FieldConfigSheet
        field={configOpen ? {
          labelText: propertyName.trim() || 'New field',
          shape: presetId,
          Glyph: preset?.Glyph,
          shapeOptions: presetOptionIds,
          schemaUnknown: true,
          decodeFailed: false,
          readOnly: false,
          preset,
          configValue: config,
          onConfigChange: (next) => setConfig(next),
        } : null}
        onShapeChange={(next) => setPresetId(next)}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  )
}

function PropertyEmptyValue({presetId}: {presetId: string}) {
  return (
    <div className="min-w-0">
      <div className="h-7 truncate py-1 text-sm text-muted-foreground/55">
        {presetId === 'list' ? 'Select option' : 'Empty'}
      </div>
    </div>
  )
}
