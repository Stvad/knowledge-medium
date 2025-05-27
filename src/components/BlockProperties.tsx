import { Block, useData } from '../data/block'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { BlockProperty, ListBlockProperty } from '@/types'
import { stringProperty, numberProperty, booleanProperty, listProperty } from '@/data/properties'
import { useState } from 'react'
import { X, Plus, Trash2 } from 'lucide-react'

interface BlockPropertiesProps {
  block: Block;
}

// Component for editing list properties
function ListPropertyEditor({ property, onUpdate }: { 
  property: ListBlockProperty<string>, 
  onUpdate: (newProperty: ListBlockProperty<string>) => void 
}) {
  const [newItem, setNewItem] = useState('')
  const items = property.value || []

  const addItem = () => {
    if (newItem.trim()) {
      const updatedItems = [...items, newItem.trim()]
      onUpdate({ ...property, value: updatedItems })
      setNewItem('')
    }
  }

  const removeItem = (index: number) => {
    const updatedItems = items.filter((_, i) => i !== index)
    onUpdate({ ...property, value: updatedItems })
  }

  const updateItem = (index: number, newValue: string) => {
    const updatedItems = items.map((item, i) => i === index ? newValue : item)
    onUpdate({ ...property, value: updatedItems })
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
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => removeItem(index)}
            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
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
    </div>
  )
}

// Component for rendering different property types
function PropertyValueEditor({ property, onUpdate }: { 
  property: BlockProperty, 
  onUpdate: (newProperty: BlockProperty) => void 
}) {
  if (property.type === 'list') {
    return (
      <ListPropertyEditor 
        property={property as ListBlockProperty<string>} 
        onUpdate={onUpdate as (newProperty: ListBlockProperty<string>) => void}
      />
    )
  }

  if (property.type === 'boolean') {
    return (
      <select
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-xs md:text-sm"
        value={property.value?.toString() ?? 'false'}
        onChange={(e) => {
          onUpdate({ ...property, value: e.target.value === 'true' })
        }}
      >
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  }

  if (property.type === 'number') {
    return (
      <Input
        type="number"
        className="text-xs md:text-sm"
        value={property?.value?.toString() ?? ''}
        onChange={(e) => {
          const numValue = parseFloat(e.target.value)
          onUpdate({ ...property, value: isNaN(numValue) ? undefined : numValue })
        }}
      />
    )
  }

  // Default to string input
  return (
    <Input
      className="text-xs md:text-sm"
      value={property?.value?.toString() ?? ''}
      onChange={(e) => {
        onUpdate({ ...property, value: e.target.value })
      }}
    />
  )
}

type NewPropertyType = 'string' | 'number' | 'boolean' | 'list'

// Component for adding new properties with type selection
function AddPropertyForm({ onAdd }: { onAdd: (property: BlockProperty) => void }) {
  const [isOpen, setIsOpen] = useState(false)
  const [propertyName, setPropertyName] = useState('')
  const [propertyType, setPropertyType] = useState<NewPropertyType>('string')

  const handleAdd = () => {
    if (!propertyName.trim()) return

    let newProperty: BlockProperty
    switch (propertyType) {
      case 'string':
        newProperty = stringProperty(propertyName.trim(), '')
        break
      case 'number':
        newProperty = numberProperty(propertyName.trim(), 0)
        break
      case 'boolean':
        newProperty = booleanProperty(propertyName.trim(), false)
        break
      case 'list':
        newProperty = listProperty<string>(propertyName.trim(), [])
        break
    }

    onAdd(newProperty)
    setPropertyName('')
    setPropertyType('string')
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
          value={propertyType}
          onChange={(e) => setPropertyType(e.target.value as NewPropertyType)}
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

export function BlockProperties({ block }: BlockPropertiesProps) {
  const blockData = useData(block)
  if (!blockData) return null
  
  const properties = blockData.properties || {}

  const updateKey = (newKey: string, key: string, property: BlockProperty) => {
    if (newKey && newKey !== key) {
      block.change(doc => {
        doc.properties[newKey] = {...property, name: newKey}
        delete doc.properties[key]
      })
    }
  }

  const updateProperty = (property: BlockProperty) => {
    block.setProperty(property)
  }

  const deleteProperty = (key: string) => {
    block.change(doc => {
      delete doc.properties[key]
    })
  }

  const addProperty = (property: BlockProperty) => {
    block.setProperty(property)
  }

  return (
    <div className="mt-3 md:mt-4 space-y-2 md:space-y-3 border-l-2 border-muted pl-2 md:pl-4 pb-2">
      <div className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center">
        <Label className="w-full sm:w-1/3 text-xs md:text-sm">ID</Label>
        <Input value={blockData.id} disabled className="bg-muted/50 text-xs md:text-sm" />
      </div>
      <div className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center">
        <Label className="w-full sm:w-1/3 text-xs md:text-sm">Last Changed</Label>
        <Input value={new Date(blockData.updateTime).toLocaleString()} disabled className="bg-muted/50 text-xs md:text-sm" />
      </div>
      <div className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center">
        <Label className="w-full sm:w-1/3 text-xs md:text-sm">Changed by User</Label>
        <Input value={blockData.updatedByUserId} disabled className="bg-muted/50 text-xs md:text-sm" />
      </div>

      {Object.entries(properties).map(([key, property]) =>
        property && (
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
                        updateKey(e.currentTarget.value, key, property)
                      }
                    }}
                    onBlur={(e) => updateKey(e.target.value, key, property)}
                  />
                </div>
                <div className="text-xs text-muted-foreground">
                  {property.type}
                </div>
              </div>
              <div className="flex-1">
                <PropertyValueEditor 
                  property={property} 
                  onUpdate={updateProperty}
                />
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => deleteProperty(key)}
                className="h-9 w-9 p-0 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}

      <AddPropertyForm onAdd={addProperty} />
    </div>
  )
}
