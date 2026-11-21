import { ChangeScope } from '@/data/api'
import { seedProperty } from '@/data/propertySeeds'

/**
 * Shared ref-typed property seed for the references test suites
 * (parseReferences / recompute / merge-retarget). Single-sources the
 * `test:references/property/<name>` seedKey + `revision: 1` + default scope the
 * three suites previously hand-rolled per fixture, so a fixture used by more
 * than one suite (`reviewer`, `related`) has ONE definition of record.
 *
 * The seedKey is derived from `name`, so this can't express the deliberate
 * "same name, different definition" case (the schema-swap block's ref→string
 * `reviewer`) — that one stays an explicit `seedProperty` with its own seedKey.
 */
export const refTestSeed = <K extends 'ref' | 'refList'>(
  name: string,
  preset: K,
  changeScope: ChangeScope = ChangeScope.BlockDefault,
) =>
  seedProperty({
    seedKey: `test:references/property/${name}`,
    revision: 1,
    name,
    preset,
    changeScope,
  })
