import { useMemo } from 'react'
import type { BlockRenderer, BlockRendererProps } from '@/types'
import { useHandle } from '@/hooks/block'
import { usePropertySchemas } from '@/hooks/propertySchemas'
import { propertyEditorOverridesFacet, valuePresetsFacet } from '@/data/facets'
import { findSchemaByFieldId, propertyChildContentToEncodedValue } from '@/data/propertyChildren'
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
        fieldId: row.fieldId,
        content: row.content,
        parentId: row.parentId,
      }
      : undefined,
  })
  const runtime = useAppRuntime()
  const schemas = usePropertySchemas()
  const uis = runtime.read(propertyEditorOverridesFacet)
  const presets = runtime.read(valuePresetsFacet)
  const schema = data?.fieldId
    ? findSchemaByFieldId(schemas, data.fieldId)
    : undefined

  const decoded = useMemo(() => {
    if (!data || !schema) return null
    try {
      const encodedValue = propertyChildContentToEncodedValue(schema, data.content)
      return {
        decodeFailed: false,
        encodedValue,
        value: schema.codec.decode(encodedValue),
      }
    } catch {
      return {
        decodeFailed: true,
        encodedValue: data.content,
        value: data.content,
      }
    }
  }, [data, schema])

  if (!data?.fieldId) return null
  if (!schema || !decoded) {
    return <RawFieldValue fieldId={data.fieldId} content={data.content} />
  }

  const display = resolvePropertyDisplay({
    name: schema.name,
    encodedValue: decoded.encodedValue,
    schemas,
    uis,
    presets,
  })
  const parentBlock = data.parentId ? block.repo.block(data.parentId) : null
  const label = uis.get(schema.name)?.label ?? schema.name
  const Editor = display.Editor

  return (
    <div
      className="tm-field-child grid min-w-0 grid-cols-[1.25rem_minmax(7rem,0.45fr)_minmax(10rem,1fr)] items-center gap-2 py-0.5 text-sm"
      data-property-field-row="true"
      data-property-name={schema.name}
      data-field-id={data.fieldId}
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
      <span className="min-w-0" data-block-interaction="ignore">
        {Editor && !decoded.decodeFailed && parentBlock ? (
          <Editor
            value={decoded.value}
            onChange={(next: unknown) => {
              void parentBlock.set(display.schema, next).catch(err => {
                console.error(`[FieldBlockRenderer] failed to update ${schema.name}:`, err)
              })
            }}
            block={parentBlock}
            schema={display.schema}
          />
        ) : (
          <span
            className="block h-7 truncate py-1 text-sm text-muted-foreground"
            title={decoded.decodeFailed ? `Could not decode field value: ${data.content}` : data.content}
          >
            {data.content}
          </span>
        )}
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

FieldBlockRenderer.canRender = ({block}) => Boolean(block.peek()?.fieldId)
FieldBlockRenderer.priority = () => 30
