/** AddPropertyForm — the panel's "add a field" entry point. Wraps the
 *  shared PropertyPicker with the panel's row layout (3-column grid),
 *  the +Field toggle button, and the focus-after-add bridge. The form
 *  either adopts an existing schema or asks UserSchemasService.addSchema
 *  to create a new one (default preset: 'ref') before the caller shows
 *  an unset row for the property. */

import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  consumePendingPropertyCreateRequest,
  focusPropertyRowByNameWhenReady,
  subscribePropertyCreateRequests,
} from '@/utils/propertyNavigation.js'
import type { AnyPropertySchema } from '@/data/api'
import { PROPERTY_ROW_GRID_STYLE } from './layout'
import {
  PropertyPicker,
  type AddPropertyArgs,
  type ConfigureNewSchemaArgs,
} from './PropertyPicker'

export type { AddPropertyArgs, ConfigureNewSchemaArgs }

interface OpenState {
  /** Bumps on every open so PropertyPicker remounts and picks up a
   *  fresh `initialName`. */
  key: number
  initialName: string
}

export function AddPropertyForm({
  blockId,
  onAdd,
  onConfigureNewSchema,
}: {
  blockId: string
  onAdd: (args: AddPropertyArgs) => void | Promise<void>
  /** Glyph-click handler — see PropertyPicker. */
  onConfigureNewSchema: (
    args: ConfigureNewSchemaArgs,
  ) => Promise<AnyPropertySchema | undefined>
}) {
  const [initialRequest] = useState(() => consumePendingPropertyCreateRequest(blockId))
  const [openState, setOpenState] = useState<OpenState | null>(
    initialRequest ? {key: 0, initialName: initialRequest.initialName ?? ''} : null,
  )

  const openForm = useCallback((initialName = '') => {
    setOpenState(prev => ({
      key: (prev?.key ?? 0) + 1,
      initialName,
    }))
  }, [])

  useEffect(() => {
    return subscribePropertyCreateRequests(blockId, detail => openForm(detail.initialName))
  }, [blockId, openForm])

  const handleAdd = useCallback(async (args: AddPropertyArgs) => {
    await onAdd(args)
    setOpenState(null)
    focusPropertyRowByNameWhenReady(blockId, args.name)
  }, [blockId, onAdd])

  if (!openState) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-fit gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
        title="Add field"
        onClick={() => openForm()}
      >
        <Plus className="h-3.5 w-3.5" />
        Field
      </Button>
    )
  }

  return (
    <div
      className="grid items-center gap-2 border-b border-border/40 py-0.5 text-sm"
      style={PROPERTY_ROW_GRID_STYLE}
    >
      <PropertyPicker
        key={openState.key}
        initialName={openState.initialName}
        onAdd={handleAdd}
        onConfigureNewSchema={onConfigureNewSchema}
        autoFocus
        onEscape={() => setOpenState(null)}
      />
      <PropertyEmptyValue />
      <div />
    </div>
  )
}

function PropertyEmptyValue() {
  return (
    <div className="min-w-0">
      <div className="h-7 truncate py-1 text-sm text-muted-foreground/55">
        Empty
      </div>
    </div>
  )
}
