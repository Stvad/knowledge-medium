import { Settings2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { useRepo } from '@/context/repo.js'
import { useOpenBlock } from '@/utils/navigation.js'
import { buildAppHash } from '@/utils/routing.js'
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
  const repo = useRepo()
  const workspaceId = repo.activeWorkspaceId ?? undefined
  // Hooks must be unconditional; the opener is only wired up for rows
  // that actually carry a link target (currently just "Changed by").
  const openBlock = useOpenBlock({blockId: row.linkToBlockId ?? '', workspaceId})
  const showLink = Boolean(row.linkToBlockId) && Boolean(workspaceId)

  return (
    <div
      className="grid items-center gap-2 py-0.5 text-sm"
      style={METADATA_ROW_GRID_STYLE}
    >
      <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
      <div className="truncate text-muted-foreground" title={row.label}>{row.label}</div>
      {showLink ? (
        <a
          href={buildAppHash(workspaceId!, row.linkToBlockId!)}
          onClick={openBlock}
          title={row.value}
          className="inline-flex h-7 min-w-0 items-center rounded-sm px-2 text-sm text-foreground no-underline hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate">{row.value}</span>
        </a>
      ) : (
        <Input value={row.value} disabled className="h-7 min-w-0 bg-muted/30 text-sm" />
      )}
    </div>
  )
}
