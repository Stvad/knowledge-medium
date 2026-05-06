import {
  AtSign,
  Braces,
  Calendar,
  CheckSquare,
  Hash,
  List,
  Type as TypeIcon,
} from 'lucide-react'
import type { PropertyKind } from '@/data/api'
import { propertyKindLabel } from './kinds'

export function PropertyKindGlyph({
  kind,
  className = '',
}: {
  kind: PropertyKind
  className?: string
}) {
  const props = {className: `h-3.5 w-3.5 ${className}`, strokeWidth: 1.8}
  switch (kind) {
    case 'number':
      return <Hash {...props} />
    case 'boolean':
      return <CheckSquare {...props} />
    case 'list':
    case 'refList':
      return <List {...props} />
    case 'date':
      return <Calendar {...props} />
    case 'ref':
      return <AtSign {...props} />
    case 'object':
      return <Braces {...props} />
    case 'string':
      return <TypeIcon {...props} />
  }
}

export function PropertyKindButton({
  kind,
  label,
  schemaUnknown,
  decodeFailed = false,
  onClick,
}: {
  kind: PropertyKind
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
      title={`Configure ${label} (${propertyKindLabel(kind)})`}
      aria-label={`Configure ${label}`}
      data-property-config-button="true"
      data-property-row-control="true"
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      }}
    >
      <PropertyKindGlyph kind={kind} />
    </button>
  )
}
