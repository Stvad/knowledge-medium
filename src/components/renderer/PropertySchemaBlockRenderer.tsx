/** Dedicated renderer for `'property-schema'` blocks. Owns the
 *  schema-editing UI: a name input, a preset picker, and a dispatched
 *  `preset.ConfigEditor` for presets that ship one. See
 *  user-defined-properties.md §4a. */

import { useCallback, useMemo, useState, type ChangeEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { useHandle } from '@/hooks/block.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { valuePresetsFacet } from '@/data/facets.ts'
import {
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
} from '@/data/properties.ts'
import { ChangeScope, type AnyValuePreset } from '@/data/api'
import { Input } from '@/components/ui/input.tsx'
import { Button } from '@/components/ui/button.tsx'
import type { BlockRenderer, BlockRendererProps } from '@/types.ts'
import { PropertyShapeGlyph } from '@/components/propertyPanel/shapeUi.tsx'

const renderConfigEditor = (
  preset: AnyValuePreset,
  value: unknown,
  onChange: (next: unknown) => void,
): React.ReactNode => {
  if (!preset.ConfigEditor) return null
  const ConfigEditor = preset.ConfigEditor
  return <ConfigEditor value={value} onChange={onChange} />
}

const PropertySchemaBlockRendererImpl = ({block}: BlockRendererProps) => {
  const data = useHandle(block, {
    selector: d => d ? {
      id: d.id,
      properties: d.properties,
      deleted: d.deleted,
    } : undefined,
  })
  const runtime = useAppRuntime()
  const presets = runtime.read(valuePresetsFacet)
  const readOnly = block.repo.isReadOnly

  const presetId = useMemo<string>(() => {
    if (!data) return ''
    const raw = data.properties[presetIdProp.name]
    return raw === undefined ? presetIdProp.defaultValue : presetIdProp.codec.decode(raw)
  }, [data])

  const propertyName = useMemo<string>(() => {
    if (!data) return ''
    const raw = data.properties[propertyNameProp.name]
    return raw === undefined ? propertyNameProp.defaultValue : propertyNameProp.codec.decode(raw)
  }, [data])

  const persistedConfig = useMemo<Record<string, unknown>>(() => {
    if (!data) return {}
    const raw = data.properties[presetConfigProp.name]
    return raw === undefined ? presetConfigProp.defaultValue : presetConfigProp.codec.decode(raw)
  }, [data])

  const preset = presets.get(presetId) ?? null

  const decodedConfig = useMemo<unknown>(() => {
    if (!preset?.configCodec) return undefined
    try {
      return preset.configCodec.decode(persistedConfig)
    } catch {
      return preset.defaultConfig
    }
  }, [persistedConfig, preset])

  const [draftName, setDraftName] = useState(propertyName)
  // Re-sync the draft on remote changes (subscription tick).
  const lastSeenName = useMemo(() => propertyName, [propertyName])
  if (lastSeenName !== propertyName && draftName !== propertyName && !readOnly) {
    setDraftName(propertyName)
  }

  const writeName = useCallback(async (next: string) => {
    if (next === propertyName) return
    await block.set(propertyNameProp, next)
  }, [block, propertyName])

  const writePresetId = useCallback(async (next: string) => {
    if (next === presetId) return
    const target = presets.get(next)
    if (!target) return
    await block.repo.tx(async tx => {
      await tx.update(block.id, {
        properties: {
          ...data!.properties,
          [presetIdProp.name]: presetIdProp.codec.encode(next),
          // Reset config to the new preset's defaultConfig (re-encoded
          // through its configCodec, if any), since the previous
          // preset's config shape doesn't apply.
          [presetConfigProp.name]: presetConfigProp.codec.encode(
            target.configCodec
              ? target.configCodec.encode(target.defaultConfig as never) as Record<string, unknown>
              : {},
          ),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: `change preset to ${next}`})
  }, [block, data, presetId, presets])

  const writeConfig = useCallback(async (next: unknown) => {
    if (!preset?.configCodec) return
    let encoded: Record<string, unknown>
    try {
      encoded = preset.configCodec.encode(next as never) as Record<string, unknown>
    } catch (err) {
      console.warn(`[PropertySchemaBlockRenderer] cannot encode config:`, err)
      return
    }
    await block.set(presetConfigProp, encoded)
  }, [block, preset])

  if (!data || data.deleted) return null

  const presetEntries = Array.from(presets.values()).sort((a, b) => a.label.localeCompare(b.label))

  return (
    <div className="rounded-md border border-border bg-card px-4 py-3 text-sm">
      <div className="mb-3 flex items-center gap-2">
        <PropertyShapeGlyph
          shape={presetId}
          className={preset ? 'text-fuchsia-500' : 'text-muted-foreground'}
        />
        <Input
          value={draftName}
          placeholder="property name"
          readOnly={readOnly}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraftName(e.target.value)}
          onBlur={() => { void writeName(draftName.trim()) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          className="h-8 max-w-md text-base font-semibold"
        />
      </div>

      <div className="mb-3 grid grid-cols-[6rem,minmax(0,1fr)] items-center gap-3">
        <label className="text-xs font-semibold text-muted-foreground">Type</label>
        <div className="relative max-w-xs">
          <select
            className="h-9 w-full appearance-none rounded-md border border-input bg-background px-2 pr-9 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            value={presetId}
            disabled={readOnly}
            onChange={(e) => { void writePresetId(e.target.value) }}
          >
            {presetEntries.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
            {!preset && presetId !== '' && (
              <option value={presetId}>{presetId} (unknown)</option>
            )}
          </select>
          <ChevronDown
            className={`pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 ${
              readOnly ? 'text-muted-foreground/45' : 'text-foreground/70'
            }`}
          />
        </div>
      </div>

      {preset?.ConfigEditor && (
        <div className="grid grid-cols-[6rem,minmax(0,1fr)] gap-3">
          <label className="pt-1 text-xs font-semibold text-muted-foreground">Config</label>
          <div>
            {renderConfigEditor(preset, decodedConfig, writeConfig)}
          </div>
        </div>
      )}

      {!preset && presetId !== '' && (
        <div className="text-xs text-muted-foreground">
          The plugin contributing preset <code className="font-mono">{presetId}</code> is not loaded.
          Schemas using this preset stay registered when the plugin loads.
        </div>
      )}

      {!readOnly && (
        <div className="mt-3 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => { void block.repo.mutate.delete({id: block.id}) }}
          >
            Delete schema
          </Button>
        </div>
      )}
    </div>
  )
}

export const PropertySchemaBlockRenderer: BlockRenderer = Object.assign(
  PropertySchemaBlockRendererImpl,
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      // useRenderer's chooser also calls useData(block) before
      // running canRender, so by the time we get here block.peek()
      // is non-null on hot loads. On the very first render, peek
      // can be null — return false in that case so the chooser
      // falls back to the default renderer; once the block loads,
      // useRenderer reruns and we'll match.
      const data = block.peek()
      if (!data) return false
      const types = data.properties.types
      return Array.isArray(types) && types.includes('property-schema')
    },
    priority: () => 100,
  },
)
