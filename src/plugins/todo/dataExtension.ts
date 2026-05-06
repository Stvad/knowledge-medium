import { propertySchemasFacet, typesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { roamTodoStateProp, statusProp, todoType } from './schema.ts'

export const todoDataExtension: AppExtension = [
  propertySchemasFacet.of(statusProp, {source: 'todo'}),
  propertySchemasFacet.of(roamTodoStateProp, {source: 'todo'}),
  typesFacet.of(todoType, {source: 'todo'}),
]
