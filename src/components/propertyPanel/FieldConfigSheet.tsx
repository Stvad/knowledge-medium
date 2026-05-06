import type { ReactNode } from 'react'
import { ChevronDown, X } from 'lucide-react'
import type { CodecShape } from '@/data/api'
import { Button } from '@/components/ui/button'
import { propertyShapeLabel } from './shapes'
import { PropertyShapeGlyph } from './shapeUi'

export interface FieldConfig {
  labelText: string
  shape: CodecShape
  shapeOptions: readonly CodecShape[]
  schemaUnknown: boolean
  decodeFailed: boolean
  readOnly: boolean
}

export function FieldConfigSheet({
  field,
  onShapeChange,
  onClose,
}: {
  field: FieldConfig | null
  onShapeChange: (shape: CodecShape) => void
  onClose: () => void
}) {
  if (!field) return null

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 w-[min(34rem,calc(100vw-1rem))] overflow-y-auto border-l border-border bg-background px-8 py-7 shadow-2xl"
      role="dialog"
      aria-modal="false"
      aria-label={`${field.labelText} field configuration`}
    >
      <div className="mb-8 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2 text-lg font-semibold">
            <PropertyShapeGlyph
              shape={field.shape}
              className={field.schemaUnknown ? 'text-muted-foreground' : 'text-fuchsia-500'}
            />
            <span className="truncate">{field.labelText}</span>
          </div>
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
          <div className="relative">
            <select
              className="h-9 w-full appearance-none rounded-md border border-input bg-background px-2 pr-9 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              aria-label={`${field.labelText} field type`}
              value={field.shape}
              disabled={field.readOnly}
              onChange={(event) => onShapeChange(event.target.value as CodecShape)}
            >
              {field.shapeOptions.map(option => (
                <option key={option} value={option}>{propertyShapeLabel(option)}</option>
              ))}
            </select>
            <ChevronDown
              className={`pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 ${
                field.readOnly ? 'text-muted-foreground/45' : 'text-foreground/70'
              }`}
            />
          </div>
        </ConfigRow>

        <ConfigRow label="Status">
          <div className="text-muted-foreground">
            {field.decodeFailed
              ? 'Decode failed'
              : field.schemaUnknown
                ? 'Local ad-hoc field'
                : 'Registered field'}
          </div>
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
