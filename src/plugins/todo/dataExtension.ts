import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { roamTodoStateProp, statusProp, todoType } from './schema.ts'

export const todoDataExtension: AppExtension = [
  definitionSeedsFacet.of(statusProp, {source: 'todo'}),
  definitionSeedsFacet.of(roamTodoStateProp, {source: 'todo'}),
  typeSeedsFacet.of(todoType, {source: 'todo'}),
]
