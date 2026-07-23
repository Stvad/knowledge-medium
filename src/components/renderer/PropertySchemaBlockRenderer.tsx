/** Renderer for `'property-schema'` blocks. Wraps the default block
 *  layout (so the block keeps normal indentation, children, focus,
 *  drag, hover, etc.) and only replaces the content area with a
 *  schema editor — name input, preset picker, dispatched
 *  `preset.ConfigEditor`, and a delete button. See
 *  user-defined-properties.md §4a. */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { useHandle } from '@/hooks/block.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import {readValuePresets} from '@/data/valuePresetRegistry'
import { isValidSeededDefinition } from '@/data/definitionSeeds.js'
import { isRoundTrippableReferenceLabel } from '@/data/referenceBlock'
import { selectablePresets } from '@/components/propertyEditors/selectablePresets.js'
import {
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
} from '@/data/properties.js'
import { ChangeScope, propertyValue, type AnyJoinedValuePreset } from '@/data/api'
import { Input } from '@/components/ui/input.js'
import { Button } from '@/components/ui/button.js'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import { PropertyShapeGlyph } from '@/components/propertyPanel/shapeUi.js'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'

const renderConfigEditor = (
  preset: AnyJoinedValuePreset,
  value: unknown,
  onChange: (next: unknown) => void,
): React.ReactNode => {
  if (!preset.ConfigEditor) return null
  const ConfigEditor = preset.ConfigEditor
  return <ConfigEditor value={value} onChange={onChange} />
}

/** Exported for the read-only regression test; production mounts it only
 *  through `PropertySchemaBlockRenderer` below. */
export const PropertySchemaContentRenderer: BlockRenderer = ({block}: BlockRendererProps) => {
  const data = useHandle(block, {
    selector: d => d ? {
      id: d.id,
      workspaceId: d.workspaceId,
      properties: d.properties,
    } : undefined,
  })
  const runtime = useAppRuntime()
  const presets = readValuePresets(runtime)

  // A materialized seed row is a kernel/plugin property *defined in code*.
  // In v1 these are code-owned and unshadowable: their name, type, config,
  // and lifecycle are fixed by the declaration. Editing the seed's own row
  // has no legitimate meaning and silently corrupts the definition — e.g.
  // switching its preset leaves a stored default the new codec can't decode,
  // which drops the whole schema to metadata-only. Render read-only so the
  // user sees what the property is without being able to mutate it. A viewer
  // (repo read-only) is the same case for a different reason.
  const isSeedBacked = data ? isValidSeededDefinition(data) : false
  const readOnly = block.repo.isReadOnly || isSeedBacked

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

  // Render-phase resync via two pieces of derived state. When the
  // committed `propertyName` changes (remote edit, undo/redo, sync),
  // we adopt it as the draft in the same render — React supports
  // setState-during-render for this exact case. Focus is intentionally
  // not preserved: if a remote write lands mid-edit, accepting the
  // new committed name beats letting a stale draft overwrite it on
  // the next blur.
  const [draftName, setDraftName] = useState(propertyName)
  const [committedName, setCommittedName] = useState(propertyName)
  if (propertyName !== committedName) {
    setCommittedName(propertyName)
    setDraftName(propertyName)
  }

  const writeName = useCallback(async (next: string) => {
    if (next === propertyName) return
    // Same invariant addSchema enforces at creation (PR #288 §7): the name
    // must survive a `[[name]]` round-trip — field-row retitles and every
    // re-derive-by-content path bind through that form, so a lossy label
    // (e.g. one containing `]]`) would strand the schema's field rows.
    // Reject by reverting the draft; the committed name stands.
    if (!isRoundTrippableReferenceLabel(next)) {
      setDraftName(propertyName)
      return
    }
    await block.set(propertyNameProp, next)
  }, [block, propertyName])

  const writePresetId = useCallback(async (next: string) => {
    if (next === presetId) return
    const target = presets.get(next)
    if (!target) return
    // setProperties applies a two-key DELTA read against the fresh in-tx row —
    // NOT a whole-bag replace off the (possibly stale) `data` render snapshot,
    // which would clobber any sibling key written between render and commit.
    await block.repo.tx(async tx => {
      await tx.setProperties(block.id, {
        set: [
          propertyValue(presetIdProp, next),
          // Reset config to the new preset's defaultConfig (re-encoded through
          // its configCodec, if any), since the previous preset's config shape
          // doesn't apply.
          propertyValue(presetConfigProp, target.configCodec
            ? target.configCodec.encode(target.defaultConfig as never) as Record<string, unknown>
            : {}),
        ],
      })
    }, {scope: ChangeScope.BlockDefault, description: `change preset to ${next}`})
  }, [block, presetId, presets])

  const writeConfig = useCallback(async (next: unknown) => {
    if (!preset?.configCodec) return
    let encoded: Record<string, unknown>
    try {
      encoded = preset.configCodec.encode(next as never) as Record<string, unknown>
    } catch (err) {
      console.warn(`[PropertySchemaContentRenderer] cannot encode config:`, err)
      return
    }
    await block.set(presetConfigProp, encoded)
  }, [block, preset])

  // Lazy delete-confirm: first click counts users; if any, ask for a
  // second click; second click (or no users) deletes. Confirm state
  // resets when name/preset/data changes so a stale count never lands.
  const [pendingDelete, setPendingDelete] = useState<{userCount: number} | null>(null)
  const [scanningUsers, setScanningUsers] = useState(false)
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current)
  }, [])

  const performDelete = useCallback(async () => {
    await block.repo.mutate.delete({id: block.id})
  }, [block])

  const handleDeleteClick = useCallback(async () => {
    if (pendingDelete) {
      setPendingDelete(null)
      await performDelete()
      return
    }
    if (!propertyName.trim()) {
      await performDelete()
      return
    }
    setScanningUsers(true)
    try {
      const userCount = await block.repo.countBlocksUsingProperty(
        propertyName,
        data?.workspaceId,
      )
      if (userCount === 0) {
        await performDelete()
        return
      }
      setPendingDelete({userCount})
      // Auto-cancel the confirm after 6s so a forgotten dialog doesn't
      // sit there waiting to fire on the next stray click.
      if (cancelTimerRef.current !== null) clearTimeout(cancelTimerRef.current)
      cancelTimerRef.current = setTimeout(() => setPendingDelete(null), 6000)
    } finally {
      setScanningUsers(false)
    }
  }, [block, data, pendingDelete, performDelete, propertyName])

  if (!data) return null

  // Hide presets that opt out of the picker (e.g. `enum`, whose options
  // can't be set here — switching a schema to it would build an empty,
  // always-failing codec), but keep the type a schema is already on.
  const presetEntries = selectablePresets(presets, presetId)

  return (
    <div className="w-full space-y-2 py-1">
      <div className="flex items-center gap-2">
        <PropertyShapeGlyph
          shape={presetId}
          Glyph={preset?.Glyph}
          className={preset ? 'text-fuchsia-500' : 'text-muted-foreground'}
        />
        <Input
          value={draftName}
          placeholder="property name"
          disabled={readOnly}
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

      <div className="grid grid-cols-[6rem,minmax(0,1fr)] items-center gap-3">
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
          {/* The config editors don't take a readOnly prop; block interaction
              at the wrapper so a read-only schema (seed-backed or viewer)
              still shows its options without letting them be edited. */}
          <div
            className={readOnly ? 'pointer-events-none opacity-60' : undefined}
            aria-disabled={readOnly || undefined}
          >
            {renderConfigEditor(preset, decodedConfig, writeConfig)}
          </div>
        </div>
      )}

      {isSeedBacked && (
        <div className="text-xs text-muted-foreground">
          Built-in property defined in code — its name, type, and options are
          fixed and can&rsquo;t be edited here.
        </div>
      )}

      {!preset && presetId !== '' && (
        <div className="text-xs text-muted-foreground">
          The plugin contributing preset <code className="font-mono">{presetId}</code> is not loaded.
          Schemas using this preset stay registered when the plugin loads.
        </div>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={scanningUsers}
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => { void handleDeleteClick() }}
          >
            {pendingDelete
              ? `Really delete? (${pendingDelete.userCount} ${pendingDelete.userCount === 1 ? 'block uses' : 'blocks use'} this)`
              : scanningUsers
                ? 'Checking…'
                : 'Delete schema'}
          </Button>
          {pendingDelete && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setPendingDelete(null)}
              >
                Cancel
              </Button>
              <span className="text-xs text-muted-foreground">
                Their values stay; the editor falls back to an inferred type.
              </span>
            </>
          )}
        </div>
      )}
    </div>
  )
}
PropertySchemaContentRenderer.displayName = 'PropertySchemaContentRenderer'

/** Outer wrapper: keeps the default block layout (children,
 *  indentation, drag handle, focus chrome) and swaps in the
 *  schema-editing content renderer. */
export const PropertySchemaBlockRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={PropertySchemaContentRenderer}
      EditContentRenderer={PropertySchemaContentRenderer}
    />
  ),
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
PropertySchemaBlockRenderer.displayName = 'PropertySchemaBlockRenderer'
