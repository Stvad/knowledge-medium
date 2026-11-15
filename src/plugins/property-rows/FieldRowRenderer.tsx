/** A property field arranges ordinary block content and children in columns. */
import {memberCodecOf} from '@/data/api'
import {isFieldValueChild} from '@/data/propertyChildren'
import {PropertyPlaceholder} from './PropertyPlaceholder'
import {useFocusWithin} from '@/hooks/focusedChild'
import {useBlockContext} from '@/context/block'
import type { BlockLayout, BlockLayoutContribution } from '@/extensions/blockInteraction'
import { BlockFrame, DefaultBlockLayout } from '@/components/renderer/DefaultBlockRenderer'
import { CollapsibleContent } from '@/components/ui/collapsible'
import { useHandle, usePropertyDisplayMode, usePropertyValue } from '@/hooks/block'
import { useContext } from 'react'
import { isCollapsedProp } from '@/data/properties'
import { PropertyFieldRowContext, PropertyRowListingContext } from '@/context/propertyDisplay'
import { drawsPropertyRows, useFieldRowDefinition, useIsChildOf } from './fieldRow'
import './FieldRowRenderer.css'

const PropertyFieldLayout: BlockLayout = ({
  block,
  Content, Properties, BelowContent, Children, Footer,
  Controls, Header,
  Shell,
}) => {
  const [isCollapsed] = usePropertyValue(block, isCollapsedProp)
  const focused = useFocusWithin(block, useBlockContext().renderScopeId) === true
  const definition = useFieldRowDefinition(block)
  const values = useHandle(block.repo.query.children({id: block.id, propertyChildren: 'all'}), {selector: rows => rows?.filter(isFieldValueChild)})
  const mode = usePropertyDisplayMode(block)
  const soleChildId = useHandle(block.repo.query.childIds({id: block.id, hydrate: true, propertyChildren: mode}), {
    selector: children => children?.length === 1 ? children[0] : null,
  })
  const childMode = usePropertyDisplayMode(block.repo.block(soleChildId ?? ''))
  const soleChildIsLeaf = useHandle(block.repo.query.childIds({
    id: soleChildId ?? '', hydrate: true, propertyChildren: childMode,
  }), {
    selector: childIds => soleChildId !== null && childIds?.length === 0,
  })

  return (
    <BlockFrame
      block={block} Header={Header} Shell={Shell} Controls={Controls}
      className="tm-property-field-row"
      frameProps={{
        'data-property-field-row': 'true',
        // Keep the control on collapsed rows so keyboard users can reopen them.
        'data-expanded-single-leaf': String((!isCollapsed || focused) && soleChildIsLeaf),
      }}
    >
      <div className="block-body relative min-w-0 flex-grow">
        <div data-property-row-layout="true" className="grid min-w-0 grid-cols-[minmax(6rem,11rem)_minmax(0,1fr)] items-start gap-3 rounded-sm border-b border-transparent hover:border-border/50">
          <div className="min-w-0" data-property-name-cell="true">
            <Content/>
          </div>
          <CollapsibleContent forceMount={focused || undefined} hidden={isCollapsed && !focused} className="min-w-0" data-property-value-cell="true">
            <PropertyFieldRowContext value={block.id}>
              <Children/>
              {!block.repo.isReadOnly && definition?.schema && values &&
                <PropertyPlaceholder owner={block.repo.block(block.peek()!.parentId!)} schema={definition.schema} fieldRowId={block.id} available={values.length === 0 || !!memberCodecOf(definition.schema.codec)}/>}
            </PropertyFieldRowContext>
          </CollapsibleContent>
        </div>
        {Properties && <Properties/>}
        <BelowContent/>
        <Footer/>
      </div>
    </BlockFrame>
  )
}

const FieldRowLayout: BlockLayout = props => {
  const definition = useFieldRowDefinition(props.block)
  const isListed = useIsChildOf(props.block, useContext(PropertyRowListingContext))
  const Layout = isListed && definition
    ? PropertyFieldLayout : DefaultBlockLayout
  return <Layout {...props}/>
}

export const fieldRowLayoutContribution: BlockLayoutContribution = context =>
  drawsPropertyRows(context.blockContext)
    ? {id: 'property-rows.field', label: 'Property row', render: FieldRowLayout}
    : null
