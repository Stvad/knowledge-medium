# Contract: derived data is add-only / retain-on-source

**Status:** active · **Issue:** [#203](https://github.com/Stvad/knowledge-medium/issues/203)
· **Audit:** `docs/correctness-audit-2026-06-18.md` (B1, A6) ·
**Design context:** `docs/data-integrity-defense.html`

## What "derived data" means here

Data we **recompute from a source and store back**, rather than data a user
types directly:

- backlinks / `references_json` — projected from a block's content (`[[..]]`,
  `((..))`, `#[[..]]`) and from its ref-typed property values;
- SRS scheduling fields derived from a grade + prior state (see the non-goal
  below — that path is the *dual* problem and out of scope here).

The source of truth is the **input** (content, property value). The derived
column is a cache of a pure function of that input.

## The hazard

Every derive path is **recompute-then-replace-write**: read the source, compute
the full derived set, write it over the column. That's correct only when the
recompute is *complete*. It is not complete when:

- a **deriver is absent** — the property's schema/plugin is toggled off, in
  `?safeMode`, or not yet loaded, so the value can't be decoded to refs;
- an input **partially fails to decode** — one malformed element in a `refList`
  used to throw the whole decode;
- it runs during **undo/redo replay**, which is supposed to restore an *exact*
  prior value, not re-derive over it.

In every case a *partial or empty* recompute replace-written over the column
**silently deletes** derived data the source still implies. Incidents:

- the historical **~10k `next-review-date` backlink wipe** — SRS toggled off ⇒
  schema absent ⇒ projection contributed nothing ⇒ column replaced with `[]`,
  fleet-wide;
- **#189** — one non-string element in a `refList` threw the whole decode ⇒ the
  field's backlinks replaced with `[]` on the next unrelated edit;
- **#187** — undo replay re-derives over the restored value (latent: no live
  non-idempotent same-tx processor today).

## The contract

> A recompute may drop a derived element for source-key **K** **only if** K's
> source value genuinely changed **and** the drop is the result of a
> *successful* re-derive of K.
>
> It must **never** drop because the deriver was absent, because the recompute
> partially failed, or because it ran on a replay. For any source key that is
> **present and unchanged**, the derived set never shrinks.

This is **conditional monotonicity**, not pure grow-only: a real value-driven
removal (you delete a `[[ref]]`, the backlink goes) is still allowed and
expected. What's forbidden is removal as a *side effect* of an incomplete
recompute.

## How it's encoded

Two enforcement points cover the **absent-deriver** and **partial-decode**
failure modes. The **replay** mode is a separate, still-open concern — see "Not
enforced here" below.

### 1. Decode element-wise (never throw away the recoverable part)

`refList` decoding for projection is **lenient and element-wise**: a malformed
element drops only itself, and a wrong-shape value yields `[]` instead of
throwing (a throw aborts the whole block's projection — the original escalation
from one-bad-element to whole-field strip).

- `RefListCodec.decodeValid` + `decodeRefListIds` — `src/data/api/codecs.ts`
- the two projection entry points route refList values through `decodeRefListIds`:
  `projectPropertyReferences` (`src/plugins/references/referenceProjection.ts`)
  and `projectedRefsForField` (`src/data/internals/refProjection.ts`).

### 2. Reconcile on write (retain what you couldn't re-derive)

The backlink-deriving sites assemble their write through one chokepoint,
`reconcileDerived` (`src/data/api/derivedData.ts`). It returns the freshly
recomputed set **plus** any prior element the recompute didn't reproduce and
that a `retain` predicate keeps — so an absent deriver retains rather than
deletes. Consumers today:

- **reprojection** (`src/data/repo.ts`) — pure add-only (default retain-all):
  it fires on a *schema* change while block values are static, so recompute can
  only add; removal is left to the lazy per-block path.
- **references processor** (`src/plugins/references/referencesProcessor.ts`) —
  recompute is authoritative for content + present-schema refs, but
  `isRetainableAbsentRef` retains a prior ref whose schema is absent and whose
  value is unchanged.
- **roam importer** (`src/plugins/roam-import/import.ts`) — treats
  `projectPropertyReferences` as authoritative for present-schema property refs
  (and content refs for the content-authoritative paths), but routes every
  references write through `reconcileDerived` with the *shared*
  `isRetainableAbsentRef` (now exported from
  `src/plugins/references/referenceProjection.ts`) so a prior property-derived
  ref under an absent schema is retained rather than replace-written away. All
  three write sites are covered: the planner pass and the daily/merge
  `applyPromotedAttributes` path (both via `referencesWithProjectedProperties`,
  which also keeps prior content refs since it doesn't re-parse content), and
  the descendant `upsertImportedBlock` existing-row branch (which reconciles the
  dump-derived set against the live row — content there *is* re-derived, so only
  absent-schema prior refs are retained). The tombstone-restore branch still
  resurrects content/properties with the planned data (not pre-deletion state),
  but reconciles `references` against the tombstone too — soft-delete preserves
  `references_json`, so a bare restore would otherwise replace away an
  absent-schema backlink; a field the planned data drops still takes its backlink
  with it (no orphan).

### Enforcement (tests)

- `assertRefListDeriveIsAddOnly` (`src/data/test/derivedDataContract.ts`) pins
  the **element-wise decode** facet (§1) — one malformed element keeps the
  well-formed siblings; a wrong-shape value yields `[]` and never throws —
  asserted against the three derive functions: codec `decodeRefListIds`,
  `projectPropertyReferences`, and `projectedRefsForField`. (The importer reuses
  `projectPropertyReferences`, so it inherits this decode facet.)
- The **retain-on-absence** facet (§2) is pinned by `reconcileDerived`'s unit
  tests (`src/data/api/derivedData.test.ts`), the reprojection absence branch
  (`latestRefProjectionSchema`, `src/data/internals/refProjection.test.ts`), and
  — for the importer's reference rebuild — a re-import regression in
  `src/plugins/roam-import/test/import.test.ts` ("retains an existing
  property-derived backlink on re-import when its ref schema is absent").

### Not enforced here — undo/redo replay (#187)

Replay re-derivation is the same *shape* of hazard — an incomplete recompute
clobbering a value that should have been restored exactly — and it motivates
this contract, but `reconcileDerived` does **not** address it: the helper has no
knowledge of whether the surrounding tx is a replay. #187 (audit A6) is a
separate, still-open fix (skip the same-tx processor pass on `_replay` in the
commit pipeline). It appears in the hazard list and incident history as a
motivating sibling, not as something this contract now prevents.

## When you add a new derive path

Decode element-wise (don't let one bad input throw the batch), and assemble the
write through `reconcileDerived` with a `retain` predicate that keeps
prior-derived data you can't currently re-derive. Add the path to
`assertRefListDeriveIsAddOnly` (or an analogue for a non-ref derived shape).

## Non-goal: the dual problem (must re-derive on source change)

This contract guards against derived data being **dropped when it shouldn't
be**. The opposite failure — derived data **not recomputed when its source
changed**, so it diverges from reality — is a *different* invariant and is
**out of scope**. #194 (SRS interval not recomputed when its sibling date field
shifts) is that dual; retain-on-source would not catch it (and would arguably
make it worse). It's tracked separately.
