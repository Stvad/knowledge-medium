/** Config editor for ref / refList presets. Lets the user constrain
 *  the property to one or more block types — empty list means "any
 *  type accepted." Mounted inside the property-schema block renderer
 *  (the side panel reached via the row's glyph button). */

import { useCallback, useMemo, useState, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { typesFacet } from '@/data/facets.js'
import type { RefCodecOptions, ValuePresetConfigEditorProps } from '@/data/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function RefTargetTypePicker({
  value,
  onChange,
}: ValuePresetConfigEditorProps<RefCodecOptions>) {
  const runtime = useAppRuntime()
  const types = runtime.read(typesFacet)
  const known = useMemo(() => Array.from(types.values()).map(t => t.id).sort(), [types])

  const targets = useMemo<readonly string[]>(
    () => Array.isArray(value.targetTypes) ? value.targetTypes : [],
    [value.targetTypes],
  )

  const setTargets = useCallback(
    (next: readonly string[]) => {
      const deduped = Array.from(new Set(next.map(t => t.trim()).filter(Boolean)))
      onChange({...value, targetTypes: deduped.length > 0 ? deduped : undefined})
    },
    [onChange, value],
  )

  const [draft, setDraft] = useState('')
  const addDraft = useCallback(() => {
    const trimmed = draft.trim()
    if (!trimmed) return
    setTargets([...targets, trimmed])
    setDraft('')
  }, [draft, setTargets, targets])

  const remove = useCallback(
    (typeId: string) => setTargets(targets.filter(t => t !== typeId)),
    [setTargets, targets],
  )

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      addDraft()
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        {targets.length === 0
          ? 'Accepts any block type. Add one or more types to constrain.'
          : `Accepts only: ${targets.join(', ')}`}
      </div>

      {targets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {targets.map(typeId => (
            <span
              key={typeId}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs"
            >
              {typeId}
              <button
                type="button"
                aria-label={`Remove target type ${typeId}`}
                className="text-muted-foreground hover:text-foreground"
                onClick={() => remove(typeId)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-center">
        <Input
          list="ref-target-type-options"
          placeholder="Add a block type…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-7 text-xs md:text-sm"
        />
        <Button variant="ghost" size="sm" onClick={addDraft} className="h-7 w-7 p-0">
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>

      {known.length > 0 && (
        <datalist id="ref-target-type-options">
          {known.map(typeId => (
            <option key={typeId} value={typeId} />
          ))}
        </datalist>
      )}
    </div>
  )
}
