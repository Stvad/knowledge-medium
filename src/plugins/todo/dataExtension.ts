import { propertySchemasFacet, typesFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { roamTodoStateProp, todoType } from './schema.ts'

export const todoDataExtension: AppExtension = [
  propertySchemasFacet.of(roamTodoStateProp, {source: 'todo'}),
  typesFacet.of(todoType, {source: 'todo'}),
]

export default todoDataExtension
