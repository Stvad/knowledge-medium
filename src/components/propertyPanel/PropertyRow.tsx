import type { KeyboardEvent } from 'react'
import { Trash2 } from 'lucide-react'
import type { Block } from '@/data/block'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { propertyKindLabel } from './kinds'
import { PropertyKindButton } from './kindUi'
import { InlinePropertyValueEditor } from './InlinePropertyValueEditor'
import { PROPERTY_ROW_GRID_STYLE } from './layout'
import type { PropertyPanelModelRow } from './model'

export function PropertyRow({
  row,
  block,
  readOnly,
  onNavigate,
  onConfigure,
  onChange,
  onRename,
  onDelete,
}: {
  row: PropertyPanelModelRow
  block: Block
  readOnly: boolean
  onNavigate: (event: KeyboardEvent<HTMLDivElement>, direction: -1 | 1) => void
  onConfigure: () => void
  onChange: (next: unknown) => void
  onRename: (newName: string) => void
  onDelete: () => void
}) {
  const Editor = row.customEditor
  const rowReadOnly = readOnly
  const renameAllowed = row.canRename && !rowReadOnly
  const rowAlignment = row.kind === 'ref' || row.kind === 'refList' ? 'items-start' : 'items-center'
  const hintText = [
    propertyKindLabel(row.kind),
    row.schemaUnknown ? 'schema not registered' : null,
    row.decodeFailed ? 'decode failed' : null,
    row.isHidden ? 'hidden field' : null,
    row.labelText !== row.name ? row.name : null,
  ].filter(Boolean).join(' · ')

  return (
    <div
      className={`group/property-row grid ${rowAlignment} gap-2 border-b border-transparent py-0.5 text-sm hover:border-border/50 focus-within:border-border/70`}
      style={PROPERTY_ROW_GRID_STYLE}
      data-property-row="true"
      data-block-id={block.id}
      data-property-name={row.name}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp') onNavigate(event, -1)
        if (event.key === 'ArrowDown') onNavigate(event, 1)
      }}
    >
      <PropertyKindButton
        kind={row.kind}
        label={row.labelText}
        schemaUnknown={row.schemaUnknown}
        decodeFailed={row.decodeFailed}
        onClick={onConfigure}
      />
      <div className="min-w-0">
        {renameAllowed ? (
          <Input
            className="h-7 min-w-0 border-transparent bg-transparent px-0 text-sm shadow-none focus-visible:border-transparent focus-visible:ring-0"
            defaultValue={row.name}
            aria-label={`Field ${row.labelText}`}
            data-property-label="true"
            title={hintText}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault()
                onRename(event.currentTarget.value)
              }
            }}
            onBlur={(event) => onRename(event.target.value)}
          />
        ) : (
          <div
            className="truncate text-foreground"
            data-property-label="true"
            tabIndex={-1}
            title={hintText}
          >
            {row.labelText}
            {row.schemaUnknown && <span className="ml-1 text-amber-600">*</span>}
            {row.decodeFailed && <span className="ml-1 text-destructive">*</span>}
          </div>
        )}
      </div>
      <div className="min-w-0" data-property-value="true">
        {Editor !== undefined && !row.decodeFailed ? (
          <Editor value={row.value} onChange={onChange} block={block} schema={row.schema} />
        ) : (
          <InlinePropertyValueEditor
            kind={row.kind}
            value={row.value}
            onChange={onChange}
            readOnly={rowReadOnly}
            ariaLabel={`Toggle ${row.labelText}`}
          />
        )}
      </div>
      <div className="flex h-7 items-center justify-center" data-property-row-control="true">
        {!rowReadOnly && row.canDelete && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            title={`Delete ${row.labelText}`}
            className="h-7 w-7 p-0 text-muted-foreground opacity-0 hover:text-destructive group-hover/property-row:opacity-100 focus-visible:opacity-100"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}
