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
is the nightly tier's job; on failure it uploads both passes' vitest
logs as an artifact and files (or appends to) an issue labeled
`fuzz-failure`. The failing seed is always in the uploaded artifact;
the issue body itself carries a best-effort excerpt of the failure
(only from the pass(es) that actually failed), not a guarantee.

## Reproducing a failure

fast-check's failure report includes `seed`, `path`, and the shrunk
counterexample. Replay it:

```sh
FUZZ_SEED=<seed> FUZZ_PATH="<path>" yarn vitest run --testTimeout=600000 <failing file> -t '<failing test name>'
```

The `-t` filter matters: the env vars apply to every property in the
file, and a path only fits the property that produced it — other tests
in the file may fail with "Unable to replay", or may silently replay an
unrelated case instead — always pass `-t`. `FUZZ_PATH` jumps straight to
the counterexample; omit it to re-run the whole sequence from the seed.
`FUZZ_RUNS=<n>` forces a run count instead of a time budget. The
stateful suite pins its only other nondeterminism (order-key jitter)
through a seeded PRNG, so replays are exact.

Triage note: fast-check reports "Property interrupted after 0 tests" as
a FAILURE when the time budget expires before even the first case
finishes. That's a budget/perf signal, not a property failure — rerun
with a larger `FUZZ_RUNS` or `FUZZ_TIME_MS`. It comes with a seed but no
counterexample, so there's nothing to shrink or replay.

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
- `src/data/propertyDefinitionRegistry.fuzz.test.ts` — the
  schema-unification registry + resolver (PR #364): random universes of
  seed declarations and projected definition rows; oracles =
  first-wins name-collision drop (reference-model differential),
  name-winner uniqueness, three-path resolution agreement
  (resolve/resolveField/resolveName round-trips), the kept-seed
  unshadowability case model, insertion-order independence, boundary
  fail-closed on forged identities, strict-codec recovery at the write
  seam. `legacySchemas` stays empty — the transitional dual-path dies
  in the B′ deletion slice and the suite must survive that unchanged.
- `src/data/propertySeeds.fuzz.test.ts` — the seed-declaration layer:
  `seedProperty` totality → `isPropertySeedDeclaration`
  self-validation across every kernel preset; canonical bag →
  `parsePropertyDefinitionMetadata` round-trip with provenance demotion
  when either half of the deterministic-id equation is wrong;
  encode-fixpoint + strict-decode totality for all kernel preset cores
  and both config codecs; per-conjunct mutation rejection.
- `src/data/definitionSeeds.fuzz.test.ts` — stateful: random
  interleavings of `materializePropertySeeds`, user-scope tamper
  attempts, Automation lifecycle writes, and deterministic-id
  poisoning; oracles = materialization idempotence, batch-abort
  atomicity under poisoning, bag code-ownership through every tx
  primitive, restore-preserves-bag, and a registry-resolution tie-in
  after each sequence.

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

The seed-materialization fuzzer (schema-unification surface, PR #364)
found two more within its first minutes, both in the tx-layer
seed-definition write guard:

- `tx.create` had no guard at all: the deterministic seed id is
  publicly computable (uuidv5 of `workspaceId:seedKey`), so a
  user-scope create carrying a provenance-valid bag forged a
  code-owned definition BEFORE materialization ran — and the
  materialization probe then trusted it forever (live row → skipped,
  payloads never repaired).
- `tx.restore` applied a `properties` patch unguarded — the one
  remaining bag-write primitive: tombstone a seed row via
  Automation/sync, resurrect it with a forged bag.

Codex review on the fuzz suites themselves then surfaced two product
bugs the suites' oracles were positioned to catch but their generators
hadn't reached (both confirmed red-first and fixed):

- `delete_empty_block_cm`'s empty-block path deleted before consulting
  the scope-root boundary (reachable: split the zoomed page at cursor
  0, then Backspace in the emptied root) — now gated on
  `StructuralEditPolicy.canDelete`.
- `parseReferences`' stale-plan guard checked only content/properties,
  so a references-ONLY writer (ref-backfill reprojection on schema
  load) landing between plan build and apply was clobbered with
  nothing left to re-derive the lost entry. The plan now carries a
  references basis and the processor watches `references`; retention
  keeps entries a re-parse can't derive.

Teaching the references fuzzer to land several ops before a flush
(mid-plan interleaving — the region every prior race bug lived in)
found one more within its first minute:

- A live block claiming an alias between `parseReferences`' plan build
  and apply made the write phase mint the predicted seat anyway,
  tripping the alias-uniqueness trigger and rolling back the whole
  processor tx — permanently stripped refs, because the interfering
  write touched the CLAIMANT row and no watched field on the source
  ever re-fires (the stale-plan guard can't see this race). Both
  `ensureAliasTarget` and `ensureDailyNoteTarget` now lookup-first
  INSIDE the write tx and `applySourcePlan` retargets the planned
  entries to the claimant — converging to what a fresh re-parse would
  produce.
- A third rollback variant, minutes later: a tombstoned seat's stored
  bag can carry a STALE alias claim (overwrite the seat's alias, then
  merge the seat away — merge hands the alias to the target and
  tombstones the seat with its bag intact). Re-referencing the date
  restored that bag as-is, resurrecting the stale claim and tripping
  the uniqueness trigger against the merge target — same
  whole-tx-rollback strip. `createOrRestoreTargetBlock` now strips the
  aliases key in the same restore UPDATE; the domain callback re-writes
  the correct one.

Batch 3 (PR #384: two-repo convergence + observer materialization +
binding oracle + an 11-suite discovery sweep) found six more:

- The two-repo convergence fuzzer's FIRST deep run found a server-side
  protocol bug (issue #381): `blocks_clamp_updated_at`'s +1 bump only
  clears the OLD row's stamp, not the patch AUTHOR's proposed stamp, so
  a merge onto a drifted base can land server-content ≠ author-content
  at the author's own stamp — the author's echo equal-stamp-skips
  (reconcile I1) and that device permanently misses the merged-under
  edit. The property is left strict, so the convergence deep tier is
  KNOWN RED until the server fix ships (the nightly report calls this
  out; a different failing file or fingerprint is a new bug).
- The binding-oracle sweep found that a long-form date literal bound to
  its resolved target was never CLAIMED by it — any later block could
  legitimately claim the spelling and existing bindings stayed silently
  pointing at the old target forever (nothing watches "an unclaimed
  literal was just claimed"). `claimLiteralDateAliases` now claims each
  literal on the resolved target. The same sweep surfaced the
  release-reclaim residual as a design gap (issue #383): bindings whose
  bound target is a tombstone are deliberately unpoliced.
- `isInsideUnclosedWikilink` pair-counted `[[`/`]]` while the
  autocomplete it guards uses an anchored regex — `']] [[ #tag'`
  divergence; rewritten to mirror the regex.
- `applyKeybindingOverrides`' collision-strip map compared raw chord
  strings, so an override spelled `Cmd+K` failed to strip a default
  spelled `$mod+k`; now keyed by `canonicalizeChord`, which (follow-up
  finds, one from review + one from Codex) also folds final-key case
  for `event.key`-dispatched tokens but preserves it for
  `event.code`-only tokens (`Digit1`, `Period`, …), which tinykeys
  matches exact-case. Layer-disagreement residual: issue #388.
- SRS scheduling ×2: `addDays`' local calendar math could land a
  reschedule up to an hour BEFORE `now` in a DST fall-back hour (the
  review round then caught that the pure-ms replacement shifted stored
  DATES across DST — final shape is calendar math + a monotonicity
  clamp, with the fuzz suite pinned to a DST-observing TZ so the
  property isn't vacuous on UTC runners); and a corrupted/imported
  negative interval survived every grade except AGAIN, scheduling into
  the past — floored at 0, with the multiplicative base rescued so 0
  isn't an absorbing state.

The adversarial-review round over Batch 3 also found one product bug
outside any fuzzer's reach (fixed + pinned): the new literal claim
re-inserts ALL of the target's aliases through the uniqueness trigger,
so a LATENT cross-client duplicate on a pre-existing alias (sync-apply
skips the trigger; V1 leaves those merges latent) aborted the WHOLE
parse batch, permanently — `claimLiteralDateAliases` now swallows
exactly the typed alias-collision abort and degrades to the pre-claim
first-writer behavior for that target.

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
   — and writing — after the property "finishes". Use
   `statefulFuzzGuard` from `@/test/fuzz`: wrap each case body in
   `guard.run(seedOrNull, body)` (it owns the barrier-before-pin
   ordering for `Math.random` pins), call `await guard.barrier()` at
   the top of any canary/example test touching the shared state, and
   add `afterAll(guard.barrier)`. Symptom if you skip this:
   deep-tier-only, order-dependent flakes in whatever runs after the
   property (phantom rows, duplicate-id errors).
