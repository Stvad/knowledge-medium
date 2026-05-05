# Tana-style type system

## Goal

Unify the ad-hoc `type` strings already in use (`extension`, `page`, `panel`, `journal`, `daily-note`) with the future need for user-modelable types (todo, task, project, person, note-with-fields...) under one principled abstraction. Types are facet contributions; a block can carry multiple types; named relationships ride on the existing references pipeline.

The first downstream consumer is **importing Roam todos**: `#TODO`/`#DONE` tags map to `types += 'todo'` + `status = 'open'/'done'` via the importer's tag-mapping table.

## Background — what already exists

These pieces are load-bearing and the design composes them, not replaces them:

- **`typeProp`** ([src/data/properties.ts:106](src/data/properties.ts:106)) — a `string | undefined` prop named `type`. Set today to `'extension'` (extension blocks, [exampleExtensions.ts:309](src/extensions/exampleExtensions.ts:309), [agent-runtime/commands.ts:189](src/plugins/agent-runtime/commands.ts:189)), `'page'` (Roam import + plan, [roamImport/import.ts:836](src/utils/roamImport/import.ts:836), [roamImport/plan.ts:562](src/utils/roamImport/plan.ts:562)), `'panel'` ([LayoutRenderer.tsx:74](src/components/renderer/LayoutRenderer.tsx:74), [:120](src/components/renderer/LayoutRenderer.tsx:120)), `'journal'` and `'daily-note'` ([dailyNotes.ts:86](src/data/dailyNotes.ts:86), [:159](src/data/dailyNotes.ts:159)).
- **`rendererProp`** ([src/data/properties.ts:113](src/data/properties.ts:113)) — explicit per-block renderer-id override. Read by [useRendererRegistry.tsx:22](src/hooks/useRendererRegistry.tsx:22).
- **`PropertySchema<T>`** ([src/data/api/propertySchema.ts:16](src/data/api/propertySchema.ts:16)) — typed property with codec, default, change-scope, and a `kind` for unknown-schema fallback.
- **`PropertyUiContribution<T>`** ([src/data/api/propertySchema.ts:33](src/data/api/propertySchema.ts:33)) — React `Editor` / `Renderer` joined to a schema by `name`. Already used by `grouped-backlinks` ([plugins/grouped-backlinks/index.ts:21](src/plugins/grouped-backlinks/index.ts:21)).
- **`propertySchemasFacet` / `propertyUiFacet`** ([src/data/facets.ts:114](src/data/facets.ts:114), [:131](src/data/facets.ts:131)) — registries keyed by `name`, last-wins on duplicates.
- **`blockRenderersFacet`** ([src/extensions/core.ts](src/extensions/core.ts)) — renderer registry with `id` + optional `aliases`; `BlockRenderer` supports `canRender` / `priority` for dynamic dispatch ([src/types.ts:65](src/types.ts:65)).
- **`BlockData.references: BlockReference[]`** ([src/data/api/blockData.ts:26](src/data/api/blockData.ts:26)) — content-derived (parsed from `[[alias]]` and `((uuid))`) by the `backlinks.parseReferences` post-commit processor ([src/plugins/backlinks/referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)). `BlockReference = { id, alias }` ([src/data/api/blockData.ts:4](src/data/api/blockData.ts:4)).
- **`AppExtension`** + facets — plugins contribute via `someFacet.of(contribution, {source})` ([video-player/index.ts](src/plugins/video-player/index.ts) is a good template).
- **`appEffectsFacet`** ([src/extensions/core.ts](src/extensions/core.ts)) — long-lived runtime effects with cleanup, used here for the data-defined-types watcher.

## Design

### 1. `typesFacet` — contributions, no imperative API

Add a new facet alongside the existing data-layer facets in `src/data/facets.ts`:

```ts
export interface TypeContribution {
  /** Stable id; matches the string written into the block's `types` array. */
  readonly id: string
  /** Properties that apply to blocks of this type. Drives field discovery
   *  in BlockProperties and the property panel. */
  readonly properties?: ReadonlyArray<PropertySchema<unknown>>
  /** Renderer id (looked up against blockRenderersFacet) used when a block
   *  is rendered solely by virtue of having this type. */
  readonly defaultRenderer?: string
  /** Type-conditional defaults applied at instance creation. Keys are
   *  property names, values are decoded values run through the matching
   *  schema's codec. */
  readonly defaults?: Readonly<Record<string, unknown>>
  /** Renderer dispatch priority when a block has multiple types.
   *  Higher wins. `rendererProp` always overrides everything. */
  readonly priority?: number
  /** Tana-style supertag aliases — extra strings that map to this type
   *  (importer convenience: `'task'` → `'todo'`). */
  readonly aliases?: ReadonlyArray<string>
  /** Optional human label for the property panel / quick-find. */
  readonly label?: string
}

export const typesFacet = defineFacet<TypeContribution, ReadonlyMap<string, TypeContribution>>({
  id: 'data.types',
  combine: (values) => {
    const out = new Map<string, TypeContribution>()
    for (const t of values) {
      if (out.has(t.id)) {
        console.warn(`[typesFacet] duplicate registration for "${t.id}"; last-wins per facet convention`)
      }
      out.set(t.id, t)
      for (const a of t.aliases ?? []) out.set(a, t)
    }
    return out
  },
  empty: () => new Map(),
})
```

No `defineType()` helper. Plugins contribute the same way as today: `typesFacet.of({id: 'todo', ...}, {source: 'todo-plugin'})`.

### 2. Multi-type: `typesProp` replaces `typeProp` as the primary discriminator

Add a new schema and migrate single-string usage to it. Per [feedback_no_backcompat_in_alpha](../.claude/projects/-Users-vlad-coding-knowledge-knowledge-medium-knowledge-medium/memory/feedback_no_backcompat_in_alpha.md), no shim — one-shot data migration, drop `typeProp` after.

```ts
// src/data/properties.ts
export const typesProp = defineProperty<readonly string[]>('types', {
  codec: codecs.list(codecs.string),
  defaultValue: [],
  changeScope: ChangeScope.Default,
  kind: 'list',
})
```

`KERNEL_PROPERTY_SCHEMAS` includes `typesProp`; `typeProp` is removed. All current writers ([dailyNotes.ts](src/data/dailyNotes.ts), [LayoutRenderer.tsx](src/components/renderer/LayoutRenderer.tsx), [roamImport/import.ts](src/utils/roamImport/import.ts), [roamImport/plan.ts](src/utils/roamImport/plan.ts), [initData.ts](src/initData.ts), [exampleExtensions.ts](src/extensions/exampleExtensions.ts), [agent-runtime/commands.ts](src/plugins/agent-runtime/commands.ts)) switch from `typeProp.codec.encode('foo')` / `tx.setProperty(id, typeProp, 'foo')` to `typesProp` writes.

A one-shot migration backfills existing rows: any block with `properties.type` writes `properties.types = [oldValue]` and clears `type`. Land it as a kernel `LocalSchemaBackfill` on `propertySchemasFacet` plumbing (same mechanism that already exists for kernel migrations — see [src/data/facets.ts:21](src/data/facets.ts:21) `LocalSchemaBackfill`).

### 3. Field reuse — props are global, type-conditional bits live on the type

Reuse `PropertySchema` as the field primitive. A type *curates* which props apply to its instances rather than namespacing fields. This matches how Roam works (`priority::` is `priority::` regardless of tags) and keeps the property registry as a single shared vocabulary.

The two pieces that *would* have wanted namespacing instead live on the type contribution:

- **Type-conditional defaults** → `TypeContribution.defaults`. A `todo`'s `status='open'` and a `meeting`'s `status='scheduled'` are declared by their respective types, not the prop schema.
- **Per-type ref-target hints** → carried on the type contribution alongside the property reference (see §5). The codec is a single shared `refList`; the *hint* of "for this type, the picker should suggest Task-typed targets" lives on the type.

If two types ever want a same-named field with **incompatible codecs**, the rule is to pick distinct names (`todoStatus` vs `meetingStatus`). Don't pre-pay for fully-namespaced fields.

### 4. Renderer dispatch — type-driven, `rendererProp` overrides

Update [src/hooks/useRendererRegistry.tsx](src/hooks/useRendererRegistry.tsx) so the resolution order becomes:

1. `rendererProp` set on the block → use that id verbatim.
2. Else read `typesProp`; for each id, look up the `TypeContribution` in `typesFacet`, collect each `defaultRenderer` with its `priority`. Highest-priority wins.
3. Else fall through to the existing `canRender` / `priority` dynamic-dispatch path on `blockRenderersFacet`.
4. Else default renderer.

Existing `aliases` on `RendererContribution` continues to work for renderer-id resolution (it's about the renderer registry, not types).

### 5. Ref codecs — `codecs.ref`, `codecs.refList`

Today's codec set ([src/data/api/codecs.ts:73](src/data/api/codecs.ts:73)) is `string, number, boolean, date, optional, list, unsafeIdentity`. Add:

```ts
// Storage: a string block id. The codec exists so the data layer can
// recognise ref-bearing properties without per-block scanning, and so
// editor lookup in propertyUiFacet can default to a ref picker.
export const ref: () => Codec<string>             // single ref (block id)
export const refList: () => Codec<readonly string[]>  // list of refs
```

Both are tagged so `isRefCodec(codec)` and `isRefListCodec(codec)` return true at runtime — the projector in §7 needs to identify them. Add a `kind: 'ref' | 'refList'` to `PropertyKind` in [propertySchema.ts:5](src/data/api/propertySchema.ts:5) so the unknown-schema fallback editor can render a stub picker.

Schemas declare ref properties like:

```ts
export const projectTasksProp = defineProperty<readonly string[]>('tasks', {
  codec: codecs.refList(),
  defaultValue: [],
  kind: 'refList',
  changeScope: ChangeScope.Default,
})
```

The *target-type filter* for the picker UI lives on the type contribution (because two types may share a ref-prop name with different target types):

```ts
typesFacet.of({
  id: 'project',
  properties: [projectTasksProp],
  refTargets: { tasks: ['task'] },   // picker filter for this type's `tasks`
  ...
})
```

`refTargets` is `Record<propertyName, readonly TypeId[]>` on `TypeContribution`. Empty/missing means any type.

### 6. Schema delta: `BlockReference.sourceField?: string`

The only structural data-shape change. `BlockReference` ([src/data/api/blockData.ts:4](src/data/api/blockData.ts:4)) gains an optional `sourceField`:

```ts
export interface BlockReference {
  readonly id: string
  readonly alias: string
  /** Property name that produced this reference. Absent when the
   *  reference was parsed from `content` (`[[alias]]` / `((uuid))`).
   *  Set when projected from a typed property whose codec is
   *  `ref`/`refList`. Drives named-backlinks (§7). */
  readonly sourceField?: string
}
```

No back-compat shim. Existing content-derived rows simply have `sourceField` undefined. SQL row encoding keeps the same JSON column; the field is optional in the JSON.

### 7. Extend `backlinks.parseReferences` to also project property refs

The existing post-commit processor ([src/plugins/backlinks/referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)) currently watches `{ kind: 'field', table: 'blocks', fields: ['content'] }` and rewrites `references[]` from parsed content. Extend it:

- Watch list expands to `fields: ['content', 'properties']`.
- After parsing content refs (existing path), iterate the block's `properties`. For each entry whose `PropertySchema.codec` is a ref-codec or ref-list codec (looked up via `propertySchemasFacet`), decode and emit one `BlockReference { id, alias: id, sourceField: propName }` per ref.
- Concatenate content-derived + property-derived into the new `references[]` and write through the same `tx.update(sourceId, {references}, {skipMetadata: true})`.

Ordering / dedupe: identical `(id, sourceField)` pairs are deduped; content refs (no `sourceField`) and property refs (with `sourceField`) coexist for the same target — they represent different relationships.

`grouped-backlinks` ([src/plugins/grouped-backlinks/](src/plugins/grouped-backlinks/)) gains a grouping mode keyed on `sourceField` so a target block sees:

> Referenced by `tasks` from: [Project A] [Project B]
> Referenced by `relatedTo` from: [Note X]
> Mentioned in: [Daily 2026-05-04] [Inbox]   ← content-derived (sourceField undefined)

### 8. Reactive typed-query primitive

The kernel today exposes per-block traversal + content-ref backlinks. To support typed inboxes / agendas / "all open todos" without per-consumer indexing, add a `Repo` query API:

```ts
interface TypedQuery {
  readonly types?: readonly string[]                    // any-of (multi-type contains-any)
  readonly where?: Readonly<Record<string, unknown>>    // equality on decoded property values
  readonly referencedBy?: { id: string; sourceField?: string }
}

// On Repo:
//   repo.queryBlocks(q): Promise<BlockData[]>
//   repo.subscribeBlocks(q, (rows) => ...): () => void
```

Implementation: an in-memory secondary index in the repo, maintained on commit, keyed by `(propertyName, primitiveValue) -> Set<blockId>` and `(targetId, sourceField) -> Set<sourceBlockId>`. The `references[]` reverse-index already needs to exist for backlinks; this generalises it.

**No PowerSync / Postgres changes.** `typesProp` is just another key in the existing JSON `properties` column; the `sourceField` addition lives inside the existing `references` JSON. Server-side filtered sync (don't pull all blocks, only types X and Y) is a separate, deferred decision.

A `useBlockQuery(q)` hook in `src/hooks/` wraps `subscribeBlocks` for components.

### 9. Data-defined types — `appEffect`, no new mechanism

Tana lets users define supertags from inside the graph. Mirror this with an effect that watches blocks of a known meta-type and contributes them to `typesFacet`:

- A built-in type contribution `{ id: 'type-definition', properties: [...] }` declares the schemas a type-definition block carries: `typeName: string`, `typeProperties: refList()` (refs to property-schema-definition blocks, for v1 just names), `defaultRenderer: string`, `priority: number`, `aliases: list<string>`, `defaults: object`.
- An `appEffect` (`typeDefinitionsEffect`) subscribes via `repo.subscribeBlocks({ types: ['type-definition'] })` and, on each change, projects every type-definition block into a `TypeContribution` and contributes it to `typesFacet` through the runtime's contribution sink — same pattern as `dynamicExtensions` ([src/extensions/dynamicExtensions.ts](src/extensions/dynamicExtensions.ts)).
- Hot-reload comes for free.

The "graduate to a code extension" path is a UI affordance later — convert a type-definition block into an `extension` block whose code calls `typesFacet.of(...)`.

For v1, the property-set carried by a data-defined type is by *name* (matched against existing schemas in `propertySchemasFacet`). Letting users define entirely new property schemas from data is a follow-up — needs a schema-definition block type and a parallel projector into `propertySchemasFacet`.

## Migration of existing `typeProp` users

Mechanical. Each replaces `typeProp` with `typesProp` (string array) and adds the matching `typesFacet.of({...})` contribution to its plugin or to the kernel data extension:

| Current `type=` value | Where set | Type contribution lives in |
|---|---|---|
| `extension` | [exampleExtensions.ts:309](src/extensions/exampleExtensions.ts:309), [agent-runtime/commands.ts:189](src/plugins/agent-runtime/commands.ts:189), [initData.ts:74](src/initData.ts:74) | `staticAppExtensions.ts` (kernel) |
| `page` | [roamImport/import.ts:836](src/utils/roamImport/import.ts:836), [roamImport/plan.ts:562](src/utils/roamImport/plan.ts:562) | kernel (`KERNEL_PROPERTY_SCHEMAS` neighbour) |
| `panel` | [LayoutRenderer.tsx:74](src/components/renderer/LayoutRenderer.tsx:74), [:120](src/components/renderer/LayoutRenderer.tsx:120) | kernel |
| `journal`, `daily-note` | [dailyNotes.ts:86](src/data/dailyNotes.ts:86), [:159](src/data/dailyNotes.ts:159) | kernel |
| (new) `todo` | importer + new todo plugin | new `src/plugins/todo/` |
| (new) `type-definition` | data-defined-types effect | kernel |

Per `KERNEL_PROPERTY_SCHEMAS` ([properties.ts:191](src/data/properties.ts:191)) convention, kernel-level type contributions live in a parallel `KERNEL_TYPE_CONTRIBUTIONS` array in `src/data/properties.ts`, registered by `kernelDataExtension`.

The Roam importer ([src/utils/roamImport/](src/utils/roamImport/)) gains a tag-mapping table:

```ts
const TAG_TO_TYPE: Record<string, { types: string[]; defaults?: Record<string, unknown> }> = {
  TODO: { types: ['todo'], defaults: { status: 'open' } },
  DONE: { types: ['todo'], defaults: { status: 'done' } },
}
```

When a Roam block has a `#TODO` tag, the importer pushes `'todo'` into `typesProp` and merges `defaults` into the block's properties. Stripping the `#TODO` from content vs. preserving it for round-trip is an importer policy decision — recommend stripping, since the type captures the meaning.

## Out of scope (explicit non-goals for v1)

- **Type inheritance** — `extends`. Revisit only if duplication shows up.
- **Computed / derived fields** — `dueIn = due - now()`. Needs an expression language.
- **Workflow rules** — "when status flips to done, set completedAt = now". A `typeRulesFacet` is the natural shape but defer.
- **Server-side filtered sync** based on types. Indexing is in-memory only.
- **Field namespacing** (Tana-style `Project.status` vs `Task.status`). Use distinct prop names when codecs would diverge.
- **User-defined property schemas from data**. v1 only lets data-defined types reference *existing* code-defined property schemas by name.
- **Required-field validation at edit time**. Type contributions can declare it as data, but enforcing at the editor is a follow-up.

## Phases

Each phase is independently shippable and testable.

### Phase 1 — `typesFacet` and field-reuse plumbing

1. Add `typesFacet` to [src/data/facets.ts](src/data/facets.ts).
2. Add `typesProp` schema to [src/data/properties.ts](src/data/properties.ts), include in `KERNEL_PROPERTY_SCHEMAS`.
3. Add `KERNEL_TYPE_CONTRIBUTIONS` for `'page'`, `'panel'`, `'journal'`, `'daily-note'`, `'extension'`. Each with `defaultRenderer` if applicable, `properties: []` for now (existing schemas already global).
4. One-shot data migration: backfill `properties.types = [oldType]` for every row with `properties.type`. Land as `LocalSchemaBackfill`.
5. Update every `typeProp` write site (table above) to write `typesProp` (push, not replace, when adding a type).
6. Update every `typeProp` read site to read `typesProp` and `.includes(value)` / `[0]`. Greps: `grep -rn "typeProp" src/`.
7. Remove `typeProp` from `KERNEL_PROPERTY_SCHEMAS` and from [properties.ts](src/data/properties.ts).

**Acceptance:** existing app behaviour unchanged. All current tests green. `repo` snapshots show `types: [...]` instead of `type:`.

### Phase 2 — type-driven renderer dispatch

1. Update [src/hooks/useRendererRegistry.tsx](src/hooks/useRendererRegistry.tsx) to consult `typesFacet` per §4.
2. Add `priority` to a few existing kernel type contributions so collisions resolve deterministically.

**Acceptance:** removing every explicit `rendererProp` from current code paths still renders correctly because the type drives dispatch.

### Phase 3 — ref codecs + named-backlinks

1. Add `codecs.ref()` / `codecs.refList()` to [src/data/api/codecs.ts](src/data/api/codecs.ts) with runtime `isRefCodec` / `isRefListCodec` predicates.
2. Add `kind: 'ref' | 'refList'` to `PropertyKind`.
3. Extend `BlockReference` with optional `sourceField`.
4. Extend `backlinks.parseReferences` ([src/plugins/backlinks/referencesProcessor.ts](src/plugins/backlinks/referencesProcessor.ts)) to also walk ref-typed properties; watch `properties` field too.
5. Add `sourceField`-aware grouping mode to [src/plugins/grouped-backlinks/](src/plugins/grouped-backlinks/).

**Acceptance:** a block with a ref-typed property pointing to another block surfaces in the target's grouped backlinks under the property name.

### Phase 4 — reactive typed-query primitive

1. Build the in-memory secondary index in `Repo` (or its data layer) maintained on commit.
2. Add `repo.queryBlocks` / `repo.subscribeBlocks` per §8.
3. Add `useBlockQuery` hook.

**Acceptance:** subscribing to `{ types: ['todo'] }` returns a live list that updates when a block is tagged/untagged.

### Phase 5 — data-defined types

1. Kernel contributes `'type-definition'` with the property set described in §9.
2. `typeDefinitionsEffect` watches and projects.
3. Minimal property panel UX so a user can fill in `typeName`, pick existing properties by name, etc.

**Acceptance:** creating a `type-definition` block in the UI causes a new type to show up in `typesFacet` and become assignable to other blocks within the same session.

### Phase 6 — Roam todo import (downstream consumer)

1. Add `TAG_TO_TYPE` map to importer.
2. Add `'todo'` type contribution (its own small plugin, `src/plugins/todo/`) with at minimum `statusProp` and a renderer.
3. On import, project tag → type + defaults.

**Acceptance:** importing a Roam graph with `#TODO`/`#DONE` blocks produces blocks with `types: ['todo']` and matching `status`, surfaced via the todo renderer and queryable via `useBlockQuery({types: ['todo'], where: {status: 'open'}})`.

## Open questions for the implementer

- **Index backing.** Phase 4's in-memory index is fine for moderate workspaces; if blocks-per-workspace grows past ~50k consider a SQLite-backed index in the local schema. Decide at implementation time based on real numbers; nothing about the public API should leak which one.
- **Where `KERNEL_TYPE_CONTRIBUTIONS` is registered.** `kernelDataExtension` is the natural home (matches `KERNEL_PROPERTY_SCHEMAS`). Confirm by reading the kernel-extension wire-up before adding.
- **Importer content stripping.** Whether to strip `#TODO` from content after mapping to `types`. Recommend strip; confirm with user once Phase 6 begins.
- **`type-definition`'s `typeProperties` codec.** v1 stores property *names* (a `list<string>`). If a richer schema-definition block lands later, this becomes a `refList` to schema-definition blocks; design Phase 5 so this widening doesn't break stored data.
