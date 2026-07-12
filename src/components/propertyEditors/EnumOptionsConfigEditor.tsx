import {Plus, X} from 'lucide-react'
import {Button} from '@/components/ui/button'
import {Input} from '@/components/ui/input'
import type {ValuePresetConfigEditorProps} from '@/data/api'
import type {EnumPresetConfig} from '@/data/kernelValuePresetCores'

export function EnumOptionsConfigEditor({
  value,
  onChange,
}: ValuePresetConfigEditorProps<EnumPresetConfig>) {
  const update = (index: number, patch: {value?: string; label?: string}) => {
    onChange({
      options: value.options.map((option, i) => i === index ? {...option, ...patch} : option),
    })
  }
  return (
    <div className="space-y-2">
      {value.options.map((option, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`Choice ${index + 1} value`}
            value={option.value}
            placeholder="value"
            onChange={event => update(index, {value: event.target.value})}
          />
          <Input
            aria-label={`Choice ${index + 1} label`}
            value={option.label}
            placeholder="Label"
            onChange={event => update(index, {label: event.target.value})}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove choice ${index + 1}`}
            onClick={() => onChange({options: value.options.filter((_, i) => i !== index)})}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange({
          options: [...value.options, {value: '', label: ''}],
        })}
      >
        <Plus className="mr-1 h-4 w-4" /> Add choice
      </Button>
    </div>
  )
}
