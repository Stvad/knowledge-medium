import type { BlockRenderer, BlockRendererProps } from '@/types'
import { useHandle } from '@/hooks/block'
import { usePropertySchemas } from '@/hooks/propertySchemas'
import { propertyEditorOverridesFacet, valuePresetsFacet } from '@/data/facets'
import { findSchemaByFieldId, getPropertyFieldTargetId } from '@/data/propertyChildren'
import { useAppRuntime } from '@/extensions/runtimeContext'
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults'
import { PropertyShapeGlyph } from '@/components/propertyPanel/shapeUi'
import { DefaultBlockRenderer } from './DefaultBlockRenderer'
import { CodeMirrorContentRenderer } from './CodeMirrorContentRenderer'

const RawFieldValue = ({
  fieldId,
  content,
}: {
  fieldId: string
  content: string
}) => (
  <div
    className="tm-field-child flex min-w-0 items-center gap-2 py-0.5 text-sm"
    data-property-field-row="true"
    data-field-id={fieldId}
  >
    <span className="flex h-7 shrink-0 items-center rounded-sm bg-muted/60 px-1.5 text-xs font-medium text-muted-foreground">
      {fieldId}
    </span>
    <span className="min-w-0 truncate text-muted-foreground">{content}</span>
  </div>
)

const FieldContentRenderer: BlockRenderer = ({block}: BlockRendererProps) => {
  const data = useHandle(block, {
    selector: row => row
      ? {
        referenceTargetId: row.referenceTargetId,
        content: row.content,
        parentId: row.parentId,
      }
      : undefined,
  })
  const runtime = useAppRuntime()
  const schemas = usePropertySchemas()
  const uis = runtime.read(propertyEditorOverridesFacet)
  const presets = runtime.read(valuePresetsFacet)
  const fieldId = getPropertyFieldTargetId(data)
  const schema = fieldId
    ? findSchemaByFieldId(schemas, fieldId)
    : undefined

  if (!fieldId) return null
  if (!schema) {
    return <RawFieldValue fieldId={fieldId} content={data?.content ?? ''} />
  }

  const display = resolvePropertyDisplay({
    name: schema.name,
    encodedValue: undefined,
    schemas,
    uis,
    presets,
  })
  const label = uis.get(schema.name)?.label ?? schema.name

  return (
    <div
      className="tm-field-child grid min-w-0 grid-cols-[1.25rem_minmax(7rem,0.45fr)_minmax(10rem,1fr)] items-center gap-2 py-0.5 text-sm"
      data-property-field-row="true"
      data-property-name={schema.name}
      data-field-id={fieldId}
    >
      <span
        className="flex h-7 w-5 items-center justify-center text-fuchsia-500/80"
        title={display.shape}
      >
        <PropertyShapeGlyph shape={display.shape} Glyph={display.Glyph} />
      </span>
      <span className="min-w-0 truncate text-muted-foreground" title={schema.name}>
        {label}
      </span>
      <span className="min-w-0 truncate py-1 text-sm text-muted-foreground" title={fieldId}>
        {data?.content ?? ''}
      </span>
    </div>
  )
}

export const FieldBlockRenderer: BlockRenderer = (props) => (
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={FieldContentRenderer}
    EditContentRenderer={CodeMirrorContentRenderer}
  />
)

FieldBlockRenderer.canRender = ({block}) => {
  const data = block.peek()
  const fieldId = getPropertyFieldTargetId(data)
  return Boolean(fieldId && findSchemaByFieldId(block.repo.propertySchemas, fieldId))
}
FieldBlockRenderer.priority = () => 30
