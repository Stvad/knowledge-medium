import { Block } from '../data/block'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import {BlockPropertyValue} from '@/types.ts'

interface BlockPropertiesProps {
  block: Block;
}

export function BlockProperties({ block }: BlockPropertiesProps) {
  const blockData = block.use()
  if (!blockData) return null
  
  const properties = blockData.properties || {}

  const updateKey = (newKey: string, key: string, value: BlockPropertyValue) => {
    if (newKey && newKey !== key) {
      block.change(doc => {
        delete doc.properties[key]
        doc.properties[newKey] = value
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

      {Object.entries(properties).map(([key, value]) => (
        <div key={key} className="flex flex-col sm:flex-row gap-1 sm:gap-2 sm:items-center">
          <Input
            className="w-full sm:w-1/3 text-xs md:text-sm"
            defaultValue={key}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                updateKey(e.currentTarget.value, key, value)
              }
            }}
            onBlur={(e) => updateKey(e.target.value, key, value)}
          />
          <Input
            className="text-xs md:text-sm"
            value={value?.toString() ?? ''}
            onChange={(e) => {
              block.change(doc => {
                doc.properties[key] = e.target.value
              })
            }}
          />
        </div>
      ))}

      <Button
        variant="outline"
        size="sm"
        className="text-xs md:text-sm"
        onClick={() => {
          block.change(doc => {
            doc.properties[`property${Object.keys(doc.properties).length + 1}`] = ''
          })
        }}
      >
        Add Property
      </Button>
    </div>
  )
}
