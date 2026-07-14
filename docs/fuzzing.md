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
FUZZ_SEED=<seed> FUZZ_PATH="<path>" yarn vitest run --testTimeout=600000 <failing file>
```

`FUZZ_PATH` jumps straight to the counterexample; omit it to re-run the
whole sequence from the seed. `FUZZ_RUNS=<n>` forces a run count
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
  `repo.mutate.*` sequences against a real test repo with per-op
  invariant sweeps (cycles, live orphans, order-key collisions,
  `SUBTREE_SQL` vs a JS reference walk, workspace uniformity), a
  consistency audit, and undo-all/redo-all round-trip oracles.

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
