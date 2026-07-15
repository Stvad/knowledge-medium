# Fuzzing

> **Status:** current — last verified against code 2026-07-14

Randomized testing for the parsing and data layers, in the Dan Luu
spirit: cheap random inputs + invariant oracles find bugs that
example-based tests structurally cannot, so generate relentlessly and
run continuously. All suites use [fast-check] (generators + shrinking +
seed replay) and live next to the code they test as `*.fuzz.test.ts`.

[fast-check]: https://fast-check.dev/

## Tiers

The same property code runs at three intensities (mechanics in
`src/test/fuzz.ts`):

| Tier | Trigger | Seeds | Budget |
|---|---|---|---|
| smoke | part of the normal `yarn test` / `yarn run check` gate | fixed | small run counts, ~1s/file |
| local deep | `yarn fuzz [files…]` | random | `FUZZ_TIME_MS` per property (default 15s) |
| nightly | `.github/workflows/fuzz-nightly.yml` (06:23 UTC cron + manual dispatch) | random | 15s/property across all suites, then a 20-minute dedicated pass on the stateful data-layer suite |

The smoke tier is deliberately deterministic: the gate re-explores the
same cases every run, so a pre-existing bug can only surface in the
nightly run — never as a flake blocking an unrelated PR. New territory
is the nightly tier's job; on failure it uploads the vitest log as an
artifact and files (or appends to) an issue labeled `fuzz-failure` with
the failing seed.

## Reproducing a failure

fast-check's failure report includes `seed`, `path`, and the shrunk
counterexample. Replay it:

```sh
FUZZ_SEED=<seed> FUZZ_PATH="<path>" yarn vitest run --testTimeout=600000 <failing file> -t '<failing test name>'
```

The `-t` filter matters: the env vars apply to every property in the
file, and a path only fits the property that produced it — other tests
in the file will fail with "Unable to replay". `FUZZ_PATH` jumps
straight to the counterexample; omit it to re-run the whole sequence
from the seed. `FUZZ_RUNS=<n>` forces a run count
instead of a time budget. The stateful suite pins its only other
nondeterminism (order-key jitter) through a seeded PRNG, so replays are
exact.

## The suites

- `src/plugins/references/test/referenceParser.fuzz.test.ts` — span
  soundness on bracket salads; render→parse round-trips; rewriters vs a
  fragment-level reference model.
- `src/utils/test/markdownParser.fuzz.test.ts` — paste/import parser:
  never-throws + valid forest on line soup; bullet-outline round-trip;
  fenced-code isolation.
- `src/data/mergeProperties.fuzz.test.ts`,
  `src/data/internals/jsonCanonical.fuzz.test.ts` — algebraic laws
  (identities, scoped associativity, equivalence relation, idempotence,
  union reference model).
- `src/data/api/codecs.fuzz.test.ts`,
  `src/data/api/blockData.fuzz.test.ts` — codec round-trips,
  strict-decode totality (only `CodecError`), lenient-path
  never-throws, `normalizeReferences` laws, row-parser round-trip.
- `src/data/test/repoMutators.fuzz.test.ts` — the stateful one: random
  `repo.mutate.*` sequences (incl. alias/type property writes and raw
  `references` writes) against a real test repo with per-op invariant
  sweeps (cycles, live orphans, order-key collisions, `SUBTREE_SQL` vs
  a JS reference walk, workspace uniformity, and
  incremental-vs-recompute mirrors for every trigger-maintained derived
  index: `block_aliases`, `block_types`, `block_references`,
  `blocks_fts` + rowid map), a consistency audit, undo-all/redo-all
  round-trip oracles, and a non-vacuity canary pinning each derived
  index populated by the op set.
- `src/sync/crypto/cryptoCodecs.fuzz.test.ts` — round-trips + decode
  totality for base64url/base32/hex, the `enc:v1:`/`encb:v1:`
  envelopes, workspace-key format (incl. whitespace/case tolerance),
  content-hash digests; AAD length-prefix injectivity and cross-builder
  disjointness.
- `src/data/internals/syncObserver/test/reconcile.fuzz.test.ts` — the
  LWW reconcile gate: case analysis + an independent I1/I2 reference
  model as an exact differential, and a sequence model against a fake
  server implementing the monotonic clamp (convergence, idempotent
  redelivery, zero-stamp exemption).
- `src/services/powersync.fuzz.test.ts` — upload queue:
  `compactBlockCrudEntries` differential replay over
  contiguous-transaction batches, same-tx PATCH fusion, DELETE
  cancellation, order-anchor re-derivation; `orderedBlockUpserts`
  permutation + parents-first + exactly-one-reversed-edge-per-cycle.
- `src/paste/test/operations.fuzz.test.ts` — paste planners: selection
  clamping, branch-exact prefix/suffix reconstruction, parsed-content
  conservation, fenced-code body preservation, chord-intent totality.
- `src/data/orderKeyPlacement.fuzz.test.ts` — tie-breaking placement
  via a fake-Tx harness: strictly-ascending keys, minimal re-key with
  no id dropped/duplicated, new ids contiguously adjacent to the anchor
  under `(order_key, id)` sort — the #198/#182/#188 tie-collision
  class.
- `src/plugins/references/test/referencesRecompute.fuzz.test.ts` — the
  references pipeline, stateful: content edits with
  `[[alias]]`/`((uuid))` marks, ref-typed property writes, alias
  renames, deletes/restores, and merges against a repo with the REAL
  references + daily-notes extensions; oracle = the FULL consistency
  audit (`content_link_recompute`, `property_ref_projection`, index
  mirror) reports zero anomalies after each drained op. Orphan-alias
  cleanup driven deterministically via fake timers.
- `src/data/test/splitMerge.fuzz.test.ts` — split/merge content
  conservation: split-then-merge identity, whole-tree pre-order text
  conservation, sibling placement + child adoption, exact-snapshot
  undo/redo round-trips.
- `src/sync/crypto/aead.fuzz.test.ts` — AEAD seal/open (text + bytes):
  round-trips, single-byte ciphertext‖tag tamper rejection, one-field
  AAD-mismatch rejection, wrong-key rejection, `validateCanary`
  false-never-throws totality.
- `src/utils/selection.fuzz.test.ts` — pure multi-select helpers:
  contiguous endpoint-order-independent ranges, anchor-index contract,
  `validateSelectionHierarchy` vs an independent ancestor walk +
  idempotence.
- `src/data/test/queryHandles.fuzz.test.ts` — query-handle soundness:
  a pool of subscribed `repo.query.*` handles (subtree, children,
  childIds, ancestors, byType, aliasLookup, searchByContent) must
  converge, after random mutator sequences, to an INDEPENDENT fresh
  read taken through a throwaway Repo over the same db (a same-handle
  `load()` would be tautological — it short-circuits to the peeked
  value). `searchByContent` compares id-sets only: its
  `declareRowDeps:false` under-invalidation is a documented, tested
  tradeoff.
- `src/shortcuts/test/defaultActions.fuzz.test.ts` — the interaction
  layer (jsdom): random default-action dispatches (normal-mode
  structural actions, edit-mode CM actions over a headless fake editor
  view, multi-select wrappers, undo/redo) through `invokeAction` with
  UI-shaped deps; oracles = structural invariants + scope-root
  boundary protection.

## Found so far

All found within the first hours of running, each fixed with a pinned
regression test in the same PR (#371):

- `renderWikilink` corrupted surrounding text for aliases with a
  trailing `]` or an unclosed `[[`.
- Undoing a merge of a block with children aborted with
  `ParentDeletedError` (replay applied snapshots in first-touch order;
  now topologically ordered in `_replay` via `replayApplicationOrder`).
- Merging an already-tombstoned block aborted with
  `WorkspaceNotPinnedError` (now a retry-safe no-op).
- `mergeProperties` silently dropped source-only keys shadowing
  `Object.prototype` members (`key in out` walked the prototype chain).
- `parseBlockRefs` made empty-label aliased refs (`[](((id)))`)
  indistinguishable from plain refs, so `rewriteBlockRefs` silently
  degraded the aliased form (id-fallback display) to a plain ref
  (target-content display). Caught by the nightly-style random-seed
  sweep — the fixed smoke seed had missed it.

The references-pipeline fuzzer found four more within its first hours
(each fixed with a pinned example test in the same PR):

- A block whose content/properties were edited while soft-deleted came
  back live with marks but no derived refs — restores never re-fired
  `parseReferences` (it now watches the `deleted` field).
- Typing `[[2026-01-05]]` when a live non-seat block already owned that
  date-shaped alias made `ensureDailyNoteTarget` trip the
  alias-uniqueness trigger, rolling back the whole processor tx —
  permanently stripped refs (the daily branch now resolves lookup-first,
  like the non-date branch).
- Merge retargeted property-derived reference entries without rewriting
  the property VALUE they project from — a projection anomaly the next
  re-parse silently reverted (merge now rewrites value + entry together
  when the schema is loaded, and leaves both alone when it isn't).
- `parseReferences` applied plans built from pre-write state without
  checking the source had moved — the rename rewriter's concurrent
  update could be clobbered by the stale plan (marks `[[new]]`, stored
  ref `old`). It now carries the rename processor's stale-plan guard.

The interaction fuzzer found one more:

- `delete_block` was the only structural handler with no scope-root
  guard: Delete with the zoomed page focused tombstoned the entire
  rendered surface out from under the panel. The boundary rule now
  lives in `StructuralEditPolicy.canDelete` (scope-less callers like
  the agent bridge remain free to delete).

## Adding a suite

1. Create `<target>.fuzz.test.ts` next to the existing tests, line 1
   `// @vitest-environment node`.
2. Pass `fuzzParams(N)` from `@/test/fuzz` as the second argument of
   every `fc.assert`; pick N so the whole file stays around ~1s in
   smoke mode (it runs in the PR gate).
3. Write oracles, not examples: never-throws totality, round-trips,
   algebraic laws, differential against a reference model, invariant
   sweeps. Justify each oracle from the target's code in the docblock —
   cite lines.
4. Oracle discipline: when a property fails, diagnose before touching
   anything. Wrong oracle → fix it with a code citation. Real bug → fix
   the product code (or file an issue and mark the carve-out with a
   `// KNOWN ISSUE (fuzz):` comment + counterexample). Never silently
   weaken a property to go green.
5. If the target has nondeterminism (randomness, clocks), pin it inside
   the property (seeded PRNG over `Math.random`, injected `now`) or
   shrinking and seed replay stop being sound.
6. Shared mutable state (e.g. one `createTestDb` per file) + a deep-tier
   time budget don't compose for free: fast-check's
   `interruptAfterTimeLimit` resolves `fc.assert` WITHOUT awaiting the
   case that's currently executing, so the abandoned case keeps running
   — and writing — after the property "finishes". Any test or cleanup
   that touches the shared state afterwards must barrier on the
   in-flight case first: capture each case's promise in a module-level
   `let`, then `await inFlightCase?.catch(() => {})` before proceeding
   (see `repoMutators.fuzz.test.ts`). Symptom if you skip this:
   deep-tier-only, order-dependent flakes in whatever runs after the
   property (phantom rows, duplicate-id errors).
