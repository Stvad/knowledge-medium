import { useContext } from 'react'
import type { AnyPropertySchema } from '@/data/api'
import { referenceWarningMessage } from './referenceWarning'
import { propertyValueTargetTypes } from './valueSchema'
import { PropertyFieldRowContext, PropertyRowListingContext } from '@/context/propertyDisplay'
import type { BlockRenderer } from '@/types'
import type { Block } from '@/data/block'
import { FIELD_FORM_MARKER } from '@/data/referenceBlock'
import { encodedPropertyValueToChildContents, valueChildCodec, valueChildContentToEncoded } from '@/data/propertyChildren'
import { useAppRuntime } from '@/extensions/runtimeContext'
import { cachedContentDecorator, type BlockContentDecoratorContribution } from '@/extensions/blockInteraction'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer'
import { useHandle } from '@/hooks/block'
import { usePropertyEditingActivation } from '@/components/propertyPanel/usePropertyEditingActivation'
import { drawsPropertyRows, useFieldRowDefinition, isSingleValueProperty, useIsChildOf, usePropertyDefinitions } from './fieldRow'
import { resolvePropertyValueInlinePresentation } from './resolvePropertyValueInlinePresentation'

const ReferenceWarning = ({block, schema, targetId}: {block: Block; schema: AnyPropertySchema; targetId: string}) => {
  const warning = useHandle(block.repo.block(targetId), {selector: target => referenceWarningMessage(block, schema, target)})
  return warning ? <span data-reference-type-warning="true" aria-label={warning} title={warning}>⚠</span> : null
}

const InlineValue = ({block, Inner, schema}: {block: Block; Inner: BlockRenderer; schema: AnyPropertySchema | undefined}) => {
  const runtime = useAppRuntime()
  const definitions = usePropertyDefinitions(block.repo)
  const Editor = resolvePropertyValueInlinePresentation(runtime, definitions, schema)?.InlineEditor
  const data = useHandle(block, {selector: row => row ? {
    content: row.content, isFieldForm: row.isFieldForm, referenceTargetId: row.referenceTargetId,
  } : undefined})
  const focusHandlers = usePropertyEditingActivation(block)
  if (!data || data.isFieldForm || !schema) {
    return <Inner block={block}/>
  }
  let value: unknown
  try {
    value = valueChildCodec(schema).decode(valueChildContentToEncoded(schema, data))
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Value cannot be decoded'
    return <div className="flex min-w-0 items-center gap-1">
      <span data-invalid-property-value="true" aria-label="Invalid property value" title={reason}>⚠</span>
      <Inner block={block}/>
    </div>
  }
  const warning = typeof value === 'string' && value && propertyValueTargetTypes(schema).length > 0
    ? <ReferenceWarning block={block} schema={schema} targetId={value}/> : null
  if (!isSingleValueProperty(schema) || !Editor || Inner !== MarkdownContentRenderer) return warning
    ? <div className="flex min-w-0 items-center gap-1">{warning}<Inner block={block}/></div> : <Inner block={block}/>
  return (
    <div data-property-value-row="true" data-property-name={schema.name}
      onFocus={focusHandlers.onFocus} onBlur={focusHandlers.onBlur}>
      {warning}
      <Editor block={block} schema={schema} value={value} onChange={next => {
        const [content] = encodedPropertyValueToChildContents(schema, schema.codec.encode(next))
        void block.setContent(content)
      }}/>
    </div>
  )
}

const PropertyReadContent = ({block, Inner}: {block: Block; Inner: BlockRenderer}) => {
  const definition = useFieldRowDefinition(block)
  const isListed = useIsChildOf(block, useContext(PropertyRowListingContext))
  const field = useContext(PropertyFieldRowContext)
  const isValue = useIsChildOf(block, field?.id ?? null)
  if (isListed && definition && Inner === MarkdownContentRenderer) {
    return (
      <div data-property-definition-link="true" className="min-w-0 text-sm text-muted-foreground">
        <MarkdownContentRenderer block={block} contentTransform={content => content.trim().slice(FIELD_FORM_MARKER.length)}/>
      </div>
    )
  }
  return isValue ? <InlineValue block={block} Inner={Inner} schema={field?.schema}/> : <Inner block={block}/>
}

const decoratePropertyContent = cachedContentDecorator(PropertyReadContent, 'PropertyReadContent')

/** Read-side only: wrapping edit content would remount it when validity changes.
 * Controls specialize ordinary Markdown; validation retains the chosen renderer. */
export const propertyReadContentContribution: BlockContentDecoratorContribution = context =>
  drawsPropertyRows(context.blockContext)
    ? decoratePropertyContent
    : null
