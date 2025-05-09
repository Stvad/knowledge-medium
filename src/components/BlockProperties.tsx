import { Block, useData } from '../data/block'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { BlockProperty } from '@/types'
import { stringProperty, isBlockProperty, migratePropertyValue } from '@/data/properties'

interface BlockPropertiesProps {
  block: Block;
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

      {Object.entries(properties).map(([key, property]) => {
        const prop = isBlockProperty(property) ? property : migratePropertyValue(key, property)

        return (
          <div key={key} className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center">
            <Input
              className="w-full sm:w-1/3 text-xs md:text-sm"
              defaultValue={key}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  updateKey(e.currentTarget.value, key, prop)
                }
              }}
              onBlur={(e) => updateKey(e.target.value, key, prop)}
            />
            <Input
              className="text-xs md:text-sm"
              value={prop.value?.toString() ?? ''}
              onChange={(e) => {
                block.setProperty(stringProperty(key, e.target.value))
              }}
            />
          </div>
        )
      })}

      <Button
        variant="outline"
        size="sm"
        className="text-xs md:text-sm"
        onClick={() => {
          const newKey = `property${Object.keys(blockData.properties).length + 1}`
          block.setProperty(stringProperty(newKey, ''))
        }}
      >
        Add Property
      </Button>
    </div>
  )
}
