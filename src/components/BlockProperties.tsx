
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
    <div className="mt-4 space-y-3 border-l-2 border-muted pl-4 pb-2">
      <div className="flex gap-2 items-center">
        <Label className="w-1/3">ID</Label>
        <Input value={blockData.id} disabled className="bg-muted/50" />
      </div>
      <div className="flex gap-2 items-center">
        <Label className="w-1/3">Changed Time</Label>
        <Input value={new Date(blockData.updateTime).toLocaleString()} disabled className="bg-muted/50" />
      </div>

      {Object.entries(properties).map(([key, value]) => (
        <div key={key} className="flex gap-2 items-center">
          <Input
            className="w-1/3"
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
