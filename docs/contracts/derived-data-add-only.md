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

Two enforcement points, one per failure mode:

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

Every derive site assembles its write through one chokepoint,
`reconcileDerived` (`src/data/api/derivedData.ts`). It returns the freshly
recomputed set **plus** any prior element the recompute didn't reproduce and
that a `retain` predicate keeps — so an absent deriver retains rather than
deletes. Consumers:

- **reprojection** (`src/data/repo.ts`) — pure add-only (default retain-all):
  it fires on a *schema* change while block values are static, so recompute can
  only add; removal is left to the lazy per-block path.
- **references processor** (`src/plugins/references/referencesProcessor.ts`) —
  recompute is authoritative for content + present-schema refs, but
  `isRetainableAbsentRef` retains a prior ref whose schema is absent and whose
  value is unchanged.

### Enforcement (tests)

- `assertRefListDeriveIsAddOnly` (`src/data/test/derivedDataContract.ts`) — the
  shared property asserted against **every** ref-list derive path: codec decode,
  `projectPropertyReferences`, `projectedRefsForField` (and the importer, which
  reuses `projectPropertyReferences`). One malformed element keeps the
  well-formed siblings; a wrong-shape value yields `[]` and never throws.
- `reconcileDerived` has direct unit coverage for the retain/drop facets
  (`src/data/api/derivedData.test.ts`).

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
