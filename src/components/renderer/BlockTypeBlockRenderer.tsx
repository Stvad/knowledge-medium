/** Renderer for `'block-type'` blocks (user-defined-types Phase 1).
 *  Wraps the default block layout and replaces the content area with a
 *  type editor — label input, description textarea, and a properties
 *  list backed by the shared PropertyPicker (same autocomplete +
 *  inline-create UX as the property panel's "+ Field" surface).
 *  Parallel in shape to PropertySchemaBlockRenderer. */

import { useCallback, useMemo, useState, type ChangeEvent } from 'react'
import { X } from 'lucide-react'
import { useHandle } from '@/hooks/block.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { ChangeScope, type AnyPropertySchema } from '@/data/api'
import {
  blockTypeDescriptionProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
} from '@/data/properties.ts'
import { propertyEditorOverridesFacet, valuePresetsFacet } from '@/data/facets.ts'
import { Input } from '@/components/ui/input.tsx'
import { Button } from '@/components/ui/button.tsx'
import { PropertyShapeGlyph } from '@/components/propertyPanel/shapeUi.tsx'
import { propertyShapeLabel } from '@/components/propertyPanel/shapes.ts'
import {
  PropertyPicker,
  type AddPropertyArgs,
  type ConfigureNewSchemaArgs,
} from '@/components/propertyPanel/PropertyPicker.tsx'
import type { BlockRenderer, BlockRendererProps } from '@/types.ts'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'

const BlockTypeContentRenderer: BlockRenderer = ({block}: BlockRendererProps) => {
  const data = useHandle(block, {
    selector: d => d ? {
      id: d.id,
      properties: d.properties,
      deleted: d.deleted,
    } : undefined,
  })
  const readOnly = block.repo.isReadOnly
  const runtime = useAppRuntime()
  const presets = runtime.read(valuePresetsFacet)
  const uis = runtime.read(propertyEditorOverridesFacet)
  const userSchemas = block.repo.userSchemas

  const label = useMemo<string>(() => {
    if (!data) return ''
    const raw = data.properties[blockTypeLabelProp.name]
    return raw === undefined ? blockTypeLabelProp.defaultValue : blockTypeLabelProp.codec.decode(raw)
  }, [data])

  const description = useMemo<string>(() => {
    if (!data) return ''
    const raw = data.properties[blockTypeDescriptionProp.name]
    return raw === undefined ? blockTypeDescriptionProp.defaultValue : blockTypeDescriptionProp.codec.decode(raw)
  }, [data])

  const propertyRefs = useMemo<readonly string[]>(() => {
    if (!data) return []
    const raw = data.properties[blockTypePropertiesProp.name]
    return raw === undefined ? blockTypePropertiesProp.defaultValue : blockTypePropertiesProp.codec.decode(raw)
  }, [data])

  // Resolve each block-id ref to its published schema. Unresolved refs
  // surface as undefined so we can render a dangling-ref affordance
  // (rather than silently dropping). Phase 1 only supports user-defined
  // schemas (block-id refs); kernel-schema support is an open design
  // question handled by the upcoming codec extension.
  const resolvedEntries = useMemo(() => propertyRefs.map(refId => ({
    refId,
    schema: userSchemas.getSchemaForBlockId(refId),
  })), [propertyRefs, userSchemas])

  const excludedNames = useMemo(
    () => resolvedEntries.flatMap(e => e.schema ? [e.schema.name] : []),
    [resolvedEntries],
  )

  // Render-phase resync: when committed label changes (remote edit /
  // undo / sync), adopt it as the draft.
  const [draftLabel, setDraftLabel] = useState(label)
  const [committedLabel, setCommittedLabel] = useState(label)
  if (label !== committedLabel) {
    setCommittedLabel(label)
    setDraftLabel(label)
  }

  const [draftDescription, setDraftDescription] = useState(description)
  const [committedDescription, setCommittedDescription] = useState(description)
  if (description !== committedDescription) {
    setCommittedDescription(description)
    setDraftDescription(description)
  }

  const writeLabel = useCallback(async (next: string) => {
    if (next === label) return
    await block.set(blockTypeLabelProp, next)
  }, [block, label])

  const writeDescription = useCallback(async (next: string) => {
    if (next === description) return
    await block.set(blockTypeDescriptionProp, next)
  }, [block, description])

  const writeRefs = useCallback(async (next: readonly string[]) => {
    await block.repo.tx(async tx => {
      await tx.setProperty(block.id, blockTypePropertiesProp, next)
    }, {scope: ChangeScope.BlockDefault, description: 'edit block-type properties'})
  }, [block])

  // Translate a schema name into the property-schema block id it was
  // published from. Phase 1's codec stores block ids (rename-stable).
  // Kernel schemas have no backing block — they're silently skipped
  // here until the discriminated-list design lands. The picker still
  // shows them; on pick we just no-op so the user doesn't get a stale
  // ref.
  const appendSchema = useCallback(async (schema: AnyPropertySchema) => {
    const blockId = userSchemas.getSchemaBlockId(schema.name)
    if (!blockId) {
      console.warn(
        `[BlockTypeBlockRenderer] schema "${schema.name}" has no backing block; ` +
        `kernel/plugin schemas can't be lifted into a user-defined type yet.`,
      )
      return
    }
    if (propertyRefs.includes(blockId)) return
    await writeRefs([...propertyRefs, blockId])
  }, [propertyRefs, userSchemas, writeRefs])

  const handlePick = useCallback(async (args: AddPropertyArgs) => {
    if (args.adopted) {
      await appendSchema(args.adopted)
      return
    }
    // Inline create: same path AddPropertyForm uses.
    const created = await block.repo.userSchemas.addSchema({
      name: args.name,
      presetId: args.presetId,
    })
    await appendSchema(created)
  }, [appendSchema, block])

  // Glyph-click: register the schema if it doesn't exist, then return it
  // so PropertyPicker can adopt the result as a confirmed pick. No
  // side-panel open here — the user can navigate to the schema's block
  // on the Properties page if they want to tune presets/config.
  const handleConfigureNewSchema = useCallback(async (
    args: ConfigureNewSchemaArgs,
  ): Promise<AnyPropertySchema | undefined> => {
    const trimmed = args.name.trim()
    if (!trimmed) return undefined
    const existing = userSchemas.getSchemaForBlockId(
      userSchemas.getSchemaBlockId(trimmed) ?? '',
    )
    if (existing) return existing
    try {
      return await userSchemas.addSchema({name: trimmed, presetId: args.presetId})
    } catch (err) {
      console.error(`[BlockTypeBlockRenderer] failed to register schema "${trimmed}":`, err)
      return undefined
    }
  }, [userSchemas])

  const removeRef = useCallback(async (refId: string) => {
    await writeRefs(propertyRefs.filter(r => r !== refId))
  }, [propertyRefs, writeRefs])

  const [confirmDelete, setConfirmDelete] = useState(false)
  const performDelete = useCallback(async () => {
    await block.repo.mutate.delete({id: block.id})
  }, [block])

  if (!data || data.deleted) return null

  return (
    <div className="w-full space-y-2 py-1">
      <div className="flex items-center gap-2">
        <Input
          value={draftLabel}
          placeholder="type label"
          readOnly={readOnly}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setDraftLabel(e.target.value)}
          onBlur={() => { void writeLabel(draftLabel.trim()) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          className="h-8 max-w-md text-base font-semibold"
        />
      </div>

      <div className="grid grid-cols-[6rem,minmax(0,1fr)] items-start gap-3">
        <label className="pt-1 text-xs font-semibold text-muted-foreground">Description</label>
        <textarea
          value={draftDescription}
          placeholder="What is this type for?"
          readOnly={readOnly}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDraftDescription(e.target.value)}
          onBlur={() => { void writeDescription(draftDescription) }}
          className="min-h-[60px] w-full max-w-md rounded-md border border-input bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        />
      </div>

      <div className="grid grid-cols-[6rem,minmax(0,1fr)] items-start gap-3">
        <label className="pt-1 text-xs font-semibold text-muted-foreground">Properties</label>
        <div className="min-w-0 space-y-1">
          {resolvedEntries.map(entry => (
            <div
              key={entry.refId}
              className="flex items-center gap-2 rounded-md border border-input/60 bg-background px-2 py-1 text-sm"
            >
              {entry.schema ? (
                <>
                  <PropertyShapeGlyph
                    shape={entry.schema.codec.type}
                    Glyph={uis.get(entry.schema.name)?.Glyph ?? presets.get(entry.schema.codec.type)?.Glyph}
                    className="text-muted-foreground"
                  />
                  <span className="flex-1 truncate">{entry.schema.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {presets.get(entry.schema.codec.type)?.label ?? propertyShapeLabel(entry.schema.codec.type)}
                  </span>
                </>
              ) : (
                <span className="flex-1 truncate text-muted-foreground italic">
                  unresolved ref ({entry.refId.slice(0, 8)}…)
                </span>
              )}
              {!readOnly && (
                <button
                  type="button"
                  className="rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label="Remove property"
                  onClick={() => { void removeRef(entry.refId) }}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}

          {!readOnly && (
            <div className="flex items-center gap-2 pt-1">
              <PropertyPicker
                onAdd={handlePick}
                onConfigureNewSchema={handleConfigureNewSchema}
                excludedNames={excludedNames}
                placeholder="Add property"
              />
            </div>
          )}
        </div>
      </div>

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => {
              if (confirmDelete) {
                void performDelete()
                setConfirmDelete(false)
              } else {
                setConfirmDelete(true)
              }
            }}
          >
            {confirmDelete ? 'Really delete?' : 'Delete type'}
          </Button>
          {confirmDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
BlockTypeContentRenderer.displayName = 'BlockTypeContentRenderer'

/** Outer wrapper: keeps the default block layout (children,
 *  indentation, drag handle, focus chrome) and swaps in the
 *  type-editing content renderer. */
export const BlockTypeBlockRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={BlockTypeContentRenderer}
      EditContentRenderer={BlockTypeContentRenderer}
    />
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      // Mirrors PropertySchemaBlockRenderer.canRender — peek may be null
      // on the very first render; useRenderer will rerun once the block
      // hydrates.
      const data = block.peek()
      if (!data) return false
      const types = data.properties.types
      return Array.isArray(types) && types.includes('block-type')
    },
    priority: () => 100,
  },
)
BlockTypeBlockRenderer.displayName = 'BlockTypeBlockRenderer'
