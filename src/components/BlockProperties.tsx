/**
 * Property panel — implements the §5.6.1 lookup chain:
 *
 *   1. Look up the schema in the merged property-schema registry.
 *   2. Look up the matching `PropertyUiContribution` in `propertyUiFacet`.
 *   3. If schema is known: decode the encoded value via `schema.codec`,
 *      render via `uiContribution?.Editor` falling back to the kernel
 *      default editor for `schema.kind`.
 *   4. If schema is unknown: infer kind from the JSON value, build an
 *      ad-hoc schema, render via the default editor for that kind. Show
 *      a "schema not registered" hint so users know edits may not
 *      round-trip cleanly through the original plugin's codec.
 *
 *  All editor primitives (per-kind switch, list editor, ad-hoc schema
 *  builder, kind inference) live in `propertyEditors/defaults.tsx`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import { Block } from '../data/block'
import {
  ChangeScope,
  type AnyPropertySchema,
  type AnyPropertyUiContribution,
  type PropertyEditor,
  type PropertyKind,
} from '@/data/api'
import { useChildIds, useHandle } from '@/hooks/block.ts'
import { useUIStateBlock } from '@/data/globalState.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { usePropertySchemas } from '@/hooks/propertySchemas.ts'
import { propertyUiFacet, typesFacet } from '../data/facets.ts'
import {
  aliasesProp,
  createdAtProp,
  editorFocusRequestProp,
  editorSelection,
  extensionDisabledProp,
  focusedBlockIdProp,
  getBlockTypes,
  isCollapsedProp,
  isEditingProp,
  rendererNameProp,
  rendererProp,
  requestEditorFocus,
  selectionStateProp,
  setFocusedBlockId,
  setIsEditing,
  showPropertiesProp,
  sourceBlockIdProp,
  topLevelBlockIdProp,
  typesProp,
} from '@/data/properties.ts'
import { Button } from './ui/button'
import { Input } from './ui/input'
import {
  DefaultPropertyValueEditor,
  adhocSchema,
  defaultValueForKind,
  type PropertyDisplayInfo,
  resolvePropertyDisplay,
} from './propertyEditors/defaults'
import {
  buildPropertyPanelSections,
  type PropertyPanelRow,
  type PropertyPanelSection,
} from './propertyPanelSections'
import { nextVisibleBlock } from '@/utils/selection.ts'
import {
  consumePendingPropertyCreateRequest,
  focusAdjacentPropertyRow,
  focusPropertyRowByNameWhenReady,
  subscribePropertyCreateRequests,
} from '@/utils/propertyNavigation.ts'

interface BlockPropertiesProps {
  block: Block
}

// ──── Add-new-property form ────

/** Kinds the user can pick when adding a brand-new property by hand.
 *  Excludes `date` because the JSON-shape inference can't recover dates
 *  on read (they round-trip as strings); date-typed properties should be
 *  contributed by a plugin with a real `PropertySchema` so the codec
 *  handles encode/decode. Reference-typed fields are likewise schema-only:
 *  a plugin needs to declare target semantics before the backlink projector
 *  treats string values as references. */
type AddableKind = Exclude<PropertyKind, 'date' | 'object' | 'ref' | 'refList'> | 'object'

const ADDABLE_KINDS: ReadonlyArray<AddableKind> = ['string', 'number', 'boolean', 'list', 'object']
const EMPTY_BLOCK_TYPES: readonly string[] = []
const INLINE_HIDDEN_PROPERTY_NAMES = new Set([
  aliasesProp.name,
  createdAtProp.name,
  editorFocusRequestProp.name,
  editorSelection.name,
  extensionDisabledProp.name,
  focusedBlockIdProp.name,
  isCollapsedProp.name,
  isEditingProp.name,
  rendererNameProp.name,
  rendererProp.name,
  selectionStateProp.name,
  showPropertiesProp.name,
  sourceBlockIdProp.name,
  topLevelBlockIdProp.name,
  typesProp.name,
])

const isInlineHiddenProperty = (
  name: string,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
): boolean => {
  const schema = schemas.get(name)
  return INLINE_HIDDEN_PROPERTY_NAMES.has(name) ||
    name.startsWith('system:') ||
    schema?.changeScope === ChangeScope.UiState
}

function AddPropertyForm({
  blockId,
  onAdd,
}: {
  blockId: string
  onAdd: (name: string, kind: AddableKind) => void
}) {
  const [initialRequest] = useState(() => consumePendingPropertyCreateRequest(blockId))
  const [isOpen, setIsOpen] = useState(Boolean(initialRequest))
  const [propertyName, setPropertyName] = useState(initialRequest?.initialName ?? '')
  const [propertyKind, setPropertyKind] = useState<AddableKind>('string')
  const nameInputRef = useRef<HTMLInputElement | null>(null)

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
    setPropertyKind('string')
    setIsOpen(true)
    focusNameInput()
  }, [focusNameInput])

  useEffect(() => {
    return subscribePropertyCreateRequests(blockId, detail => openForm(detail.initialName))
  }, [blockId, openForm])

  useEffect(() => {
    if (isOpen) focusNameInput()
  }, [focusNameInput, isOpen])

  const handleAdd = () => {
    const name = propertyName.trim()
    if (!name) return
    onAdd(name, propertyKind)
    setPropertyName('')
    setPropertyKind('string')
    setIsOpen(false)
    focusPropertyRowByNameWhenReady(blockId, name)
  }

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

  return (
    <div className="grid grid-cols-[1rem,minmax(7rem,13rem),minmax(0,1fr)] items-center gap-1.5 py-0.5 text-xs md:text-sm">
      <span className="select-none text-muted-foreground">&gt;</span>
      <Input
        ref={nameInputRef}
        placeholder="Field"
        value={propertyName}
        onChange={(e) => setPropertyName(e.target.value)}
        className="h-7 text-xs md:text-sm"
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            handleAdd()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            setIsOpen(false)
          }
        }}
      />
      <div className="flex min-w-0 gap-1.5">
        <Input
          value=""
          disabled
          placeholder="Value"
          className="h-7 min-w-0 flex-1 text-xs md:text-sm"
        />
        <select
          className="flex h-7 rounded-md border border-input bg-transparent px-2 py-1 text-xs md:text-sm"
          value={propertyKind}
          onChange={(e) => setPropertyKind(e.target.value as AddableKind)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAdd()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setIsOpen(false)
            }
          }}
        >
          {ADDABLE_KINDS.map(k => (
            <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>
          ))}
        </select>
      </div>
    </div>
  )
}

// ──── Top-level component ────

export function BlockProperties({block}: BlockPropertiesProps) {
  const blockData = useHandle(block, {
    selector: data => data
      ? {
        id: data.id,
        properties: data.properties,
        updatedAt: data.updatedAt,
        updatedBy: data.updatedBy,
      }
      : undefined,
  })
  const childIds = useChildIds(block)
  const uiStateBlock = useUIStateBlock()
  const runtime = useAppRuntime()
  const [showHiddenFields, setShowHiddenFields] = useState(false)
  // Read both registries once per render — combine() is memoised inside
  // FacetRuntime, so re-read is cheap (Map identity-stable across the
  // same runtime).
  const schemas = usePropertySchemas()
  const uis = runtime.read(propertyUiFacet)
  const typesRegistry = runtime.read(typesFacet)

  const properties = useMemo(() => blockData?.properties ?? {}, [blockData?.properties])
  const visibleProperties = useMemo(() => {
    const next: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(properties)) {
      if (!isInlineHiddenProperty(name, schemas)) next[name] = value
    }
    return next
  }, [properties, schemas])
  const hiddenProperties = useMemo(() => {
    const next: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(properties)) {
      if (isInlineHiddenProperty(name, schemas)) next[name] = value
    }
    return next
  }, [properties, schemas])
  const blockTypes = useMemo(() => {
    if (!blockData) return EMPTY_BLOCK_TYPES
    try {
      return getBlockTypes({properties})
    } catch {
      return EMPTY_BLOCK_TYPES
    }
  }, [blockData, properties])
  const propertySections = useMemo(() => buildPropertyPanelSections({
    properties: visibleProperties,
    blockTypes,
    typesRegistry,
    schemas,
  }), [visibleProperties, blockTypes, typesRegistry, schemas])
  const hiddenRows = useMemo<PropertyPanelRow[]>(
    () => Object.keys(hiddenProperties).sort().map(name => ({
      name,
      encodedValue: hiddenProperties[name],
      isSet: true,
    })),
    [hiddenProperties],
  )

  if (!blockData) return null
  const readOnly = block.repo.isReadOnly

  const focusBlockEditor = async (
    target: Block,
    selection: { start?: number; line?: 'first' | 'last'; x?: number },
  ) => {
    await uiStateBlock.set(editorSelection, {
      blockId: target.id,
      ...selection,
    })
    setFocusedBlockId(uiStateBlock, target.id)
    setIsEditing(uiStateBlock, true)
    requestEditorFocus(uiStateBlock)
  }

  const focusThisBlockContentEnd = async () => {
    const data = block.peek() ?? await block.load()
    await focusBlockEditor(block, {start: data?.content.length ?? 0})
  }

  const focusAfterProperties = async () => {
    const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
    if (!topLevelBlockId) return

    const next = await nextVisibleBlock(block, topLevelBlockId)
    if (!next) return
    await next.load()
    await focusBlockEditor(next, {start: 0})
  }

  const handlePropertyRowKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    direction: -1 | 1,
  ) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return

    event.preventDefault()
    event.stopPropagation()

    const row = event.currentTarget
    if (focusAdjacentPropertyRow(block.id, row, direction)) return

    if (direction < 0) {
      void focusThisBlockContentEnd()
    } else {
      void focusAfterProperties()
    }
  }

  /** Encode + persist via the resolved schema. Decoded values come from
   *  the editor; the schema's codec encodes them on write. */
  const writeProperty = (
    schema: AnyPropertySchema,
    decodedValue: unknown,
  ) => {
    void block.set(schema, decodedValue)
  }

  const renameProperty = async (oldName: string, newName: string) => {
    if (!newName || newName === oldName) return
    if (newName === typesProp.name) return
    // Rename = read+delete+write under the new name in one tx so the
    // rename is atomic for sync. Use repo.tx directly since the
    // single-block write sugar can't express two-key updates.
    const value = properties[oldName]
    if (value === undefined) return
    await block.repo.tx(async tx => {
      const next = {...properties}
      delete next[oldName]
      next[newName] = value
      await tx.update(block.id, {properties: next})
    }, {scope: ChangeScope.BlockDefault, description: `rename property ${oldName} → ${newName}`})
  }

  const deleteProperty = async (name: string) => {
    const next = {...properties}
    delete next[name]
    await block.repo.tx(async tx => {
      await tx.update(block.id, {properties: next})
    }, {scope: ChangeScope.BlockDefault, description: `delete property ${name}`})
  }

  const addProperty = (name: string, kind: AddableKind) => {
    if (isInlineHiddenProperty(name, schemas)) return
    const registered = schemas.get(name)
    if (registered) writeProperty(registered, registered.defaultValue)
    else writeProperty(adhocSchema(name, kind), defaultValueForKind(kind))
  }

  const renderPropertyRow = (section: PropertyPanelSection, row: PropertyPanelRow) => {
    const display = row.isSet
      ? resolvePropertyDisplay({name: row.name, encodedValue: row.encodedValue, schemas, uis})
      : resolveKnownPropertyDisplay(row.name, schemas, uis)

    if (!display) return null

    // Decode if a real schema is registered; otherwise the encoded
    // shape IS the editor's value (ad-hoc schema uses unsafeIdentity).
    const value = row.isSet
      ? display.isKnown
        ? safeDecode(display.schema, row.encodedValue)
        : row.encodedValue
      : display.schema.defaultValue
    const decodeFailed = row.isSet && display.isKnown && value === DECODE_FAILED
    const ui = uis.get(row.name)
    const labelText = ui?.label ?? row.name
    const typeMembershipRow = row.name === typesProp.name
    const rowReadOnly = readOnly || typeMembershipRow

    return (
      <PropertyRow
        key={`${section.id}:${row.name}`}
        name={row.name}
        labelText={labelText}
        kindLabel={display.kind}
        schemaUnknown={!display.isKnown}
        decodeFailed={decodeFailed}
        value={decodeFailed ? row.encodedValue : value}
        customEditor={display.customEditor}
        block={block}
        kind={display.kind}
        readOnly={rowReadOnly}
        canDelete={row.isSet && !typeMembershipRow}
        onNavigate={(event, direction) => handlePropertyRowKeyDown(event, direction)}
        onChange={(next) => writeProperty(display.schema, next)}
        onRename={(newName) => void renameProperty(row.name, newName)}
        onDelete={() => void deleteProperty(row.name)}
      />
    )
  }

  return (
    <div className={`tm-property-fields mt-1.5 space-y-1 pb-1 pl-1 ${childIds.length ? 'mb-1' : ''}`}>
      {propertySections.map(section => (
        <div key={section.id} className="space-y-0.5">
          <div
            className="ml-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70"
            title={section.description}
          >
            {section.label}
          </div>
          {section.rows.map(row => renderPropertyRow(section, row))}
        </div>
      ))}

      {showHiddenFields && (
        <div className="space-y-0.5">
          <div className="ml-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Hidden
          </div>
          <MetadataRow label="ID" value={blockData.id} />
          <MetadataRow label="Last changed" value={new Date(blockData.updatedAt).toLocaleString()} />
          <MetadataRow label="Changed by" value={blockData.updatedBy} />
          {hiddenRows.map(row => renderPropertyRow(HIDDEN_SECTION, row))}
        </div>
      )}

      {!readOnly && <AddPropertyForm key={block.id} blockId={block.id} onAdd={addProperty} />}

      <Button
        variant="ghost"
        size="sm"
        type="button"
        className="ml-3 h-7 w-fit gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setShowHiddenFields(!showHiddenFields)}
      >
        {showHiddenFields ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        {showHiddenFields ? 'Hide hidden fields' : `Show hidden fields (${hiddenRows.length + 3})`}
      </Button>
    </div>
  )
}

const HIDDEN_SECTION: PropertyPanelSection = {id: 'hidden', label: 'Hidden', rows: []}

function MetadataRow({label, value}: {label: string; value: string}) {
  return (
    <div className="grid grid-cols-[1rem,minmax(7rem,13rem),minmax(0,1fr)] items-center gap-1.5 py-0.5 text-xs md:text-sm">
      <span className="select-none text-muted-foreground">&gt;</span>
      <div className="truncate text-muted-foreground" title={label}>{label}</div>
      <Input value={value} disabled className="h-7 min-w-0 bg-muted/30 text-xs md:text-sm" />
    </div>
  )
}

// ──── Per-property row ────

interface PropertyRowProps {
  name: string
  labelText: string
  kindLabel: PropertyKind
  schemaUnknown: boolean
  decodeFailed: boolean
  value: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customEditor: PropertyEditor<any> | undefined
  block: Block
  kind: PropertyKind
  readOnly: boolean
  canDelete?: boolean
  onNavigate: (event: KeyboardEvent<HTMLDivElement>, direction: -1 | 1) => void
  onChange: (next: unknown) => void
  onRename: (newName: string) => void
  onDelete: () => void
}

function PropertyRow({
  name,
  labelText,
  kindLabel,
  schemaUnknown,
  decodeFailed,
  value,
  customEditor,
  block,
  kind,
  readOnly,
  canDelete = true,
  onNavigate,
  onChange,
  onRename,
  onDelete,
}: PropertyRowProps) {
  const Editor = customEditor
  // Renaming = changing the storage key. Only safe for ad-hoc / unknown
  // schemas: a registered schema's name is the join key into
  // propertySchemasFacet / propertyUiFacet, so renaming "tasks:due-date"
  // to "Due date" would orphan the codec/editor binding. Make the field
  // display-only when a real schema is registered; keep the underlying
  // key (`name`) as the input's value so plugin-supplied UI labels
  // ("Due date") never accidentally persist as the new key on blur.
  const renameAllowed = schemaUnknown && !readOnly
  const hintText = [
    kindLabel,
    schemaUnknown ? 'schema not registered' : null,
    decodeFailed ? 'decode failed' : null,
    labelText !== name ? name : null,
  ].filter(Boolean).join(' · ')
  return (
    <div
      className="group/property-row grid grid-cols-[1rem,minmax(7rem,13rem),minmax(0,1fr),1.75rem] items-center gap-1.5 py-0.5 text-xs md:text-sm"
      data-property-row="true"
      data-block-id={block.id}
      data-property-name={name}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') onNavigate(event, -1)
        if (event.key === 'ArrowDown') onNavigate(event, 1)
      }}
    >
      <span className="select-none text-muted-foreground" title={hintText}>&gt;</span>
      <div className="min-w-0">
        {renameAllowed ? (
          <Input
            className="h-7 min-w-0 border-transparent px-0 text-xs shadow-none focus-visible:border-input focus-visible:px-2 md:text-sm"
            // Value = the storage key, not the UI label. For ad-hoc
            // properties these match (no UI contribution sets a
            // separate label), so this matches what the user sees.
            defaultValue={name}
            aria-label={`Field ${labelText}`}
            title={hintText}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                onRename(e.currentTarget.value)
              }
            }}
            onBlur={(e) => onRename(e.target.value)}
          />
        ) : (
          // Registered schema → label is display-only. Show the
          // contributed label (or the key when no contribution sets
          // one); the raw key is still exposed in the row tooltip.
          <div
            className="truncate text-muted-foreground"
            title={hintText}
          >
            {labelText}
            {schemaUnknown && <span className="ml-1 text-amber-600">*</span>}
            {decodeFailed && <span className="ml-1 text-destructive">*</span>}
          </div>
        )}
      </div>
      <div className="min-w-0" data-property-value="true">
        {Editor !== undefined && !decodeFailed ? (
          <Editor value={value} onChange={onChange} block={block} />
        ) : (
          <DefaultPropertyValueEditor
            kind={kind}
            value={value}
            onChange={onChange}
            readOnly={readOnly}
          />
        )}
      </div>
      <div className="flex h-7 items-center justify-center">
        {!readOnly && canDelete && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            title={`Delete ${labelText}`}
            className="h-7 w-7 p-0 text-muted-foreground opacity-0 hover:text-destructive group-hover/property-row:opacity-100 focus-visible:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ──── Codec-decode helper ────

const DECODE_FAILED = Symbol('decode-failed')

const resolveKnownPropertyDisplay = (
  name: string,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyUiContribution>,
): PropertyDisplayInfo | null => {
  const schema = schemas.get(name)
  if (!schema) return null
  const ui = uis.get(name)
  return {
    schema,
    kind: schema.kind,
    customEditor: ui?.Editor,
    isKnown: true,
  }
}

/** Decode an encoded value through `schema.codec.decode`, returning a
 *  sentinel symbol when the codec throws. The panel falls back to the
 *  raw encoded shape + a "decode failed" hint so a single bad row
 *  doesn't blank out the whole panel. */
const safeDecode = (schema: AnyPropertySchema, encoded: unknown): unknown => {
  try {
    return schema.codec.decode(encoded)
  } catch {
    return DECODE_FAILED
  }
}
