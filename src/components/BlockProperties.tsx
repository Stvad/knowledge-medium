
import { Block } from '../data/block'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'

interface BlockPropertiesProps {
  block: Block;
}

export function BlockProperties({ block }: BlockPropertiesProps) {
  const blockData = block.use()
  if (!blockData) return null
  
  const properties = blockData.properties || {}

  const updateKey = (newKey: string, key: string, value: string | undefined) => {
    if (newKey && newKey !== key) {
      block.change(doc => {
        delete doc.properties[key]
        doc.properties[newKey] = value
      })
    }
  }

  return (
    <div className="mt-4 space-y-3 border-l-2 border-muted pl-4">
      <div className="flex gap-2 items-center">
        <Label className="w-24">ID</Label>
        <Input value={blockData.id} disabled className="bg-muted/50" />
      </div>

      {Object.entries(properties).map(([key, value]) => (
        <div key={key} className="flex gap-2 items-center">
          <Input
            className="w-24"
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
            value={value || ''}
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
