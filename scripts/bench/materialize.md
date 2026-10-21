# Workspace materialization benchmarks

Run from the repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm exec vite-node --config vitest.config.ts scripts/bench/bench-materialize.ts --records 3000 --reps 3
node scripts/bench/bench-materialize-browser.mjs 1000 3 tmp/materialize-webkit.json
```

The browser runner requires Playwright WebKit (`pnpm exec playwright install webkit`).
It serves a separate localhost origin with no environment files, creates a disposable
persistent browser profile, and never connects to a sync server. Persistent mode is
necessary because WebKit's private browsing mode does not support the OPFS backend.
The profile is removed when the runner exits normally or reports an error.

Both runners use the same deterministic records, production materializer, and
1,000-record windows with the production default read chunk size. The fixture
includes ordinary text, page aliases, exact references, field forms, properties,
and references. The Node runner uses `createTestDb`; WebKit uses PowerSync's
SQLite worker with `OPFSCoopSyncVFS`, core production indexes/triggers, and static
plugin schema contributions. WebKit also uses the real IndexedDB key store and
production key resolver; Node uses an in-memory key. The materializability policy
is fixed to copy/decrypt, excluding workspace-entry policy checks.

Each case has one discarded warmup and the requested number of measured samples:

- `initial`: empty local `blocks`, with all incoming rows staged.
- `echo-repass`: local plaintext already matches staging; flag every staged row
  again before measuring a no-op materialization pass.
- Both cases run in plaintext and encrypted modes.

Encryption, fixture staging, reset, echo setup, and validation are outside the
measured region. Validation checks all plaintext cells and every derived target
and field bit, along with row counts, cleared staging flags, and zero uploads.
The initial phase includes reads, policy/gate decisions, key lookup, and decrypt;
it is not a pure crypto timer. Transaction time includes its SQLite worker calls;
do not add SQL durations to transaction time. Key time is a subset of phase one.

This isolates materialization from network download, React rendering, observer
invalidation, and deferred alias-repair work. Desktop WebKit measurements explain
the code's costs but do not predict a particular iPad's throughput. Run comparisons
sequentially on the same machine and summarize medians, retaining raw samples.

## Measured comparison

Measured 2026-10-21 on the same desktop, sequentially, with one warmup and
three measured repetitions per case. Before: `be54e8e7de4`; optimized:
`fc53bd6229c`. Both versions ran the same benchmark code and validation.
WebKit reported Safari 26.4. These are local test-database results.

| Runtime / case | Records | Before median | After median | Speedup |
| --- | ---: | ---: | ---: | ---: |
| WebKit, encrypted initial | 1,000 | 4,128 ms | 221 ms | 18.7x |
| WebKit, plaintext initial | 1,000 | 694 ms | 186 ms | 3.7x |
| WebKit, encrypted echo/repass | 1,000 | 4,496 ms | 70 ms | 64.2x |
| WebKit, plaintext echo/repass | 1,000 | 31 ms | 32 ms | unchanged |
| Node, encrypted initial | 3,000 | 1,592 ms | 453 ms | 3.5x |
| Node, plaintext initial | 3,000 | 1,359 ms | 325 ms | 4.2x |
| Node, encrypted echo/repass | 3,000 | 244 ms | 157 ms | 1.6x |
| Node, plaintext echo/repass | 3,000 | 42 ms | 40 ms | similar |

WebKit encrypted-initial samples were 4,128 / 3,529 / 4,892 ms before and
221 / 217 / 236 ms after. Median key lookup time fell from 3,025 ms for
1,000 reads to 3 ms for one read. Median phase one fell from 3,225 to 48 ms.
Total SQLite calls fell from 1,398 to 425: inserts dropped from 1,000 to 27;
per-row derived-column writes and alias lookups still run. The write transaction
median fell from 678 to 173 ms.

Node isolates the database improvement because its key is already in memory.
Its 3,000-row workload reduced insert calls from 3,000 to 81 and total SQL calls
from 4,194 to 1,275. The encrypted write transaction median fell from 1,373 to
318 ms; phase one fell from 219 to 132 ms.

The WebKit echo baseline varied from 2,865 to 4,520 ms. Two samples included an
approximately one-second transaction wait outside individual SQL timings;
its cause is not established. Treat that case's ratio as noisy. The initial
materialization improvement also appears in every sample and in the Node run.
All samples validated the original values, derived targets/field bits, zero
remaining staging flags, and zero uploads.
