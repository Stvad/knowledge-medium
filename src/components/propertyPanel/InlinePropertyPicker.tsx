import { useCallback, useLayoutEffect, useRef } from 'react'
import type { Block } from '@/data/block'
import type { AnyPropertySchema } from '@/data/api'
import { acquireEditModeKeepalive } from '@/components/editModeKeepalive'
import { showError } from '@/utils/toast'
import { PropertyPicker, type ConfigureNewSchemaArgs } from './PropertyPicker'
import {resolveOrCreateProperty} from './resolveOrCreateProperty'

interface InlinePropertyPickerProps {
  owner: Block
  onPick: (schema: AnyPropertySchema, isActive: () => boolean) => Promise<void>
  onCancel: (restoreFocus?: boolean) => void
  canSubmit?: () => boolean
}

/** The outline's schema input. Picking and configuring share the registry's
 *  creation path; the caller owns where the selected field is written.
 *  Keep this picker inline to retain the authored scaffold and caret;
 *  Cancel preserves the typed text until a selection is committed. */
export function InlinePropertyPicker({owner, onPick, onCancel, canSubmit}: InlinePropertyPickerProps) {
  const cancelled = useRef(false)
  const submitted = useRef(false)
  const element = useRef<HTMLDivElement>(null)
  const onCancelRef = useRef(onCancel)
  useLayoutEffect(() => { onCancelRef.current = onCancel }, [onCancel])
  useLayoutEffect(() => {
    cancelled.current = false
    const release = acquireEditModeKeepalive('yield-focus')
    const away = (event: PointerEvent) => {
      const listId = element.current?.querySelector('[aria-controls]')?.getAttribute('aria-controls')
      if (element.current?.contains(event.target as Node) ||
        (listId && document.getElementById(listId)?.contains(event.target as Node))) return
      cancelled.current = true
      onCancelRef.current(false)
    }
    document.addEventListener('pointerdown', away, true)
    return () => {
      if (!submitted.current) cancelled.current = true
      document.removeEventListener('pointerdown', away, true)
      release()
    }
  }, [])
  const canContinue = useCallback(() =>
    !cancelled.current && (!canSubmit || canSubmit()), [canSubmit])
  const requireCurrentInput = () => {
    if (cancelled.current) return false
    if (!canSubmit || canSubmit()) return true
    showError('The input changed. Your text was kept; type :: in an empty child to try again.')
    onCancel()
    return false
  }

  const resolveSchema = useCallback(async ({name, presetId}: ConfigureNewSchemaArgs) => {
    if (!canContinue()) return undefined
    const schema = await resolveOrCreateProperty(owner.repo, {name, presetId})
    return canContinue() ? schema : undefined
  }, [canContinue, owner])

  return <div ref={element} className="flex min-w-0 items-center gap-2" data-inline-property-picker="true">
    <PropertyPicker
      block={owner}
      autoFocus
      placeholder="Property name"
      onEscape={() => { cancelled.current = true; onCancel() }}
      onConfigureNewSchema={resolveSchema}
      onAdd={async args => {
        if (!requireCurrentInput()) return
        const schema = args.adopted ?? await resolveSchema(args)
        if (!schema) return
        try {
          submitted.current = true
          await onPick(schema, () => !cancelled.current)
        } catch (error) {
          showError(error instanceof Error ? error.message : 'Could not add property')
        }
      }}
    />
  </div>
}
