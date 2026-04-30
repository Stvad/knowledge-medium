import { Block } from '@/data/internals/block'
import { ChangeScope, codecs, defineProperty, type PropertySchema } from '@/data/api'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { useState } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'
import { useData } from '@/hooks/block.ts'

interface BlockPropertiesProps {
  block: Block
}

/** Lossy kind inference from a JSON-encoded property value. Used by
 *  the UI when no PropertySchema is registered for a property name —
 *  the kind drives which editor to render. Phase 3's propertyUiFacet
 *  provides the principled answer; this is the §5.6.1
 *  unknown-schema-fallback. */
type Kind = 'string' | 'number' | 'boolean' | 'list' | 'object'

const inferKind = (value: unknown): Kind => {
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'object' && value !== null) return 'object'
  return 'string'
}

/** Build an ad-hoc PropertySchema for a property whose actual schema
 *  isn't registered. Uses an unsafe-identity codec because JSON-encoded
 *  shape == decoded shape for primitive properties. The schema's
 *  `changeScope` is BlockDefault — UI-state properties live in
 *  globalState.ts and never go through this editor. */
const adhocSchema = (name: string, kind: Kind): PropertySchema<unknown> => ({
  name,
  codec: kind === 'list'
    ? codecs.list(codecs.unsafeIdentity<unknown>()) as unknown as PropertySchema<unknown>['codec']
    : codecs.unsafeIdentity<unknown>(),
  defaultValue: kindDefault(kind),
  changeScope: ChangeScope.BlockDefault,
  kind,
})

const kindDefault = (kind: Kind): unknown => {
  switch (kind) {
    case 'string':  return ''
    case 'number':  return 0
    case 'boolean': return false
    case 'list':    return [] as unknown[]
    case 'object':  return {}
  }
}

// ──── List editor ────

function ListPropertyEditor({
  value,
  onChange,
  readOnly,
}: {
  value: unknown[]
  onChange: (next: unknown[]) => void
  readOnly: boolean
}) {
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
          <Button
            variant="ghost"
            size="sm"
            onClick={addItem}
            className="h-8 w-8 p-0"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

// ──── Per-kind value editor ────

function PropertyValueEditor({
  kind,
  value,
  onChange,
  readOnly,
}: {
  kind: Kind
  value: unknown
  onChange: (next: unknown) => void
  readOnly: boolean
}) {
  if (kind === 'list') {
    return (
      <ListPropertyEditor
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

  // Default to string input.
  return (
    <Input
      className="text-xs md:text-sm"
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onChange(e.target.value)}
      disabled={readOnly}
    />
  )
}

// ──── Add-new-property form ────

function AddPropertyForm({onAdd}: {onAdd: (name: string, kind: Kind) => void}) {
  const [isOpen, setIsOpen] = useState(false)
  const [propertyName, setPropertyName] = useState('')
  const [propertyKind, setPropertyKind] = useState<Kind>('string')

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
          onChange={(e) => setPropertyKind(e.target.value as Kind)}
        >
          <option value="string">String</option>
          <option value="number">Number</option>
          <option value="boolean">Boolean</option>
          <option value="list">List</option>
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
  const blockData = useData(block)
  if (!blockData) return null

  const properties = blockData.properties || {}
  const readOnly = block.repo.isReadOnly

  const setRaw = (name: string, kind: Kind, decodedValue: unknown) => {
    void block.set(adhocSchema(name, kind), decodedValue)
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

  const addProperty = (name: string, kind: Kind) => {
    setRaw(name, kind, kindDefault(kind))
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

      {Object.entries(properties).map(([key, value]) => {
        const kind = inferKind(value)
        return (
          <div key={key} className="space-y-2">
            <div className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-start">
              <div className="w-full sm:w-1/3 space-y-1">
                <div className="flex gap-1">
                  <Input
                    className="text-xs md:text-sm flex-1"
                    defaultValue={key}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void renameProperty(key, e.currentTarget.value)
                      }
                    }}
                    onBlur={(e) => void renameProperty(key, e.target.value)}
                    disabled={readOnly}
                  />
                </div>
                <div className="text-xs text-muted-foreground">{kind}</div>
              </div>
              <div className="flex-1">
                <PropertyValueEditor
                  kind={kind}
                  value={value}
                  onChange={(next) => setRaw(key, kind, next)}
                  readOnly={readOnly}
                />
              </div>
              {!readOnly && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void deleteProperty(key)}
                  className="h-9 w-9 p-0 text-destructive hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        )
      })}

      {!readOnly && <AddPropertyForm onAdd={addProperty} />}
    </div>
  )
}
