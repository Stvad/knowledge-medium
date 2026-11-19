import {memberCodecOf} from '@/data/api'
import { useContext, useEffect, useState } from 'react'
import type { AnyPropertySchema } from '@/data/api'
import { watchReferenceWarning } from './referenceWarning'
import { propertyValueTargetTypes } from './valueSchema'
import { PropertyFieldRowContext, PropertyRowListingContext } from '@/context/propertyDisplay'
import type { BlockRenderer } from '@/types'
import type { Block } from '@/data/block'
import { FIELD_FORM_MARKER } from '@/data/referenceBlock'
import { encodedPropertyValueToChildContents, valueChildContentToEncoded } from '@/data/propertyChildren'
import { resolveEditorOverride } from '@/data/propertyDefinitionRegistry'
import { propertyEditorOverridesFacet } from '@/data/facets'
import { readValuePresets } from '@/data/valuePresetRegistry'
import { useAppRuntime } from '@/extensions/runtimeContext'
import { cachedContentDecorator, type BlockContentDecoratorContribution } from '@/extensions/blockInteraction'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer'
import { useHandle } from '@/hooks/block'
import { usePropertyEditingActivation } from '@/components/propertyPanel/usePropertyEditingActivation'
import { drawsPropertyRows, useFieldRowDefinition, isSingleValueProperty, useIsChildOf, usePropertyDefinitions } from './fieldRow'

const ReferenceWarning = ({block, schema, content, targetId}: {block: Block; schema: AnyPropertySchema; content: string; targetId: string | null}) => {
  const [result, setResult] = useState<{content: string; targetId: string | null; warning: string | null}>()
  useEffect(() => watchReferenceWarning(block, schema, content, warning => setResult({content, targetId, warning}), targetId), [block, schema, content, targetId])
  const warning = result?.content === content && result.targetId === targetId ? result.warning : null
  return warning ? <span data-reference-type-warning="true" aria-label={warning} title={warning}>⚠</span> : null
}

const InlineValue = ({block, Inner, schema}: {block: Block; Inner: BlockRenderer; schema: AnyPropertySchema | undefined}) => {
  const runtime = useAppRuntime()
  const definitions = usePropertyDefinitions(block.repo)
  const data = useHandle(block, {selector: row => row ? {
    parentId: row.parentId, content: row.content, isFieldForm: row.isFieldForm, referenceTargetId: row.referenceTargetId,
  } : undefined})
  const override = schema && resolveEditorOverride(schema.name, definitions,
    runtime.read(propertyEditorOverridesFacet), schema)
  const Editor = override?.InlineEditor ?? (schema && readValuePresets(runtime).get(schema.codec.type)?.InlineEditor)
  const focusHandlers = usePropertyEditingActivation(block)
  if (!data || data.isFieldForm || !schema) {
    return <Inner block={block}/>
  }
  let value: unknown
  try {
    value = (memberCodecOf(schema.codec) ?? schema.codec).decode(valueChildContentToEncoded(schema, data))
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Value cannot be decoded'
    return <div className="flex min-w-0 items-center gap-1">
      <span data-invalid-property-value="true" aria-label="Invalid property value" title={reason}>⚠</span>
      <Inner block={block}/>
    </div>
  }
  const warning = propertyValueTargetTypes(schema).length > 0
    ? <ReferenceWarning block={block} schema={schema} content={data.content} targetId={data.referenceTargetId ?? null}/> : null
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
