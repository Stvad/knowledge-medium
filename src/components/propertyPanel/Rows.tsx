import { Settings2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { METADATA_ROW_GRID_STYLE, PROPERTY_ROW_GRID_STYLE } from './layout'
import type { PropertyPanelMetadataRow, PropertyPanelModelSection } from './model'

export function PropertySectionLabel({section}: {section: PropertyPanelModelSection}) {
  const label = section.id.startsWith('type:')
    ? `# ${section.label}`
    : section.label

  return (
    <div
      className="grid items-center gap-2 pt-2 text-[11px] font-medium uppercase text-muted-foreground/60"
      style={PROPERTY_ROW_GRID_STYLE}
    >
      <span />
      <div className="truncate" title={section.description ?? section.label}>{label}</div>
      <span />
      <span />
    </div>
  )
}

export function MetadataRow({row}: {row: PropertyPanelMetadataRow}) {
  return (
    <div
      className="grid items-center gap-2 py-0.5 text-sm"
      style={METADATA_ROW_GRID_STYLE}
    >
      <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
      <div className="truncate text-muted-foreground" title={row.label}>{row.label}</div>
      <Input value={row.value} disabled className="h-7 min-w-0 bg-muted/30 text-sm" />
    </div>
  )
}
