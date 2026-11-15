import {fieldRowsFor} from '@/data/propertyRowCreation'
import {useIsFocalRender} from '@/hooks/useIsFocalRender'
import {useContext, useMemo, useState} from 'react'
import type {Block} from '@/data/block'
import {getBlockTypes, isCollapsedProp} from '@/data/properties'
import {useHandle, usePropertyDisplayMode, usePropertyValue} from '@/hooks/block'
import {usePropertySchemas} from '@/hooks/propertySchemas'
import {useTypes} from '@/hooks/typeRegistry'
import {PropertyDisplayScopeContext} from '@/context/propertyDisplay'
import {outlineSkippedFieldIds} from '@/data/propertyDefinitionRegistry'
import type {BlockRendererProps} from '@/types'
import {PropertyPlaceholder} from './PropertyPlaceholder'

/** This footer is the single placement for expected fields: after existing children. */
export function ExpectedPropertyRows({block}: BlockRendererProps) {
  const scope = useContext(PropertyDisplayScopeContext)
  const mode = usePropertyDisplayMode(block)
  const [collapsed] = usePropertyValue(block, isCollapsedProp)
  const focal = useIsFocalRender(block)
  const types = useHandle(block, {selector: row => row ? getBlockTypes(row) : []})
  if (!scope.childBacked || block.repo.isReadOnly || (collapsed && !focal) || mode === 'none' || !types.length) return null
  return <TypedExpectedFields owner={block} mode={mode} typeIds={types}/>
}

function TypedExpectedFields({owner, mode, typeIds}: {owner: Block; mode: 'all' | 'non-hidden'; typeIds: readonly string[]}) {
  const [activeGhost, setActiveGhost] = useState<string | null>(null)
  const schemas = usePropertySchemas()
  const types = useTypes()
  const data = useHandle(owner, {selector: row => row})
  const stored = useHandle(owner.repo.query.children({id: owner.id, propertyChildren: 'all'}), {selector: rows => rows})
  const registry = owner.repo.propertyDefinitions
  const skipped = useMemo(() => mode === 'non-hidden' && registry ? outlineSkippedFieldIds(registry) : null, [mode, registry])
  if (!data || !stored) return null
  const resolver = owner.repo.propertySchemaResolverFor(data.workspaceId)
  const seen = new Set<string>()
  return typeIds.flatMap(typeId => (types.get(typeId)?.properties ?? []).flatMap(declaration => {
    const active = schemas.get(declaration.name)
    if (!active) return []
    const result = resolver.resolve(active.name)
    if (result.status !== 'resolved') return []
    const schema = result.schema
    const excluded = seen.has(schema.fieldId) || skipped?.has(schema.fieldId)
    const alreadyStored = fieldRowsFor(stored, schema.fieldId).length > 0 || Object.hasOwn(data.properties, schema.name)
    if (excluded || (activeGhost !== schema.fieldId && alreadyStored)) return []
    seen.add(schema.fieldId)
    return [<div key={schema.fieldId} data-property-ghost="true" className="ml-6 grid grid-cols-[minmax(6rem,11rem)_minmax(0,1fr)] gap-3">
      <span className="text-sm text-muted-foreground">{schema.name}</span>
      <PropertyPlaceholder owner={owner} schema={schema} onActiveChange={active => setActiveGhost(current => active ? schema.fieldId : current === schema.fieldId ? null : current)}/>
    </div>]
  }))
}
