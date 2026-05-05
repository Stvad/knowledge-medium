/**
 * Property panel — implements the §5.6.1 lookup chain:
 *
 *   1. Look up the schema in `propertySchemasFacet`.
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

import { useMemo, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Block } from '../data/block'
import {
  ChangeScope,
  type AnyPropertySchema,
  type PropertyEditor,
  type PropertyKind,
} from '@/data/api'
import { useHandle } from '@/hooks/block.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { usePropertySchemas } from '@/hooks/propertySchemas.ts'
import { propertyUiFacet } from '../data/facets.ts'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import {
  DefaultPropertyValueEditor,
  adhocSchema,
  defaultValueForKind,
  resolvePropertyDisplay,
} from './propertyEditors/defaults'

interface BlockPropertiesProps {
  block: Block
}

// ──── Add-new-property form ────

/** Kinds the user can pick when adding a brand-new property by hand.
 *  Excludes `date` because the JSON-shape inference can't recover dates
 *  on read (they round-trip as strings); date-typed properties should be
 *  contributed by a plugin with a real `PropertySchema` so the codec
 *  handles encode/decode. */
type AddableKind = Exclude<PropertyKind, 'date' | 'object'> | 'object'

const ADDABLE_KINDS: ReadonlyArray<AddableKind> = ['string', 'number', 'boolean', 'list', 'object']

function AddPropertyForm({onAdd}: {onAdd: (name: string, kind: AddableKind) => void}) {
  const [isOpen, setIsOpen] = useState(false)
  const [propertyName, setPropertyName] = useState('')
  const [propertyKind, setPropertyKind] = useState<AddableKind>('string')

  const handleAdd = () => {
    if (!propertyName.trim()) return
    onAdd(propertyName.trim(), propertyKind)
    setPropertyName('')
    setPropertyKind('string')
    setIsOpen(false)
  }

  if (!isOpen) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="text-xs md:text-sm"
        onClick={() => setIsOpen(true)}
      >
        Add Property
      </Button>
    )
  }

  return (
    <div className="space-y-2 p-3 border rounded-md bg-muted/20">
      <div className="flex gap-2">
        <Input
          placeholder="Property name"
          value={propertyName}
          onChange={(e) => setPropertyName(e.target.value)}
          className="text-xs md:text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAdd()
            }
            if (e.key === 'Escape') {
              setIsOpen(false)
            }
          }}
        />
        <select
          className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-xs md:text-sm"
          value={propertyKind}
          onChange={(e) => setPropertyKind(e.target.value as AddableKind)}
        >
          {ADDABLE_KINDS.map(k => (
            <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={handleAdd} disabled={!propertyName.trim()}>
          Add
        </Button>
        <Button variant="outline" size="sm" onClick={() => setIsOpen(false)}>
          Cancel
        </Button>
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
  const runtime = useAppRuntime()
  // Read both registries once per render — combine() is memoised inside
  // FacetRuntime, so re-read is cheap (Map identity-stable across the
  // same runtime).
  const schemas = usePropertySchemas()
  const uis = runtime.read(propertyUiFacet)

  const properties = useMemo(() => blockData?.properties ?? {}, [blockData?.properties])

  if (!blockData) return null
  const readOnly = block.repo.isReadOnly

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
    writeProperty(adhocSchema(name, kind), defaultValueForKind(kind))
  }

  return (
    <div className="mt-3 md:mt-4 space-y-2 md:space-y-3 border-l-2 border-muted pl-2 md:pl-4 pb-2">
      <div className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center">
        <Label className="w-full sm:w-1/3 text-xs md:text-sm">ID</Label>
        <Input value={blockData.id} disabled className="bg-muted/50 text-xs md:text-sm" />
      </div>
      <div className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center">
        <Label className="w-full sm:w-1/3 text-xs md:text-sm">Last Changed</Label>
        <Input value={new Date(blockData.updatedAt).toLocaleString()} disabled className="bg-muted/50 text-xs md:text-sm" />
      </div>
      <div className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center">
        <Label className="w-full sm:w-1/3 text-xs md:text-sm">Changed by User</Label>
        <Input value={blockData.updatedBy} disabled className="bg-muted/50 text-xs md:text-sm" />
      </div>

      {Object.entries(properties).map(([key, encodedValue]) => {
        const display = resolvePropertyDisplay({name: key, encodedValue, schemas, uis})
        // Decode if a real schema is registered; otherwise the encoded
        // shape IS the editor's value (ad-hoc schema uses unsafeIdentity).
        const value = display.isKnown
          ? safeDecode(display.schema, encodedValue)
          : encodedValue
        const decodeFailed = display.isKnown && value === DECODE_FAILED
        const ui = uis.get(key)
        const labelText = ui?.label ?? key
        return (
          <PropertyRow
            key={key}
            name={key}
            labelText={labelText}
            kindLabel={display.kind}
            schemaUnknown={!display.isKnown}
            decodeFailed={decodeFailed}
            value={decodeFailed ? encodedValue : value}
            customEditor={display.customEditor}
            block={block}
            kind={display.kind}
            readOnly={readOnly}
            onChange={(next) => writeProperty(display.schema, next)}
            onRename={(newName) => void renameProperty(key, newName)}
            onDelete={() => void deleteProperty(key)}
          />
        )
      })}

      {!readOnly && <AddPropertyForm onAdd={addProperty} />}
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
  return (
    <div className="space-y-2">
      <div className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-start">
        <div className="w-full sm:w-1/3 space-y-1">
          <div className="flex gap-1">
            {renameAllowed ? (
              <Input
                className="text-xs md:text-sm flex-1"
                // Value = the storage key, not the UI label. For ad-hoc
                // properties these match (no UI contribution sets a
                // separate label), so this matches what the user sees.
                defaultValue={name}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    onRename(e.currentTarget.value)
                  }
                }}
                onBlur={(e) => onRename(e.target.value)}
              />
            ) : (
              // Registered schema → label is display-only. Show the
              // contributed label (or the key when no contribution sets
              // one); the raw key is also surfaced below when distinct.
              <div className="flex h-9 flex-1 items-center px-3 text-xs md:text-sm text-foreground">
                {labelText}
              </div>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {kindLabel}
            {schemaUnknown && (
              <span className="ml-1 text-amber-600" title="No PropertySchema registered for this name; using JSON-shape inference.">
                · schema not registered
              </span>
            )}
            {decodeFailed && (
              <span className="ml-1 text-destructive" title="Stored value didn't match the schema's codec; rendering raw value.">
                · decode failed
              </span>
            )}
          </div>
          {labelText !== name && (
            <div className="text-xs text-muted-foreground/60 truncate" title={name}>
              {name}
            </div>
          )}
        </div>
        <div className="flex-1">
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
        {!readOnly && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="h-9 w-9 p-0 text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ──── Codec-decode helper ────

const DECODE_FAILED = Symbol('decode-failed')

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
