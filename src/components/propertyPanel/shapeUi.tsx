import {
  Braces,
  Calendar,
  CheckSquare,
  Hash,
  List,
  Type as TypeIcon,
} from 'lucide-react'
import type { CodecShape } from '@/data/api'
import { propertyShapeLabel } from './shapes'

export function PropertyShapeGlyph({
  shape,
  className = '',
}: {
  shape: CodecShape
  className?: string
}) {
  const props = {className: `h-3.5 w-3.5 ${className}`, strokeWidth: 1.8}
  switch (shape) {
    case 'number':
      return <Hash {...props} />
    case 'boolean':
      return <CheckSquare {...props} />
    case 'list':
      return <List {...props} />
    case 'date':
      return <Calendar {...props} />
    case 'object':
      return <Braces {...props} />
    case 'string':
      return <TypeIcon {...props} />
  }
}

export function PropertyShapeButton({
  shape,
  label,
  schemaUnknown,
  decodeFailed = false,
  onClick,
}: {
  shape: CodecShape
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
      title={`Configure ${label} (${propertyShapeLabel(shape)})`}
      aria-label={`Configure ${label}`}
      data-property-config-button="true"
      data-property-row-control="true"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      }}
    >
      <PropertyShapeGlyph shape={shape} />
    </button>
  )
}
