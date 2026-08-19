# Properties model evolution — projection helpers & possible children migration

> **Status:** partially superseded — last verified against code 2026-07-21. Thread 1 (ref-with-scalar projection) describes the ref-codec/projection model that shipped. Thread 2 (properties/types as block children) is superseded in part by the properties-as-blocks migration (#288 §6) and by the schema-unification project (`docs/schema-unification.html`), which landed through slice D: property **and** type definitions now live as blocks with code-owned `seedProperty`/`seedType` seed declarations, and the old static registration paths this doc's discussion assumed — `propertySchemasFacet`/`typesFacet` `.of(...)` plus the `mergeLiftedSchemas` type-lift — have been removed. Treat the storage-shape and registration claims here as a dated 2026-05-08 snapshot; CODE + `schema-unification.html` are authoritative.

Captures two related threads of design discussion: a near-term "ref with scalar projection" feature (scoped, useful on its own), and a deferred move toward Tana-style "properties are block children" (larger, conceptually attractive, not blocked on the near-term work). Conceptual; not an implementation plan. Written 2026-05-08.

## Where we are today

Properties live as a single `properties_json` TEXT column on `blocks` (one PowerSync-projected JSON blob per block). `PropertySchema` + codecs give typed sync reads via `block.get(schema)` / `block.set(schema, value)`. Cross-block queries hit `json_extract(properties_json, ...)`; for `types` specifically there's a denormalized `block_types` table maintained by the kernel mutators.

Key files: `src/data/blockSchema.ts`, `src/data/api/blockData.ts`, `src/data/api/propertySchema.ts`, `src/data/api/codecs.ts`, `src/data/block.ts`, `src/data/internals/kernelMutators.ts`, `powersync/sync-config.yaml`.

The relevant property of this layout for what follows: **reads are synchronous and free, writes funnel through one mutator layer, and the storage shape is hidden behind a codec abstraction.** That abstraction is what makes both threads below cheap to evolve into.

---

## Thread 1 — Ref with scalar projection (near-term, isolated)

### Problem

Some property values want to be *both* a ref and a scalar. The motivating case: a date field whose value is a ref to a daily-note page (so backlinks work, navigation works, "things on this day" works) **and** a date scalar (so sort/filter/"due this week" work).

The two storage choices we have today are both lossy:

- Store as scalar date → lose the ref. No backlink edge.
- Store as ref → opaque uuid. Reading the date requires loading the target page.

### Three cases hiding under "ref + projection"

The right design depends entirely on how the scalar can be derived from the ref:

| Case | Description | Cost |
|---|---|---|
| **1** | Projection is a pure function of the ref id | Codec only |
| **1.5** | Projection is determined at write time and never needs invalidation (the binding is immutable) | Codec + `{ref, value}` storage shape |
| **2** | Projection requires reading the target block, and the target's projected attribute can change | Codec + reverse-deps subsystem + invalidation |

### Where the date case lands

Initially I thought daily-page refs were case 1 — bijective `Date ↔ daily-page-id`. They're not, in this codebase: daily-page ids are `uuidv5(workspaceId, date)`, which is one-way. We can encode but not decode.

But: a daily page's *date is its identity*. Once a daily page exists, its date can't change without it becoming a different page. So we land in **case 1.5**: store both, project at write time, never invalidate.

Storage shape:

```json
{ "due": { "ref": "<uuidv5>", "date": "2025-12-13" } }
```

- **Encode (write, common path):** caller has a `Date` → codec computes `uuidv5(workspace, date)`, stores both.
- **Encode (write, "pick existing daily page" path):** codec receives a ref id, does a one-shot read of the target block to extract its date, then stores both. Async only at this entry point.
- **Decode (read):** codec returns `Date` directly from the cached `value`. Sync, fast.
- **Backlinks:** `ref` is the stored ref id; the graph layer sees it normally.
- **Invalidation:** none. Daily-page identity is immutable.

### Why this is worth building independently

- Self-contained: ~60–80 lines plus tests; no architecture commitments.
- Solves a concrete UX problem we'd otherwise patch around per call site.
- Establishes the `{ref, projected-value}` codec shape as a first-class option, which is the same shape case 2 will eventually need.
- Doesn't conflict with anything in thread 2 — codecs survive the eventual storage migration unchanged.

### What to flag in the codec design

The "immutability" assumption is load-bearing. Future you will be tempted to reuse this pattern for status labels, person display names, etc. — those are case 2, not case 1.5, and silently reusing the codec shape there will give you stale projections forever. Name the immutability requirement explicitly in the codec API so the failure mode is "doesn't compile / type-check" rather than "ships, drifts, debugged six months later".

---

## Thread 2 — Properties as block children (deferred, larger)

### Motivation

Tana-style "properties are children of their parent" gives you, conceptually:

- **Fields as first-class blocks.** Renamable, refable, queryable. No string-keyed schemas frozen in code.
- **Block-valued properties.** A property value can have its own children, formatting, refs — currently codecs squeeze everything into primitives.
- **Multi-value collapses with single-value.** `list` / `refList` codecs disappear; cardinality is "how many children with this field marker".
- **One less data model.** The codec/preset machinery and `properties_json` projection partially fold into existing block CRUD.

### What it costs

- **Hot reads regress.** Today `block.get('types')` is a memory hit on parsed JSON. Naïvely, properties-as-children means a child query per property access. Hot paths (`DefaultBlockRenderer` reading `types`, breadcrumbs reading title) feel this.
- **Children are lazy today.** Both `block.children` and `block.childIds` are `LoaderHandle`s — neither materializes with the parent (`src/data/block.ts:194`, `src/data/block.ts:203`). So "compute properties from children" is more expensive than just hydration; it's a per-edge subscription.
- **Type safety regresses unless reinvested.** Codecs don't disappear — they move from "encode primitive" to "extract scalar from a child block".
- **Defaults/required logic** needs a new home (probably on the field-defining block).
- **"Is content also a property?"** Tana unifies them; going halfway is awkward. Deciding to keep content separate cuts a lot of scope.

### Hot-read mitigation options surveyed

| Option | Idea | Verdict |
|---|---|---|
| **A. Cache on parent** | `properties_json` becomes a derived scalar projection of the field-tagged children. Children are source of truth. | **Selected.** Reads stay sync and free. Writes pay 2× DB ops. Cross-block queries unchanged. Has prior art in `block_types`. |
| B. In-memory derived index | Eagerly hydrate children, compute index in JS. | Forces eager hydration everywhere. Doesn't help cross-block queries. |
| C. Per-field reactive query | Every `block.get` becomes a child subscription. | Subscription explosion, async UI patterns, same cross-block-query problem. |
| **D. Hybrid system fields** | A small set of well-known fields (`types`, `title`, maybe `content`, `system:collapsed`) stays as cache-only system fields, never gets a child block. | **Selected as companion to A.** Honest about the asymmetry; matches what Tana-flavored systems do in practice. |
| E. SQL-side property-index table | A separate `block_properties` table maintained by triggers/mutators. | Possible later optimization, not needed in v1. |

**Chosen direction: A + D.** Cache stays on the parent; user-defined fields project their scalar value into the cache; system fields live cache-only. Reads are always sync; cross-block queries don't change.

### Dev UX of A + D

Call sites stay uniform — the asymmetry only shows up at schema-definition time and inside the mutator.

```ts
// System field — value lives in properties_json, no child block exists.
const collapsed = defineSystemField({ id: 'system:collapsed', codec: codecs.boolean })

// User field — backed by a field-defining block (renamable, refable).
const status = defineUserField({
  fieldBlockId: 'status-field-id',
  shape: 'scalar',
  codec: codecs.string,
})

// Block-valued user field — projection into cache is the child block id.
const note = defineUserField({ fieldBlockId: 'note-field-id', shape: 'block' })

// Reads (uniform — always sync, always from properties_json):
block.get(collapsed)  // boolean
block.get(status)     // string
block.get(note)       // Block facade (resolved via cached childId; .load() to read content)
```

Where the non-uniformity bites:

- **Schema authoring:** two builders (system vs user). Mildly annoying but reflects real semantics.
- **Field renaming:** only user fields support it.
- **Migrations:** promoting a system field to a user field is a real migration. Demoting is rare. Fine while in alpha.
- **Querying:** unchanged — both are `json_extract` against the cache.
- **Sync:** user fields ship parent + child rows. Slightly redundant on the wire; PowerSync handles it.

### Cache projection — what gets projected

The cache stores the field's *denoted value*, never the subtree under that value:

| Field shape | Field-value child looks like | Projection in `properties_json` |
|---|---|---|
| Scalar (text, number, date, url, ref) | child whose content encodes the value | the encoded scalar |
| Multi-value | N field-tagged children | array of per-child projections |
| Block-valued | child with rich content/subtree | `{childId}` only |

This rule is load-bearing: **mutations deep in a subtree don't invalidate the cache** — only edits to the field-value child's own content/`field_id`/`parent_id`/`deleted` do. That's what keeps the consistency story tractable. It also means "is a property" stops being a passive query result and becomes a stateful relationship with explicit set/clear mutators.

### Consistency story (the cases that need to stay in sync)

1. Direct property write
2. Child created already-tagged
3. Untagged child → tagged (user converts content to a field-value)
4. Tagged child → untagged
5. Tagged child's content edited
6. Tagged child deleted
7. Tagged child re-parented (drop from old parent, add to new)
8. Remote sync apply (handled by atomic local write at origin)

All eight reduce to: *any mutation to a row where `field_id IS NOT NULL` (before or after) must also patch the relevant parent's `properties_json` in the same transaction.* Implementable as a single helper invoked from the tail of each mutator. The kernel is already the only path to writes, so there's no back-door SQL write to worry about.

A SQLite trigger as a safety net is possible — preferably **invalidate-only** (set a `properties_dirty` flag, recompute in TS) rather than encoding projection logic in SQL twice. Skip in v1; add if drift is observed.

Computed/aggregated fields ("count of done sub-bullets", "concat of all children") are explicitly **out of scope** for the property model. They're queries, and trying to make `properties_json` carry subtree-derived values rebuilds a reactive query engine inside the cache. Different system.

---

## Structural overlap between the two threads

Both threads need the same primitive: **a parent block's `properties_json` carries data derived from somewhere else, and writes to that "somewhere else" need to update the cache.**

- Thread 1 case 2 (the part we're not building yet): target-block-derived projection.
- Thread 2 cache: field-tagged-child-derived projection.

If thread 1 ever needs case 2 and thread 2 ever ships, they share a reverse-deps mechanism. Don't build that infrastructure speculatively for either — wait until a concrete case forces it. They'll converge naturally.

---

## Decisions

### Now
- Build `codecs.dateRef` (or whichever name) along the case-1.5 design above. Self-contained, useful, no architecture lock-in.

### Defer
- The full properties-as-children migration. Honest estimate is ~1–2 weeks when we do it later vs. ~1.5–3 weeks all-at-once now — the alpha posture and the existing codec abstraction make this an additive change rather than a rewrite. The expensive part is the design thinking, which this doc captures.

### Lock-in risks to actively avoid in the meantime

These are the things that would make a later migration genuinely painful:

1. **Don't let `properties_json` shape leak into user-facing surfaces.** No serialized JSON paths exposed in saved queries or user data. Query authoring stays above storage.
2. **Don't add ETL/import paths that write `properties_json` directly.** Route everything through `tx.setProperty`.
3. **Don't treat property-key strings as stable identifiers across renames or exports.** Field-block-id identity comes later; don't pre-bake the string-key assumption into externalized data.
4. **Don't model rich/structured data as stringified-JSON inside a property.** If something genuinely wants to be block-valued, either keep it as a child block out of the property system, or wait for `shape: 'block'` user fields. Migrating *code* later is easy; migrating *encoded user content* out of stringified blobs is the painful kind of migration.

None of these are hard to follow given current patterns.

---

## Honest caveats

- "Tana-style" here is a conceptual reference to Tana's surface model (fields as first-class, properties as children). We have no ground-truth view of Tana's storage internals; specific claims about how Tana caches or indexes are inference, not fact. The design above is justified by *our* read/query workload, not by appeals to what Tana does.
- The A + D plan assumes scalar projections are the common case. If users start wanting block-valued fields routinely, the cache buys less and the asymmetry between scalar and block-valued reads becomes more visible. That'd be a signal to revisit, not a problem at the start.
