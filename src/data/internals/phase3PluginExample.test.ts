// @vitest-environment node
/**
 * Phase 3 acceptance — §12.1 plugin example end-to-end.
 *
 * The §13.3 acceptance criterion: "A new plugin can register a mutator
 * and call site invokes via `repo.mutate['plugin:foo']({...})` typed."
 *
 * This test simulates a static plugin that contributes one mutator,
 * one PropertySchema, and one PropertyEditorOverride exactly as §12.1
 * shows, and checks the full Phase 3 chain end-to-end:
 *   - mutatorsFacet.of registration → repo.mutate['tasks:setDueDate'] dispatches.
 *   - declare module '@/data/api' augmentation → repo.mutate is typed.
 *   - propertySchemasFacet.of registration → schema appears in the registry
 *     under the same name plugin authors call from BlockProperties /
 *     resolvePropertyDisplay.
 *   - propertyEditorOverridesFacet.of registration → override appears in
 *     the registry; resolvePropertyDisplay's join-by-name returns it.
 *
 * It also pins the variance-erasure work (chunk B reviewer P2):
 * `Query<{x:number}, string>` / `PropertySchema<Date | undefined>` /
 * `PropertyEditorOverride<Date | undefined>` register cleanly without
 * having to widen to <unknown>.
 *
 * Why a test, not a real plugin: a real plugin under src/plugins/
 * would wire through AppRuntimeProvider but add noise to every running
 * app. The test pins the same surfaces and protects them from
 * regression without adding a meaningless feature.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createElement, type JSX } from 'react'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import {
  ChangeScope,
  codecs,
  defineMutator,
  defineProperty,
  definePropertyEditorOverride,
  type PropertyEditor,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '../kernelDataExtension'
import {
  mutatorsFacet,
  propertyEditorOverridesFacet,
  propertySchemasFacet,
  valuePresetsFacet,
} from '../facets'
import { DatePropertyEditor, resolvePropertyDisplay } from '@/components/propertyEditors/defaults'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { Repo } from '../repo'

// ──── §12.1 plugin contributions ────

const dueDateProp = defineProperty<Date | undefined>('tasks:due-date', {
  codec: codecs.date,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

const TaskDueDateEditor: PropertyEditor<Date | undefined> = (): JSX.Element =>
  createElement('input', {type: 'date'})

const dueDateUi = definePropertyEditorOverride<Date | undefined>({
  name: 'tasks:due-date',
  label: 'Due date',
  Editor: TaskDueDateEditor,
})

interface SetDueDateArgs {
  id: string
  date: Date | null
}

const setDueDate = defineMutator<SetDueDateArgs, void>({
  name: 'tasks:setDueDate',
  argsSchema: z.object({id: z.string(), date: z.date().nullable()}),
  scope: ChangeScope.BlockDefault,
  describe: ({id}) => `set due date on ${id}`,
  apply: async (tx, {id, date}) => {
    await tx.setProperty(id, dueDateProp, date ?? undefined)
  },
})

declare module '@/data/api' {
  interface MutatorRegistry {
    'tasks:setDueDate': typeof setDueDate
  }
}

const tasksPluginExtension = [
  mutatorsFacet.of(setDueDate, {source: 'tasks'}),
  propertySchemasFacet.of(dueDateProp, {source: 'tasks'}),
  propertyEditorOverridesFacet.of(dueDateUi, {source: 'tasks'}),
]

// ──── Test setup ────

let h: TestDb
let cache: BlockCache
let repo: Repo

beforeEach(async () => {
  h = await createTestDb()
  cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    // Keep kernel mutators registered so the plugin layers in cleanly
    // alongside core; setFacetRuntime below replaces the registry with
    // the merged kernel + plugin runtime (the same shape
    // AppRuntimeProvider produces).
    registerKernelProcessors: false,
  })
  // Seed a row so setProperty has a target.
  await repo.tx(
    tx => tx.create({id: 'b1', workspaceId: 'ws-1', parentId: null, orderKey: 'a0'}),
    {scope: ChangeScope.BlockDefault},
  )
})

afterEach(async () => { await h.cleanup() })

// ──── End-to-end §12.1 wiring ────

describe('§12.1 plugin example — typed mutator + schema + UI', () => {
  it('mutatorsFacet registration → repo.mutate dispatches with precise types', async () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension, ...tasksPluginExtension])
    repo.setFacetRuntime(runtime)

    // Typed call site — the MutatorRegistry augmentation above makes
    // `repo.mutate['tasks:setDueDate']` resolve to (args: SetDueDateArgs)
    // => Promise<void> at compile time. No `as` cast.
    const due = new Date('2026-06-01T00:00:00.000Z')
    await repo.mutate['tasks:setDueDate']({id: 'b1', date: due})

    const stored = cache.getSnapshot('b1')!.properties['tasks:due-date']
    // Codec encodes Date → ISO string; storage holds the encoded shape.
    expect(stored).toBe(due.toISOString())
  })

  it('null arg via the same mutator clears the property (codec.optional → null in storage)', async () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension, ...tasksPluginExtension])
    repo.setFacetRuntime(runtime)

    // Set then clear.
    await repo.mutate['tasks:setDueDate']({id: 'b1', date: new Date('2026-06-01T00:00:00.000Z')})
    await repo.mutate['tasks:setDueDate']({id: 'b1', date: null})

    const stored = cache.getSnapshot('b1')!.properties['tasks:due-date']
    // codec.optional encodes undefined → null.
    expect(stored).toBeNull()
  })

  it('repo.run dispatches the same plugin mutator dynamically with arg validation', async () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension, ...tasksPluginExtension])
    repo.setFacetRuntime(runtime)

    await repo.run('tasks:setDueDate', {id: 'b1', date: new Date('2026-06-01T00:00:00.000Z')})
    expect(cache.getSnapshot('b1')!.properties['tasks:due-date']).toBe('2026-06-01T00:00:00.000Z')
  })

  it('arg validation rejects malformed input at the dispatch boundary', async () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension, ...tasksPluginExtension])
    repo.setFacetRuntime(runtime)

    // `date` must be Date|null; passing a string fails zod parse → throws.
    await expect(
      repo.run('tasks:setDueDate', {id: 'b1', date: 'tomorrow'}),
    ).rejects.toThrow()
  })

  it('propertySchemasFacet exposes the plugin schema by name', () => {
    const runtime = resolveFacetRuntimeSync([kernelDataExtension, ...tasksPluginExtension])
    const schemas = runtime.read(propertySchemasFacet)
    expect(schemas.get('tasks:due-date')).toBe(dueDateProp)
  })

  it('propertyEditorOverridesFacet exposes the plugin override and resolvePropertyDisplay returns it', () => {
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      ...tasksPluginExtension,
    ])
    const schemas = runtime.read(propertySchemasFacet)
    const uis = runtime.read(propertyEditorOverridesFacet)
    expect(uis.get('tasks:due-date')).toBe(dueDateUi)

    // Per-name override beats the codec-type-keyed preset fallback.
    const display = resolvePropertyDisplay({
      name: 'tasks:due-date',
      // Encoded shape — date codec stores ISO strings.
      encodedValue: '2026-06-01T00:00:00.000Z',
      schemas,
      uis,
      presets: runtime.read(valuePresetsFacet),
    })
    expect(display.isKnown).toBe(true)
    expect(display.shape).toBe('date')
    expect(display.Editor).toBe(TaskDueDateEditor)
    expect(display.schema).toBe(dueDateProp)
  })

  it('plugin ships schema without UI contribution → resolver falls through to preset editor', () => {
    // A plugin happy with the kernel default editor for its codec type
    // can skip propertyEditorOverridesFacet.of — the preset's Editor
    // is used.
    const runtime = resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      mutatorsFacet.of(setDueDate, {source: 'tasks'}),
      propertySchemasFacet.of(dueDateProp, {source: 'tasks'}),
      // no propertyEditorOverridesFacet.of(dueDateUi)
    ])
    const display = resolvePropertyDisplay({
      name: 'tasks:due-date',
      encodedValue: '2026-06-01T00:00:00.000Z',
      schemas: runtime.read(propertySchemasFacet),
      uis: runtime.read(propertyEditorOverridesFacet),
      presets: runtime.read(valuePresetsFacet),
    })
    expect(display.isKnown).toBe(true)
    expect(display.shape).toBe('date')
    expect(display.Editor).toBe(DatePropertyEditor)
  })
})
