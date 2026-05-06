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

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  AtSign,
  Braces,
  Calendar,
  CheckSquare,
  Eye,
  EyeOff,
  Hash,
  List,
  Plus,
  Settings2,
  Trash2,
  Type as TypeIcon,
  X,
} from 'lucide-react'
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
const PROPERTY_ROW_GRID_STYLE = {
  gridTemplateColumns: '1.25rem minmax(8rem, 13rem) minmax(0, 1fr) 1.75rem',
}
const METADATA_ROW_GRID_STYLE = {
  gridTemplateColumns: '1.25rem minmax(8rem, 13rem) minmax(0, 1fr)',
}
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
  const [configOpen, setConfigOpen] = useState(false)
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
    <div
      className="grid items-center gap-2 border-b border-border/40 py-0.5 text-sm"
      style={PROPERTY_ROW_GRID_STYLE}
    >
      <PropertyKindButton
        kind={propertyKind}
        schemaUnknown
        label="New field"
        onClick={() => setConfigOpen(true)}
      />
      <Input
        ref={nameInputRef}
        placeholder="Field"
        value={propertyName}
        onChange={(e) => setPropertyName(e.target.value)}
        className="h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/60 focus-visible:border-transparent focus-visible:ring-0"
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
      <InlineEmptyValue kind={propertyKind} />
      <div />
      <FieldConfigSheet
        open={configOpen}
        name={propertyName.trim() || 'New field'}
        labelText={propertyName.trim() || 'New field'}
        kind={propertyKind}
        kindOptions={ADDABLE_KINDS}
        schemaUnknown
        readOnly={false}
        onKindChange={(next) => {
          if (isAddableKind(next)) setPropertyKind(next)
        }}
        onClose={() => setConfigOpen(false)}
      />
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
  const blockTypes = useMemo(() => {
    if (!blockData) return EMPTY_BLOCK_TYPES
    try {
      return getBlockTypes({properties})
    } catch {
      return EMPTY_BLOCK_TYPES
    }
  }, [blockData, properties])
  const visibleProperties = useMemo(() => {
    const next: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(properties)) {
      if (!isInlineHiddenProperty(name, schemas)) next[name] = value
    }
    if (!Object.prototype.hasOwnProperty.call(next, typesProp.name)) {
      next[typesProp.name] = typesProp.codec.encode(blockTypes)
    }
    return next
  }, [blockTypes, properties, schemas])
  const hiddenProperties = useMemo(() => {
    const next: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(properties)) {
      if (isInlineHiddenProperty(name, schemas)) next[name] = value
    }
    return next
  }, [properties, schemas])
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
    const rowReadOnly = readOnly

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
  const showSectionLabels = propertySections.length > 1

  return (
    <div className={`tm-property-fields mt-1.5 max-w-[46rem] space-y-0.5 pb-1 pl-1 ${childIds.length ? 'mb-1' : ''}`}>
      {showHiddenFields && (
        <div className="space-y-0.5">
          <PropertySectionLabel section={HIDDEN_SECTION} />
          <MetadataRow label="ID" value={blockData.id} />
          <MetadataRow label="Last changed" value={new Date(blockData.updatedAt).toLocaleString()} />
          <MetadataRow label="Changed by" value={blockData.updatedBy} />
          {hiddenRows.map(row => renderPropertyRow(HIDDEN_SECTION, row))}
        </div>
      )}

      {propertySections.map(section => (
        <div key={section.id} className="space-y-0.5" title={section.description}>
          {showSectionLabels && <PropertySectionLabel section={section} />}
          {section.rows.map(row => renderPropertyRow(section, row))}
        </div>
      ))}

      {!readOnly && <AddPropertyForm key={block.id} blockId={block.id} onAdd={addProperty} />}

      <Button
        variant="ghost"
        size="sm"
        type="button"
        className="ml-5 h-7 w-fit gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setShowHiddenFields(!showHiddenFields)}
      >
        {showHiddenFields ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        {showHiddenFields ? 'Hide hidden fields' : `Show hidden fields (${hiddenRows.length + 3})`}
      </Button>
    </div>
  )
}

const HIDDEN_SECTION: PropertyPanelSection = {id: 'hidden', label: 'Hidden', rows: []}

function PropertySectionLabel({section}: {section: PropertyPanelSection}) {
  const label = section.id.startsWith('type:')
    ? `# ${section.label}`
    : section.label

  return (
    <div
      className="grid items-center gap-2 pt-2 text-[11px] font-medium uppercase text-muted-foreground/60"
      style={PROPERTY_ROW_GRID_STYLE}
    >
      <span />
      <div className="truncate" title={section.description ?? section.label}>{label}</div>
      <span />
      <span />
    </div>
  )
}

function MetadataRow({label, value}: {label: string; value: string}) {
  return (
    <div
      className="grid items-center gap-2 py-0.5 text-sm"
      style={METADATA_ROW_GRID_STYLE}
    >
      <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
      <div className="truncate text-muted-foreground" title={label}>{label}</div>
      <Input value={value} disabled className="h-7 min-w-0 bg-muted/30 text-sm" />
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
  const [configOpen, setConfigOpen] = useState(false)
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
      className="group/property-row grid items-center gap-2 border-b border-transparent py-0.5 text-sm hover:border-border/50 focus-within:border-border/70"
      style={PROPERTY_ROW_GRID_STYLE}
      data-property-row="true"
      data-block-id={block.id}
      data-property-name={name}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') onNavigate(event, -1)
        if (event.key === 'ArrowDown') onNavigate(event, 1)
      }}
    >
      <PropertyKindButton
        kind={kind}
        label={labelText}
        schemaUnknown={schemaUnknown}
        decodeFailed={decodeFailed}
        onClick={() => setConfigOpen(true)}
      />
      <div className="min-w-0">
        {renameAllowed ? (
          <Input
            className="h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0"
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
            className="truncate text-foreground"
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
          <InlinePropertyValueEditor
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
      <FieldConfigSheet
        open={configOpen}
        name={name}
        labelText={labelText}
        kind={kind}
        schemaUnknown={schemaUnknown}
        decodeFailed={decodeFailed}
        readOnly={readOnly || !schemaUnknown}
        onKindChange={() => undefined}
        onClose={() => setConfigOpen(false)}
      />
    </div>
  )
}

const FIELD_KIND_OPTIONS: readonly PropertyKind[] = [
  'string',
  'list',
  'ref',
  'refList',
  'date',
  'number',
  'boolean',
  'object',
]

const INLINE_INPUT_CLASS =
  'h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none placeholder:text-muted-foreground/55 focus-visible:border-transparent focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-60'

const isAddableKind = (kind: PropertyKind): kind is AddableKind =>
  ADDABLE_KINDS.includes(kind as AddableKind)

const kindLabel = (kind: PropertyKind): string => {
  switch (kind) {
    case 'string': return 'Plain'
    case 'list': return 'Options'
    case 'ref': return 'Reference'
    case 'refList': return 'Reference list'
    case 'date': return 'Date'
    case 'number': return 'Number'
    case 'boolean': return 'Checkbox'
    case 'object': return 'Object'
  }
}

function PropertyKindGlyph({kind, className = ''}: {kind: PropertyKind; className?: string}) {
  const props = {className: `h-3.5 w-3.5 ${className}`, strokeWidth: 1.8}
  switch (kind) {
    case 'number':
      return <Hash {...props} />
    case 'boolean':
      return <CheckSquare {...props} />
    case 'list':
    case 'refList':
      return <List {...props} />
    case 'date':
      return <Calendar {...props} />
    case 'ref':
      return <AtSign {...props} />
    case 'object':
      return <Braces {...props} />
    case 'string':
      return <TypeIcon {...props} />
  }
}

function PropertyKindButton({
  kind,
  label,
  schemaUnknown,
  decodeFailed = false,
  onClick,
}: {
  kind: PropertyKind
  label: string
  schemaUnknown: boolean
  decodeFailed?: boolean
  onClick: () => void
}) {
  const tone = decodeFailed
    ? 'text-destructive hover:text-destructive'
    : schemaUnknown
      ? 'text-muted-foreground hover:text-foreground'
      : 'text-fuchsia-500 hover:text-fuchsia-600'

  return (
    <button
      type="button"
      className={`flex h-7 w-5 items-center justify-center rounded-sm ${tone} hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
      title={`Configure ${label} (${kindLabel(kind)})`}
      aria-label={`Configure ${label}`}
      data-property-config-button="true"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      }}
    >
      <PropertyKindGlyph kind={kind} />
    </button>
  )
}

function InlineValueShell({children}: {children: ReactNode}) {
  return (
    <div className="min-w-0">{children}</div>
  )
}

function InlineEmptyValue({kind}: {kind: PropertyKind}) {
  return (
    <InlineValueShell>
      <div className="h-7 truncate py-1 text-sm text-muted-foreground/55">
        {kind === 'list' || kind === 'refList' ? 'Select option' : 'Empty'}
      </div>
    </InlineValueShell>
  )
}

function InlinePropertyValueEditor({
  kind,
  value,
  onChange,
  readOnly,
}: {
  kind: PropertyKind
  value: unknown
  onChange: (next: unknown) => void
  readOnly: boolean
}) {
  if (kind === 'list' || kind === 'refList') {
    const items = Array.isArray(value) ? value.map(v => typeof v === 'string' ? v : String(v)) : []
    return (
      <InlineValueShell>
        <Input
          className={INLINE_INPUT_CLASS}
          value={items.join(', ')}
          placeholder="Select option"
          readOnly={readOnly}
          onChange={(event) => {
            if (readOnly) return
            const text = event.target.value
            onChange(text.trim() ? text.split(',').map(item => item.trim()).filter(Boolean) : [])
          }}
        />
      </InlineValueShell>
    )
  }

  if (kind === 'boolean') {
    return (
      <InlineValueShell>
        <select
          className="flex h-7 w-full rounded-md border border-transparent bg-transparent px-0 py-1 text-sm shadow-none focus-visible:outline-none focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-60"
          value={String(value ?? false)}
          onChange={(event) => onChange(event.target.value === 'true')}
          disabled={readOnly}
        >
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </InlineValueShell>
    )
  }

  if (kind === 'number') {
    return (
      <InlineValueShell>
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
      </InlineValueShell>
    )
  }

  if (kind === 'object') {
    return (
      <InlineValueShell>
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
              // Keep the inline editor forgiving while the user is typing malformed JSON.
            }
          }}
        />
      </InlineValueShell>
    )
  }

  if (kind === 'date') {
    const isoString = value instanceof Date
      ? value.toISOString().slice(0, 10)
      : (typeof value === 'string' && value ? value.slice(0, 10) : '')
    return (
      <InlineValueShell>
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
      </InlineValueShell>
    )
  }

  return (
    <InlineValueShell>
      <Input
        className={INLINE_INPUT_CLASS}
        value={value === undefined || value === null ? '' : String(value)}
        placeholder="Empty"
        readOnly={readOnly}
        onChange={(event) => {
          if (!readOnly) onChange(event.target.value)
        }}
      />
    </InlineValueShell>
  )
}

function FieldConfigSheet({
  open,
  name,
  labelText,
  kind,
  kindOptions = FIELD_KIND_OPTIONS,
  schemaUnknown,
  decodeFailed = false,
  readOnly,
  onKindChange,
  onClose,
}: {
  open: boolean
  name: string
  labelText: string
  kind: PropertyKind
  kindOptions?: readonly PropertyKind[]
  schemaUnknown: boolean
  decodeFailed?: boolean
  readOnly: boolean
  onKindChange: (kind: PropertyKind) => void
  onClose: () => void
}) {
  if (!open) return null

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 w-[min(34rem,calc(100vw-1rem))] overflow-y-auto border-l border-border bg-background px-8 py-7 shadow-2xl"
      role="dialog"
      aria-modal="false"
      aria-label={`${labelText} field configuration`}
    >
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-lg font-semibold">
            <PropertyKindGlyph kind={kind} className={schemaUnknown ? 'text-muted-foreground' : 'text-fuchsia-500'} />
            <span className="truncate">{labelText}</span>
          </div>
          <div className="mt-2 text-sm text-muted-foreground">Add a description</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label="Close field configuration"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="divide-y divide-border text-sm">
        <ConfigRow label="Field type">
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={kind}
            disabled={readOnly}
            onChange={(event) => onKindChange(event.target.value as PropertyKind)}
          >
            {kindOptions.map(option => (
              <option key={option} value={option}>{kindLabel(option)}</option>
            ))}
          </select>
        </ConfigRow>

        <ConfigRow label="Status">
          <div className="text-muted-foreground">
            {decodeFailed
              ? 'Decode failed'
              : schemaUnknown
                ? 'Local ad-hoc field'
                : 'Registered field'}
          </div>
        </ConfigRow>

        <ConfigRow label="Storage key">
          <code className="rounded bg-muted px-1.5 py-1 text-xs text-muted-foreground">{name}</code>
        </ConfigRow>

        <ConfigRow label="Hide field">
          <select className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm" defaultValue="never">
            <option value="never">Never</option>
            <option value="empty">When empty</option>
            <option value="not-empty">When not empty</option>
            <option value="always">Always</option>
          </select>
        </ConfigRow>

        <ConfigRow label="Required">
          <label className="inline-flex items-center gap-2 text-muted-foreground">
            <input type="checkbox" className="h-4 w-4" disabled />
            Visual warning when empty
          </label>
        </ConfigRow>
      </div>
    </div>
  )
}

function ConfigRow({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="grid grid-cols-[9rem,minmax(0,1fr)] gap-4 py-3">
      <div className="pt-2 text-xs font-semibold text-muted-foreground">{label}</div>
      <div>{children}</div>
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
