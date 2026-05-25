/**
 * Property panel shell. The lookup chain/model lives in
 * `propertyPanel/model.ts`; row actions live in `propertyPanel/actions.ts`;
 * row/add/config UI lives under `propertyPanel/`.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Block } from '../data/block'
import { useBlockContext } from '@/context/block'
import { useChildIds, useHandle } from '@/hooks/block.js'
import { useUIStateBlock } from '@/data/globalState.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { usePropertySchemas } from '@/hooks/propertySchemas.js'
import { propertyEditorOverridesFacet, typesFacet, valuePresetsFacet } from '../data/facets.ts'
import {
  editorSelection,
  requestEditorFocus,
  focusBlock,
  topLevelBlockIdProp,
} from '@/data/properties.js'
import { Button } from './ui/button'
import { nextVisibleBlock } from '@/utils/selection.js'
import { focusAdjacentPropertyRow } from '@/utils/propertyNavigation.js'
import { useNavigate } from '@/utils/navigation.js'
import { AddPropertyForm } from './propertyPanel/AddPropertyForm'
import {
  addProperty,
  deleteProperty,
  renameProperty,
  writeProperty,
} from './propertyPanel/actions'
import {
  buildPropertyPanelModel,
  type PropertyPanelModelRow,
} from './propertyPanel/model'
import { PropertyRow } from './propertyPanel/PropertyRow'
import { MetadataRow, PropertySectionLabel } from './propertyPanel/Rows'

interface BlockPropertiesProps {
  block: Block
}

const EMPTY_PROPERTIES: Record<string, unknown> = {}

const hasOwn = (properties: Record<string, unknown>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(properties, name)

interface SyntheticPropertyRef {
  readonly blockId: string
  readonly name: string
}

export function BlockProperties({block}: BlockPropertiesProps) {
  const blockData = useHandle(block, {
    selector: data => data
      ? {
        id: data.id,
        content: data.content,
        properties: data.properties,
        updatedAt: data.updatedAt,
        updatedBy: data.updatedBy,
      }
      : undefined,
  })
  const childIds = useChildIds(block)
  const uiStateBlock = useUIStateBlock()
  const runtime = useAppRuntime()
  const {panelId} = useBlockContext()
  const navigate = useNavigate()
  const [showHiddenFields, setShowHiddenFields] = useState(false)
  const [syntheticProperties, setSyntheticProperties] = useState<readonly SyntheticPropertyRef[]>([])
  // Name of the property whose row was just materialised through the
  // optimistic-create path; cleared after a few seconds. The row renders
  // a "New schema" pill while the name is here, so the user notices that
  // a glyph click registered a schema rather than just opening a panel.
  const [recentlyMaterializedName, setRecentlyMaterializedName] = useState<string | null>(null)
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
  }, [])
  const flashRecent = (name: string) => {
    setRecentlyMaterializedName(name)
    if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => {
      setRecentlyMaterializedName(curr => curr === name ? null : curr)
      flashTimerRef.current = null
    }, 4000)
  }

  // FacetRuntime memoises combine() results, so these reads are identity-stable
  // across renders for the same runtime.
  const schemas = usePropertySchemas()
  const uis = runtime.read(propertyEditorOverridesFacet)
  const presets = runtime.read(valuePresetsFacet)
  const typesRegistry = runtime.read(typesFacet)
  const properties = blockData?.properties ?? EMPTY_PROPERTIES
  const readOnly = block.repo.isReadOnly
  const syntheticRows = useMemo(
    () => syntheticProperties
      .filter(ref =>
        ref.blockId === block.id
        && !hasOwn(properties, ref.name)
        && schemas.has(ref.name),
      )
      .map(ref => ({
        name: ref.name,
        encodedValue: undefined,
        isSet: false,
      })),
    [block.id, properties, schemas, syntheticProperties],
  )

  const model = useMemo(() => blockData
    ? buildPropertyPanelModel({
      blockId: blockData.id,
      updatedAt: blockData.updatedAt,
      updatedBy: blockData.updatedBy,
      properties,
      schemas,
      uis,
      presets,
      typesRegistry,
      syntheticRows,
    })
    : null,
  [blockData, presets, properties, schemas, syntheticRows, typesRegistry, uis])

  if (!blockData || !model) return null

  const focusBlockEditor = async (
    target: Block,
    selection: { start?: number; line?: 'first' | 'last'; x?: number },
  ) => {
    await uiStateBlock.set(editorSelection, {
      blockId: target.id,
      ...selection,
    })
    await focusBlock(uiStateBlock, target.id, {edit: true})
    requestEditorFocus(uiStateBlock)
  }

  const focusThisBlockContentEnd = async () => {
    const data = block.peek() ?? await block.load()
    await focusBlockEditor(block, {start: data?.content.length ?? 0})
  }

  const focusAfterProperties = async () => {
    const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
    if (!topLevelBlockId) return

    const next = await nextVisibleBlock(block, topLevelBlockId)
    if (!next) return
    await next.load()
    await focusBlockEditor(next, {start: 0})
  }

  const handlePropertyRowKeyDown = (
    event: KeyboardEvent<HTMLDivElement>,
    direction: -1 | 1,
  ) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return

    event.preventDefault()
    event.stopPropagation()

    const row = event.currentTarget
    if (focusAdjacentPropertyRow(block.id, row, direction)) return

    if (direction < 0) {
      void focusThisBlockContentEnd()
    } else {
      void focusAfterProperties()
    }
  }

  const openSchemaPanel = (schemaBlockId: string) => {
    navigate({blockId: schemaBlockId, target: 'new-panel', sourcePanelId: panelId})
  }

  const handleConfigure = async (row: PropertyPanelModelRow) => {
    // 1. User-defined schema → open its backing block in the side panel.
    const existingId = block.repo.userSchemas.getSchemaBlockId(row.name)
    if (existingId) {
      openSchemaPanel(existingId)
      return
    }
    // 2. Unregistered → optimistically materialize a user schema using
    //    the inferred type (`row.shape`) as the preset id, then open
    //    the new schema's block. Cmd-Z reverses the materialize.
    if (row.schemaUnknown) {
      try {
        await block.repo.userSchemas.addSchema({name: row.name, presetId: row.shape})
        const newId = block.repo.userSchemas.getSchemaBlockId(row.name)
        if (newId) {
          flashRecent(row.name)
          openSchemaPanel(newId)
        }
      } catch (err) {
        console.error(`[BlockProperties] failed to register schema for "${row.name}":`, err)
      }
      return
    }
    // 3. Kernel/plugin schemas have no per-instance config; the glyph
    //    button is rendered as `disabled` so this branch is unreachable
    //    via UI clicks. Defensive fallback only.
  }

  const renderPropertyRow = (sectionId: string, row: PropertyPanelModelRow) => {
    // canConfigure: user-data schema (block exists) OR unregistered
    // (will materialize on click). Kernel/plugin rows fall through and
    // get a disabled glyph button.
    const canConfigure = row.schemaUnknown
      || block.repo.userSchemas.getSchemaBlockId(row.name) !== undefined
    return (
      <PropertyRow
        key={`${sectionId}:${row.name}`}
        row={row}
        block={block}
        readOnly={readOnly}
        canConfigure={canConfigure}
        recentlyMaterialized={recentlyMaterializedName === row.name}
        onNavigate={handlePropertyRowKeyDown}
        onConfigure={() => void handleConfigure(row)}
        onChange={(next) => {
          void writeProperty(block, row.schema, next).then(() => {
            setSyntheticProperties(refs =>
              refs.filter(ref => ref.blockId !== block.id || ref.name !== row.name),
            )
          })
        }}
        onRename={(newName) => void renameProperty({
          block,
          properties,
          schemas,
          uis,
          oldName: row.name,
          newName,
        })}
        onDelete={() => void deleteProperty({
          block,
          properties,
          schemas,
          uis,
          name: row.name,
        })}
      />
    )
  }

  return (
    <div className={`tm-property-fields mt-1.5 max-w-[46rem] space-y-0.5 pb-1 pl-1 ${childIds.length ? 'mb-1' : ''}`}>
      {model.pinnedRows.length > 0 && (
        <div className="space-y-0.5">
          {model.pinnedRows.map(row => renderPropertyRow('pinned', row))}
        </div>
      )}

      {showHiddenFields && (
        <div className="space-y-0.5">
          <PropertySectionLabel section={model.hiddenSection} />
          {model.metadataRows.map(row => (
            <MetadataRow key={row.label} row={row} />
          ))}
          {model.hiddenSection.rows.map(row => renderPropertyRow(model.hiddenSection.id, row))}
        </div>
      )}

      {model.sections.map(section => (
        <div key={section.id} className="space-y-0.5" title={section.description}>
          {model.showSectionLabels && <PropertySectionLabel section={section} />}
          {section.rows.map(row => renderPropertyRow(section.id, row))}
        </div>
      ))}

      {!readOnly && (
        <AddPropertyForm
          key={block.id}
          block={block}
          onAdd={async (args) => {
            const schema = await addProperty(block, schemas, uis, args)
            if (!schema) return
            setSyntheticProperties(refs =>
              refs.some(ref => ref.blockId === block.id && ref.name === schema.name)
                ? refs
                : [...refs, {blockId: block.id, name: schema.name}],
            )
          }}
          onConfigureNewSchema={async ({name, presetId}) => {
            const trimmed = name.trim()
            if (!trimmed) return undefined
            const existingId = block.repo.userSchemas.getSchemaBlockId(trimmed)
            if (existingId) {
              openSchemaPanel(existingId)
              return schemas.get(trimmed)
            }
            // If a kernel/plugin schema already owns this name, adopt
            // it instead of creating a shadowing user schema. There's
            // no panel to open (kernel schemas have no block) but the
            // form still gets a schema back to submit with.
            const kernelSchema = schemas.get(trimmed)
            if (kernelSchema) return kernelSchema
            try {
              const schema = await block.repo.userSchemas.addSchema({
                name: trimmed,
                presetId,
              })
              const newId = block.repo.userSchemas.getSchemaBlockId(trimmed)
              if (newId) {
                flashRecent(trimmed)
                openSchemaPanel(newId)
              }
              return schema
            } catch (err) {
              console.error(`[BlockProperties] failed to register schema for "${trimmed}":`, err)
              return undefined
            }
          }}
        />
      )}

      <Button
        variant="ghost"
        size="sm"
        type="button"
        className="ml-5 h-7 w-fit gap-1 px-1.5 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => setShowHiddenFields(!showHiddenFields)}
      >
        {showHiddenFields ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        {showHiddenFields ? 'Hide hidden fields' : `Show hidden fields (${model.hiddenCount})`}
      </Button>
    </div>
  )
}
