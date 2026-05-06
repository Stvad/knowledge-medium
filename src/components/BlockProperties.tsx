/**
 * Property panel shell. The lookup chain/model lives in
 * `propertyPanel/model.ts`; row actions live in `propertyPanel/actions.ts`;
 * row/add/config UI lives under `propertyPanel/`.
 */

import { useMemo, useState, type KeyboardEvent } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Block } from '../data/block'
import { useChildIds, useHandle } from '@/hooks/block.ts'
import { useUIStateBlock } from '@/data/globalState.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { usePropertySchemas } from '@/hooks/propertySchemas.ts'
import { propertyUiFacet, typesFacet } from '../data/facets.ts'
import {
  editorSelection,
  requestEditorFocus,
  setFocusedBlockId,
  setIsEditing,
  topLevelBlockIdProp,
} from '@/data/properties.ts'
import { Button } from './ui/button'
import { nextVisibleBlock } from '@/utils/selection.ts'
import { focusAdjacentPropertyRow } from '@/utils/propertyNavigation.ts'
import { AddPropertyForm } from './propertyPanel/AddPropertyForm'
import {
  addProperty,
  changeAdhocPropertyKind,
  deleteProperty,
  renameProperty,
  writeProperty,
} from './propertyPanel/actions'
import { FieldConfigSheet, type FieldConfig } from './propertyPanel/FieldConfigSheet'
import {
  ADDABLE_PROPERTY_KINDS,
  isAddablePropertyKind,
} from './propertyPanel/kinds'
import {
  buildPropertyPanelModel,
  type PropertyPanelModel,
  type PropertyPanelModelRow,
} from './propertyPanel/model'
import { PropertyRow } from './propertyPanel/PropertyRow'
import { MetadataRow, PropertySectionLabel } from './propertyPanel/Rows'

interface BlockPropertiesProps {
  block: Block
}

const EMPTY_PROPERTIES: Record<string, unknown> = {}

const findModelRow = (
  model: PropertyPanelModel,
  name: string,
): PropertyPanelModelRow | null => {
  for (const row of model.hiddenSection.rows) {
    if (row.name === name) return row
  }
  for (const section of model.sections) {
    for (const row of section.rows) {
      if (row.name === name) return row
    }
  }
  return null
}

const fieldConfigForRow = (
  row: PropertyPanelModelRow | null,
  panelReadOnly: boolean,
): FieldConfig | null => {
  if (!row) return null
  return {
    labelText: row.labelText,
    kind: row.kind,
    kindOptions: row.canChangeKind ? ADDABLE_PROPERTY_KINDS : [row.kind],
    schemaUnknown: row.schemaUnknown,
    decodeFailed: row.decodeFailed,
    readOnly: panelReadOnly || !row.canChangeKind,
  }
}

export function BlockProperties({block}: BlockPropertiesProps) {
  const blockData = useHandle(block, {
    selector: data => data
      ? {
        id: data.id,
        properties: data.properties,
        updatedAt: data.updatedAt,
        updatedBy: data.updatedBy,
      }
      : undefined,
  })
  const childIds = useChildIds(block)
  const uiStateBlock = useUIStateBlock()
  const runtime = useAppRuntime()
  const [showHiddenFields, setShowHiddenFields] = useState(false)
  const [activeConfigRowName, setActiveConfigRowName] = useState<string | null>(null)

  // FacetRuntime memoises combine() results, so these reads are identity-stable
  // across renders for the same runtime.
  const schemas = usePropertySchemas()
  const uis = runtime.read(propertyUiFacet)
  const typesRegistry = runtime.read(typesFacet)
  const properties = blockData?.properties ?? EMPTY_PROPERTIES
  const readOnly = block.repo.isReadOnly

  const model = useMemo(() => blockData
    ? buildPropertyPanelModel({
      blockId: blockData.id,
      updatedAt: blockData.updatedAt,
      updatedBy: blockData.updatedBy,
      properties,
      schemas,
      uis,
      typesRegistry,
    })
    : null,
  [blockData, properties, schemas, typesRegistry, uis])

  const activeConfigRow = useMemo(() => {
    if (!model || !activeConfigRowName) return null
    return findModelRow(model, activeConfigRowName)
  }, [activeConfigRowName, model])
  const activeFieldConfig = fieldConfigForRow(activeConfigRow, readOnly)

  if (!blockData || !model) return null

  const focusBlockEditor = async (
    target: Block,
    selection: { start?: number; line?: 'first' | 'last'; x?: number },
  ) => {
    await uiStateBlock.set(editorSelection, {
      blockId: target.id,
      ...selection,
    })
    setFocusedBlockId(uiStateBlock, target.id)
    setIsEditing(uiStateBlock, true)
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

  const renderPropertyRow = (sectionId: string, row: PropertyPanelModelRow) => (
    <PropertyRow
      key={`${sectionId}:${row.name}`}
      row={row}
      block={block}
      readOnly={readOnly}
      onNavigate={handlePropertyRowKeyDown}
      onConfigure={() => setActiveConfigRowName(row.name)}
      onChange={(next) => writeProperty(block, row.schema, next)}
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

  return (
    <div className={`tm-property-fields mt-1.5 max-w-[46rem] space-y-0.5 pb-1 pl-1 ${childIds.length ? 'mb-1' : ''}`}>
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
          blockId={block.id}
          onAdd={(name, kind) => addProperty(block, schemas, uis, name, kind)}
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

      <FieldConfigSheet
        field={activeFieldConfig}
        onKindChange={(kind) => {
          if (!activeConfigRow || !isAddablePropertyKind(kind)) return
          changeAdhocPropertyKind(block, schemas, uis, activeConfigRow.name, kind)
        }}
        onClose={() => setActiveConfigRowName(null)}
      />
    </div>
  )
}
