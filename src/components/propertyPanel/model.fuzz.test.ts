// @vitest-environment node
/**
 * Fuzz suite for `buildPropertyPanelModel` (./model.ts) over
 * `buildPropertyPanelSections` (../propertyPanelSections.ts). See
 * `src/test/fuzz.ts` for the smoke/deep tier mechanics and `docs/fuzzing.md`
 * for conventions.
 *
 * The panel is the only place a user can see — and so clean up — every value
 * stored on a block, including orphans with no definition and values hidden
 * by policy. Invariant, over generated property bags, schema sets, type
 * contributions (overlapping declarations, duplicate and unknown type ids)
 * and synthetic rows:
 *
 *  1. every stored property name appears in EXACTLY ONE set row across
 *     pinned rows, sections and the hidden section — never dropped, never
 *     shown twice;
 *  2. that row carries the stored encoded value verbatim;
 *  3. no row claims to be set for a name that is not stored (a synthetic or
 *     type-declared row for an absent name stays unset);
 *  4. a stored name is in the hidden section iff the visibility policy hides
 *     it (system names, UI-state scope, code-owned provenance markers).
 *
 * Oracle (4) is restated from the policy's documented clauses for the inputs
 * this generator can produce (no editor overrides or definition registry),
 * not called through `isPropertyPanelHiddenProperty`.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout } from '@/test/fuzz'
import {
  ChangeScope,
  codecs,
  defineProperty,
  type AnyPropertySchema,
  type TypeContribution,
} from '@/data/api'
import { seedKeyProp, seedRevisionProp, typesProp } from '@/data/properties'
import type { PropertyPanelRow } from '../propertyPanelSections'
import { buildPropertyPanelModel } from './model'

const PLAIN_NAMES = ['alpha', 'beta', 'gamma', 'delta'] as const
const UI_STATE_NAME = 'cursor'
const SYSTEM_NAME = 'system:internal'
const NAME_POOL = [
  ...PLAIN_NAMES, UI_STATE_NAME, SYSTEM_NAME, seedKeyProp.name, seedRevisionProp.name,
] as const

const schemaFor = (name: string): AnyPropertySchema =>
  name === seedKeyProp.name ? seedKeyProp
    : name === seedRevisionProp.name ? seedRevisionProp
    : defineProperty<string>(name, {
      codec: codecs.string,
      defaultValue: '',
      changeScope: name === UI_STATE_NAME ? ChangeScope.UiState : ChangeScope.BlockDefault,
    })

const TYPE_IDS = ['t1', 't2', 't3'] as const

const scenarioArb = fc.record({
  stored: fc.dictionary(fc.constantFrom(...NAME_POOL), fc.string({maxLength: 6}), {maxKeys: NAME_POOL.length}),
  // Types written on the block: duplicates and ids no contribution declares.
  blockTypes: fc.option(fc.array(fc.constantFrom(...TYPE_IDS, 'unregistered'), {maxLength: 4}), {nil: undefined}),
  known: fc.subarray([...NAME_POOL]),
  declarations: fc.array(
    fc.record({id: fc.constantFrom(...TYPE_IDS), names: fc.subarray([...NAME_POOL, typesProp.name])}),
    {maxLength: 4},
  ),
  synthetic: fc.subarray([...NAME_POOL]),
})

/** UI-state scope is a property of the SCHEMA, so an orphan value under that
 *  name (no schema) stays visible for cleanup. */
const isHiddenByPolicy = (name: string, schemas: ReadonlyMap<string, AnyPropertySchema>): boolean =>
  name.startsWith('system:') || (name === UI_STATE_NAME && schemas.has(name)) ||
  name === seedKeyProp.name || name === seedRevisionProp.name

describe('buildPropertyPanelModel — stored values stay visible', () => {
  it('shows every stored property exactly once, verbatim, in the section its visibility puts it in', () => {
    fc.assert(
      fc.property(scenarioArb, scenario => {
        const properties: Record<string, unknown> = {...scenario.stored}
        if (scenario.blockTypes) properties[typesProp.name] = typesProp.codec.encode(scenario.blockTypes)

        const schemas = new Map<string, AnyPropertySchema>([[typesProp.name, typesProp]])
        for (const name of scenario.known) schemas.set(name, schemaFor(name))
        const typesRegistry = new Map<string, TypeContribution>()
        for (const {id, names} of scenario.declarations) {
          // Declarations name schemas the registry may not know; the panel
          // resolves them against `schemas`.
          typesRegistry.set(id, {id, properties: names.map(n => n === typesProp.name ? typesProp : schemaFor(n))})
        }
        const syntheticRows: PropertyPanelRow[] = scenario.synthetic
          .map(name => ({name, encodedValue: undefined, isSet: false}))

        const model = buildPropertyPanelModel({
          blockId: 'block', workspaceId: 'ws', updatedAt: 0, updatedBy: 'user',
          properties, schemas, propertyDefinitions: null, typeDefinitions: null,
          uis: new Map(), presets: new Map(), typesRegistry, syntheticRows,
        })

        const visibleRows = [...model.pinnedRows, ...model.sections.flatMap(s => s.rows)]
        const hiddenRows = model.hiddenSection.rows
        const setRows = [...visibleRows, ...hiddenRows].filter(row => row.isSet)

        for (const [name, encoded] of Object.entries(properties)) {
          const matches = setRows.filter(row => row.name === name)
          expect(matches, `stored "${name}" set-row count`).toHaveLength(1)
          expect(matches[0]!.encodedValue).toBe(encoded)
          expect(hiddenRows.includes(matches[0]!), `"${name}" hidden placement`).toBe(isHiddenByPolicy(name, schemas))
        }
        for (const row of setRows) {
          // The pinned type-membership row is set whether or not the block
          // stores the property: it shows the block's (possibly empty) types.
          if (row.name === typesProp.name) continue
          expect(Object.hasOwn(properties, row.name), `"${row.name}" set but not stored`).toBe(true)
        }
      }),
      fuzzParams(300),
    )
  }, fuzzTestTimeout())
})
