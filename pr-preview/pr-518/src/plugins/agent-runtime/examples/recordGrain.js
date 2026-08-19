var e=`import { ChangeScope, propertyValue, seedProperty, seedType } from '@/data/api/index.js'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets.js'
import { extensionPropertySeedKey, extensionTypeSeedKey } from '@/extensions/dynamicExtensionSeeds.js'
import { createTypedChild } from '@/data/typedRecords.js'
import { TODO_TYPE, statusProp as todoStatusProp } from '@/plugins/todo/schema.js'
import type { Repo } from '@/data/repo.js'

const SET_TYPE = 'strength-set'          // namespaced: a bare \`set\` would collide

const weightProp = seedProperty({
  seedKey: extensionPropertySeedKey('set-weight'),
  revision: 1,
  name: 'strength:weight',               // namespaced too
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

// A pointer to another block is a REF, not a string: the target's
// backlinks then show every record that points at it.
const definitionProp = seedProperty({
  seedKey: extensionPropertySeedKey('definition'),
  revision: 1,
  name: 'strength:definition',
  preset: 'optional-ref',
  config: {targetTypes: ['strength-exercise-def']},
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const repsProp = seedProperty({
  seedKey: extensionPropertySeedKey('set-reps'),
  revision: 1,
  name: 'strength:reps',
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

const setType = seedType({
  seedKey: extensionTypeSeedKey('set'),
  revision: 1,
  id: SET_TYPE,
  label: 'Set',
  properties: [weightProp, repsProp, definitionProp],
})

export default [
  definitionSeedsFacet.of(weightProp, {source: 'strength'}),
  definitionSeedsFacet.of(repsProp, {source: 'strength'}),
  definitionSeedsFacet.of(definitionProp, {source: 'strength'}),
  typeSeedsFacet.of(setType, {source: 'strength'}),
]

interface LoggedSet {
  weight: number
  reps: number
  done: boolean
}

// One block per set — NOT a \`sets: [...]\` JSON property on the parent.
// Each set is queryable, referenceable, undoable, hand-editable.
export const logSets = async (
  repo: Repo,
  exerciseId: string,
  definitionId: string,
  sets: readonly LoggedSet[],
): Promise<void> => {
  await repo.tx(async tx => {
    const snapshot = repo.snapshotTypeRegistries()
    for (const set of sets) {
      await createTypedChild(repo, tx, {
        parentId: exerciseId,
        content: \`\${set.weight}lb × \${set.reps}\`,   // readable even without the extension
        types: [SET_TYPE, TODO_TYPE],                // compose: done-ness belongs to todo
        properties: [
          propertyValue(weightProp, set.weight),
          // \`reps\` is a scalar fact ABOUT the set, so it is a property. Left
          // only in the content string it would be a string-parse away from
          // any "how many reps last month" query.
          propertyValue(repsProp, set.reps),
          propertyValue(definitionProp, definitionId),
          propertyValue(todoStatusProp, set.done ? 'done' : 'open'),
        ],
        typeSnapshot: snapshot,
      })
    }
  }, {scope: ChangeScope.BlockDefault, description: 'Log sets'})
}
`;export{e as default};
//# sourceMappingURL=recordGrain.js.map