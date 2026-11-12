/**
 * The outline's in-place property row (issue #1674, design doc §10): a FIELD
 * ROW renders as a two-column row — the property's name, linking to its
 * definition, beside its value — at its true position among the owner's
 * children. It is an ordinary block otherwise: its bullet, selection,
 * collapse and gestures are the default block's. Collapsing it hides the
 * value column; the value children (and anything nested under them) are its
 * children, rendered by `ValueRowRenderer`.
 */
import type { BlockRenderer, BlockRendererProps } from '@/types'
import type { BlockLayout } from '@/extensions/blockInteraction'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { BlockLink } from '@/components/references/BlockLink'
import { useAppHashInContext } from '@/context/layoutWsContext'
import { useIsSelected } from '@/data/globalState'
import { isCollapsedProp } from '@/data/properties'
import { useHandle, usePropertyValue } from '@/hooks/block'
import { usePropertySchemas } from '@/hooks/propertySchemas'
import { useIsFocalRender } from '@/hooks/useIsFocalRender'
import { useOpenBlock } from '@/utils/navigation'
import { useContext } from 'react'
import { PropertyFieldRowContext, PropertyRowListingContext } from '@/context/propertyDisplay'
import { drawsPropertyRows, fieldRowDefinition, useIsChildOf } from './fieldRow'

/** The name cell: the property's name as a link to its definition block. */
const FieldRowLabel: BlockRenderer = ({block}: BlockRendererProps) => {
  // Re-render when the registry moves (a rename, a definition arriving).
  usePropertySchemas()
  const data = useHandle(block, {
    selector: row => row
      ? {
        referenceTargetId: row.referenceTargetId,
        parentId: row.parentId,
        isFieldForm: row.isFieldForm,
        workspaceId: row.workspaceId,
      }
      : undefined,
  })
  const definition = fieldRowDefinition(block.repo, data)
  const workspaceId = data?.workspaceId ?? ''
  const fieldId = definition?.fieldId ?? ''
  const href = useAppHashInContext(workspaceId, fieldId)
  const openDefinition = useOpenBlock({blockId: fieldId, workspaceId})
  if (!definition) return null
  return (
    <BlockLink
      blockId={fieldId}
      workspaceId={workspaceId}
      href={href}
      onClick={openDefinition}
      className="block min-w-0 truncate rounded-sm py-0.5 text-sm text-muted-foreground no-underline hover:text-foreground"
      data-property-definition-link="true"
      title={`Open the ${definition.name} definition`}
    >
      {definition.name}
    </BlockLink>
  )
}
FieldRowLabel.displayName = 'FieldRowLabel'

const FieldRowLayout: BlockLayout = ({
  block,
  Content, Properties, BelowContent, Children, Footer,
  Controls, Header,
  Shell,
}) => {
  const isSelected = useIsSelected(block.id)
  const isTopLevel = useIsFocalRender(block)
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)
  return (
    <div>
      <Header/>
      <Shell>
        {(shellProps) => {
          const {className: shellClassName, ...collapsibleProps} = shellProps
          return (
            <Collapsible
              {...collapsibleProps}
              open={!isCollapsed || isTopLevel}
              data-property-field-row="true"
              className={`tm-block tm-property-field-row group/block relative flex items-start gap-1 outline-none focus:outline-none focus-visible:outline-none ${isTopLevel ? 'top-level-block' : ''} ${isSelected ? 'bg-accent/80' : ''} ${shellClassName ?? ''}`}
            >
              <Controls/>
              <div className="block-body relative min-w-0 flex-grow">
                <div className="grid min-w-0 grid-cols-[minmax(6rem,11rem)_minmax(0,1fr)] items-start gap-3 rounded-sm border-b border-transparent hover:border-border/50">
                  <div className="min-w-0" data-property-name-cell="true">
                    <Content/>
                  </div>
                  <CollapsibleContent className="min-w-0" data-property-value-cell="true">
                    <PropertyFieldRowContext value={block.id}>
                      <Children/>
                    </PropertyFieldRowContext>
                  </CollapsibleContent>
                </div>
                {Properties && <Properties/>}
                <BelowContent/>
                <Footer/>
              </div>
            </Collapsible>
          )
        }}
      </Shell>
    </div>
  )
}

export const FieldRowRenderer: BlockRenderer = (props: BlockRendererProps) => {
  return useIsChildOf(props.block, useContext(PropertyRowListingContext))
    ? <DefaultBlockRenderer
        {...props}
        ContentRenderer={FieldRowLabel}
        // Not the raw `::((id))` text: an Enter there makes a first value child
        // (the projection's new value) and a split or merge un-marks the row.
        EditContentRenderer={FieldRowLabel}
        Layout={FieldRowLayout}
      />
    // Not one of the rows of a listing that shows them (a backlink of its
    // definition, a hide-all listing): an ordinary block.
    : <DefaultBlockRenderer {...props}/>
}
FieldRowRenderer.displayName = 'FieldRowRenderer'
FieldRowRenderer.canRender = ({block, context}: BlockRendererProps): boolean =>
  drawsPropertyRows(context) && fieldRowDefinition(block.repo, block.peek()) !== undefined
// Above the type renderers (a field row carries no type of its own, but a
// hand-tagged one must still read as a property row).
FieldRowRenderer.priority = () => 150
