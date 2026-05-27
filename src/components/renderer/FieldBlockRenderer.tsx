import type { BlockRenderer, BlockRendererProps } from '@/types'
import { useChildIds, useHandle, usePropertyValue } from '@/hooks/block'
import { usePropertySchemas } from '@/hooks/propertySchemas'
import { propertyEditorOverridesFacet, valuePresetsFacet } from '@/data/facets'
import {
  findSchemaByFieldId,
  getPropertyFieldTargetId,
  propertyValueToChildContent,
} from '@/data/propertyChildren'
import { isCollapsedProp } from '@/data/properties'
import { useAppRuntime } from '@/extensions/runtimeContext'
import type { BlockLayout } from '@/extensions/blockInteraction'
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults'
import { PropertyShapeGlyph } from '@/components/propertyPanel/shapeUi'
import { useIsSelected } from '@/data/globalState'
import { useIsFocalRender } from '@/hooks/useIsFocalRender'
import { buildAppHash } from '@/utils/routing'
import { useOpenBlock } from '@/utils/navigation'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { keyAtStart } from '@/data/orderKey'
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
        workspaceId: row.workspaceId,
      }
      : undefined,
  })
  const runtime = useAppRuntime()
  const schemas = usePropertySchemas()
  const uis = runtime.read(propertyEditorOverridesFacet)
  const presets = runtime.read(valuePresetsFacet)
  const fieldId = getPropertyFieldTargetId(data)
  const workspaceId = data?.workspaceId ?? block.repo.activeWorkspaceId ?? ''
  const openDefinition = useOpenBlock({blockId: fieldId ?? '', workspaceId})
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
      className="tm-field-child grid min-w-0 grid-cols-[1.25rem_minmax(7rem,1fr)] items-center gap-2 py-0.5 text-sm"
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
      <a
        href={workspaceId ? buildAppHash(workspaceId, fieldId) : '#'}
        className="min-w-0 truncate rounded-sm text-muted-foreground no-underline hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-property-definition-link="true"
        title={`Open ${label} definition`}
        onClick={workspaceId ? openDefinition : undefined}
      >
        {label}
      </a>
    </div>
  )
}

const FieldEmptyValueEditor = ({block}: {block: BlockRendererProps['block']}) => {
  const childIds = useChildIds(block)
  const data = useHandle(block, {
    selector: row => row
      ? {
        referenceTargetId: row.referenceTargetId,
        parentId: row.parentId,
        workspaceId: row.workspaceId,
      }
      : undefined,
  })
  const ownerBlock = data?.parentId ? block.repo.block(data.parentId) : block
  useHandle(ownerBlock, {selector: row => row?.id})

  const runtime = useAppRuntime()
  const schemas = usePropertySchemas()
  const uis = runtime.read(propertyEditorOverridesFacet)
  const presets = runtime.read(valuePresetsFacet)
  const fieldId = getPropertyFieldTargetId(data)
  const schema = fieldId ? findSchemaByFieldId(schemas, fieldId) : undefined

  if (childIds.length > 0 || !data || !schema) return null

  const display = resolvePropertyDisplay({
    name: schema.name,
    encodedValue: undefined,
    schemas,
    uis,
    presets,
  })
  const Editor = display.Editor
  if (!Editor) return null

  return (
    <div
      className="tm-property-empty-value-row min-w-0 py-0.5"
      data-property-empty-value-row="true"
      data-property-name={schema.name}
      data-field-id={fieldId}
    >
      <Editor
        value={schema.defaultValue}
        schema={schema}
        block={ownerBlock}
        onChange={(next: unknown) => {
          if (block.repo.isReadOnly) return
          let content: string
          try {
            content = propertyValueToChildContent(schema, next)
          } catch (err) {
            console.warn(`[FieldBlockRenderer] cannot encode ${schema.name}:`, err)
            return
          }
          void block.repo.tx(async tx => {
            await tx.create({
              workspaceId: data.workspaceId,
              parentId: block.id,
              orderKey: keyAtStart(null),
              content,
            })
          }, {
            scope: schema.changeScope,
            description: `set empty property value ${schema.name}`,
          }).catch(err => {
            console.warn(`[FieldBlockRenderer] failed to set ${schema.name}:`, err)
          })
        }}
      />
    </div>
  )
}

const FieldBlockLayout: BlockLayout = ({
  block,
  Content,
  Properties,
  Children,
  Footer,
  Controls,
  Header,
  shellProps,
}) => {
  const isSelected = useIsSelected(block.id)
  const isTopLevel = useIsFocalRender(block)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)
  const {className: shellClassName, ...collapsibleProps} = shellProps

  return (
    <div>
      <Header/>

      <Collapsible
        {...collapsibleProps}
        open={!isCollapsed || isTopLevel}
        data-property-field-table-row="true"
        className={`tm-block tm-field-table-row group/block relative flex items-start gap-1 outline-none focus:outline-none focus-visible:outline-none ${isTopLevel ? 'top-level-block' : ''} ${isSelected ? 'bg-accent/80' : ''} ${shellClassName ?? ''}`}
      >
        <Controls/>

        <div className="block-body relative min-w-0 flex-grow">
          <div className="tm-field-table-grid grid min-w-0 grid-cols-[minmax(9rem,13rem)_minmax(0,1fr)] items-start gap-3 rounded-sm border-b border-transparent py-0.5 hover:border-border/50">
            <div className="tm-field-name-cell min-w-0">
              <Content/>
            </div>
            <CollapsibleContent className="tm-field-value-cell min-w-0">
              <Children/>
              <FieldEmptyValueEditor block={block}/>
            </CollapsibleContent>
          </div>

          {Properties && <Properties/>}
          <Footer/>
        </div>
      </Collapsible>
    </div>
  )
}

export const FieldBlockRenderer: BlockRenderer = (props) => (
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={FieldContentRenderer}
    EditContentRenderer={CodeMirrorContentRenderer}
    LayoutRenderer={FieldBlockLayout}
  />
)

FieldBlockRenderer.canRender = ({block}) => {
  const data = block.peek()
  const fieldId = getPropertyFieldTargetId(data)
  return Boolean(fieldId && findSchemaByFieldId(block.repo.propertySchemas, fieldId))
}
FieldBlockRenderer.priority = () => 30
