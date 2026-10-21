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
