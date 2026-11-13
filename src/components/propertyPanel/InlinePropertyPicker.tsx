import { useCallback, useLayoutEffect, useRef } from 'react'
import type { Block } from '@/data/block'
import type { AnyPropertySchema } from '@/data/api'
import { acquireEditModeKeepalive } from '@/components/editModeKeepalive'
import { showError } from '@/utils/toast'
import { PropertyPicker, type ConfigureNewSchemaArgs } from './PropertyPicker'

interface InlinePropertyPickerProps {
  owner: Block
  onPick: (schema: AnyPropertySchema) => Promise<void>
  onCancel: () => void
  canSubmit?: () => boolean
}

/** The outline's schema input. Picking and configuring share the registry's
 *  creation path; the caller owns where the selected field is written. */
export function InlinePropertyPicker({owner, onPick, onCancel, canSubmit}: InlinePropertyPickerProps) {
  const cancelled = useRef(false)
  useLayoutEffect(() => {
    cancelled.current = false
    const release = acquireEditModeKeepalive('yield-focus')
    return () => { cancelled.current = true; release() }
  }, [])
  const canContinue = useCallback(() =>
    !cancelled.current && (!canSubmit || canSubmit()), [canSubmit])

  const resolveSchema = useCallback(async ({name, presetId}: ConfigureNewSchemaArgs) => {
    if (!canContinue()) return undefined
    const existing = owner.repo.propertySchemas.get(name.trim())
    if (existing) return existing
    try {
      const schema = await owner.repo.userSchemas.addSchema({name: name.trim(), presetId})
      return canContinue() ? schema : undefined
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Could not create property')
      return undefined
    }
  }, [canContinue, owner])

  return <div className="flex min-w-0 items-center gap-2" data-inline-property-picker="true">
    <PropertyPicker
      block={owner}
      autoFocus
      placeholder="Property name"
      onEscape={() => { cancelled.current = true; onCancel() }}
      onConfigureNewSchema={resolveSchema}
      onAdd={async args => {
        if (!canContinue()) return
        const schema = args.adopted ?? await resolveSchema(args)
        if (!schema) return
        try {
          await onPick(schema)
        } catch (error) {
          showError(error instanceof Error ? error.message : 'Could not add property')
        }
      }}
    />
  </div>
}
