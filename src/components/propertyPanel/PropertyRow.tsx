import type { KeyboardEvent } from 'react'
import { Trash2 } from 'lucide-react'
import type { Block } from '@/data/block'
import { isRefCodec, isRefListCodec } from '@/data/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { propertyShapeLabel } from './shapes'
import { PropertyShapeButton } from './shapeUi'
import { PROPERTY_ROW_GRID_STYLE } from './layout'
import type { PropertyPanelModelRow } from './model'
import { usePropertyEditingActivation } from './usePropertyEditingActivation'

const formatRawJsonValue = (value: unknown): string => {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

// Read-only text rendering of a property value with no specialized editor —
// either a decode failure or a codec type no preset/override handles (e.g. an
// identity-codec object blob like a startup-metrics record). Better to show the
// raw value than a "nothing here" placeholder.
function RawJsonValue({value, reason}: {value: unknown; reason: string}) {
  if (value === undefined || value === null) {
    return <div className="h-7 truncate py-1 text-sm text-muted-foreground/55">Empty</div>
  }
  const rawJson = formatRawJsonValue(value)
  return (
    <div
      className="h-7 truncate py-1 font-mono text-sm text-muted-foreground"
      title={`${reason}; raw JSON value: ${rawJson}`}
    >
      {rawJson}
    </div>
  )
}

export function PropertyRow({
  row,
  block,
  readOnly,
  canConfigure,
  recentlyMaterialized = false,
  onNavigate,
  onConfigure,
  onChange,
  onRename,
  onDelete,
}: {
  row: PropertyPanelModelRow
  block: Block
  readOnly: boolean
  /** Whether the glyph button should open a config UI. False for
   *  kernel/plugin schemas, which have no per-instance config. */
  canConfigure: boolean
  /** True briefly after the row's schema was materialised through the
   *  optimistic-create path; renders a transient "New schema" pill so
   *  the user notices the side panel didn't just open out of nowhere. */
  recentlyMaterialized?: boolean
  onNavigate: (event: KeyboardEvent<HTMLDivElement>, direction: -1 | 1) => void
  onConfigure: () => void
  onChange: (next: unknown) => void
  onRename: (newName: string) => void
  onDelete: () => void
}) {
  const Editor = row.Editor
  const rowReadOnly = readOnly
  const renameAllowed = row.canRename && !rowReadOnly
  const renameFocusHandlers = usePropertyEditingActivation(block)
  const rowAlignment = isRefCodec(row.schema.codec) || isRefListCodec(row.schema.codec)
    ? 'items-start'
    : 'items-center'
  const hintText = [
    propertyShapeLabel(row.shape),
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
      <PropertyShapeButton
        shape={row.shape}
        Glyph={row.Glyph}
        label={row.labelText}
        schemaUnknown={row.schemaUnknown}
        decodeFailed={row.decodeFailed}
        disabled={!canConfigure}
        onClick={onConfigure}
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="min-w-0 flex-1">
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
              onFocus={renameFocusHandlers.onFocus}
              onBlur={(event) => {
                renameFocusHandlers.onBlur()
                onRename(event.target.value)
              }}
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
        {recentlyMaterialized && (
          <span
            className="shrink-0 rounded-full bg-fuchsia-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fuchsia-700 dark:bg-fuchsia-900/40 dark:text-fuchsia-200"
            data-recently-materialized="true"
            title="A schema was just registered for this property — open the side panel to configure type or details."
          >
            New schema
          </span>
        )}
      </div>
      <div className="min-w-0" data-property-value="true">
        {Editor !== undefined && !row.decodeFailed ? (
          <Editor value={row.value} onChange={onChange} block={block} schema={row.schema} />
        ) : row.decodeFailed ? (
          <RawJsonValue value={row.encodedValue} reason="Decode failed" />
        ) : (
          <RawJsonValue value={row.value} reason="No editor registered" />
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
