import type { BlockRenderer, BlockRendererProps } from '@/types'
import { useHandle } from '@/hooks/block'
import { usePropertySchemas } from '@/hooks/propertySchemas'
import { propertyEditorOverridesFacet, valuePresetsFacet } from '@/data/facets'
import { useIsSelected } from '@/data/globalState'
import {
  findSchemaByFieldId,
  getPropertyFieldTargetId,
  propertyChildContentToEncodedValue,
  propertyValueToChildContent,
} from '@/data/propertyChildren'
import { useAppRuntime } from '@/extensions/runtimeContext'
import type { BlockLayout } from '@/extensions/blockInteraction'
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults'
import { DefaultBlockRenderer } from './DefaultBlockRenderer'

const RawValue = ({
  content,
  title,
}: {
  content: string
  title?: string
}) => (
  <span
    className="block min-w-0 truncate py-1 text-sm text-muted-foreground"
    title={title ?? content}
  >
    {content}
  </span>
)

const PropertyValueContentRenderer: BlockRenderer = ({block}: BlockRendererProps) => {
  const valueData = useHandle(block, {
    selector: row => row
      ? {
        content: row.content,
        parentId: row.parentId,
      }
      : undefined,
  })
  const fieldBlock = valueData?.parentId ? block.repo.block(valueData.parentId) : block
  const fieldData = useHandle(fieldBlock, {
    selector: row => row
      ? {
        parentId: row.parentId,
        referenceTargetId: row.referenceTargetId,
      }
      : undefined,
  })
  const ownerBlock = fieldData?.parentId ? block.repo.block(fieldData.parentId) : block
  useHandle(ownerBlock, {selector: row => row?.id})

  const runtime = useAppRuntime()
  const schemas = usePropertySchemas()
  const uis = runtime.read(propertyEditorOverridesFacet)
  const presets = runtime.read(valuePresetsFacet)
  const fieldId = getPropertyFieldTargetId(fieldData)
  const schema = fieldId ? findSchemaByFieldId(schemas, fieldId) : undefined

  if (!valueData || !fieldId || !schema) {
    return <RawValue content={valueData?.content ?? ''} />
  }

  let encodedValue: unknown
  let value: unknown
  try {
    encodedValue = propertyChildContentToEncodedValue(schema, valueData.content)
    value = schema.codec.decode(encodedValue)
  } catch {
    return (
      <RawValue
        content={valueData.content}
        title={`Cannot decode ${schema.name} from value row content`}
      />
    )
  }

  const display = resolvePropertyDisplay({
    name: schema.name,
    encodedValue,
    schemas,
    uis,
    presets,
  })
  const Editor = display.Editor
  if (!Editor) return <RawValue content={valueData.content} />

  return (
    <div
      className="tm-property-value-row min-w-0 py-0.5"
      data-property-value-row="true"
      data-property-name={schema.name}
      data-field-id={fieldId}
    >
      <Editor
        value={value}
        schema={schema}
        block={ownerBlock}
        onChange={(next: unknown) => {
          if (block.repo.isReadOnly) return
          let content: string
          try {
            content = propertyValueToChildContent(schema, next)
          } catch (err) {
            console.warn(`[PropertyValueBlockRenderer] cannot encode ${schema.name}:`, err)
            return
          }
          void block.repo.tx(async tx => {
            await tx.update(block.id, {content})
          }, {
            scope: schema.changeScope,
            description: `set property value ${schema.name}`,
          }).catch(err => {
            console.warn(`[PropertyValueBlockRenderer] failed to update ${schema.name}:`, err)
          })
        }}
      />
    </div>
  )
}

PropertyValueContentRenderer.displayName = 'PropertyValueContentRenderer'

const PropertyValueBlockLayout: BlockLayout = ({
  block,
  Content,
  Properties,
  Children,
  Footer,
  Header,
  Shell,
}) => {
  const isSelected = useIsSelected(block.id)

  return (
    <div>
      <Header/>
      <Shell>
        {(shellProps) => {
          const {className: shellClassName, ...bodyProps} = shellProps
          return (
            <div
              {...bodyProps}
              className={`tm-property-value-block group/block relative min-w-0 outline-none focus:outline-none focus-visible:outline-none ${isSelected ? 'bg-accent/80' : ''} ${shellClassName ?? ''}`}
            >
              <Content/>
              {Properties && <Properties/>}
              <Children/>
              <Footer/>
            </div>
          )
        }}
      </Shell>
    </div>
  )
}

export const PropertyValueBlockRenderer: BlockRenderer = (props) => (
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={PropertyValueContentRenderer}
    EditContentRenderer={PropertyValueContentRenderer}
    LayoutRenderer={PropertyValueBlockLayout}
  />
)

PropertyValueBlockRenderer.canRender = ({block}) => {
  const data = block.peek()
  if (!data?.parentId) return false
  const parent = block.repo.cache.getSnapshot(data.parentId)
  const fieldId = getPropertyFieldTargetId(parent)
  return Boolean(fieldId && findSchemaByFieldId(block.repo.propertySchemas, fieldId))
}
PropertyValueBlockRenderer.priority = () => 30
