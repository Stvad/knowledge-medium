# Data-integrity tooling

Detection and recovery scripts for the data-integrity defense
([docs/data-integrity-defense.html](../../docs/data-integrity-defense.html)).
Everything here runs through the **agent bridge** against a live, connected
client (the target tab must be focused/connected):

```
yarn agent --profile <name> eval --file scripts/data-integrity/<file>.eval.js
```

The bridge eval scope exposes `repo`, `db`, `sql(text, params, mode)`
(`mode` ∈ `all` | `get` | `optional`), `data` (the `--data-json` payload), and
dynamic `import('@/…')` of app modules. An eval's return value is printed as
JSON.

## What's here

| File | Layer | Writes? |
| --- | --- | --- |
| [`consistency-check.eval.js`](consistency-check.eval.js) | L3 + L4 | **No** — pure detection. Run it on a cadence or whenever "the backlinks look wrong." |

Recovery scripts live next to the incident they address
(e.g. [`../daily-note-date-recovery/`](../daily-note-date-recovery),
[`../dangling-refs/`](../dangling-refs)) and follow the harness contract below.

## Detection first

Read-only detection is the priority. The consistency check writes **nothing** —
run it freely. Recovery (anything that writes) is approval-gated: author it,
dry-run it, and only apply against shared infra with an explicit go-ahead.

## Recovery harness contract (L6)

The pattern already exists and is good
([`../daily-note-date-recovery/recover.eval.js`](../daily-note-date-recovery/recover.eval.js)):
default **dry-run** returns a report; `--data-json '{"apply":true}'` writes
through `repo.tx` (so rows upload and the fleet converges); an **in-tx recheck**
makes re-runs safe. Every recovery script must hold these rules — each one is a
scar from a real incident:

1. **Dry-run by default.** `apply` is off unless `--data-json '{"apply":true}'`.
   The dry-run returns the full plan (counts + a sample) so a human can read it
   before any write.

2. **Pre-flight verify before any "make-X-win" op.** Diff the copy you're about
   to force to win against the converged view *first*, and refuse to bump rows
   you haven't confirmed correct. This — not a post-hoc detector — is the real
   defense against incident #4: a bulk bump propagates immediately, so a
   detector is always too late. See the pattern below.

3. **Drive off the converged/server view**, or write from the client where the
   row is *actually* stale. A byte-identical write on a healthy client produces
   no `ps_crud` and never uploads (the incident #5 trap) — confirm the write
   actually queued.

4. **Re-check inside the tx.** Re-read each row with `tx.get(id)` and re-assert
   the precondition; a concurrent edit or a freshly-synced server row may have
   fixed it between the candidate SELECT and the write. This makes a partial
   re-run safe (idempotent).

5. **Never blind-bump `updated_at`** to force unverified data to win (incident
   #4). If you must bump, rule 2 gates it.

6. **Verify convergence after.** Re-run the detector and confirm `ps_crud`
   drained (`SELECT count(*) FROM ps_crud`). A recovery isn't done until the
   fleet has converged.

## Verify-before-bump pre-flight

The dangerous op is forcing a chosen copy of a row to "win" fleet-wide — by
writing it (or bumping its `updated_at`) so whole-row LWW
(`reconcile.ts` — `decideStagingRow`) prefers it everywhere. The pre-flight's
job is to **refuse to force any row whose intended-winning value hasn't been
confirmed against the converged view** (`blocks_synced`). Bake this in *before*
the apply phase:

```js
// `intended` = [{ id, value }] you are about to force to win, where `value`
// is the field(s) you'll write. `confirm(id, intendedValue, server)` returns
// true only when you've established the intended value is the correct one
// (e.g. it equals / supersedes the server's, or you re-derived it from a
// trusted source). Reject — never default-accept — on anything unconfirmed.
const preflight = async (intended, confirm) => {
  const refusals = []
  for (const { id, value } of intended) {
    const server = await sql(
      `SELECT content, properties_json, references_json, updated_at, deleted
         FROM blocks_synced WHERE id = ?`,
      [id], 'optional',
    )
    if (!confirm(id, value, server)) {
      refusals.push({ id, reason: server ? 'unconfirmed vs server' : 'no server row' })
    }
  }
  return refusals // non-empty ⇒ DO NOT bump; surface and stop.
}

const refusals = await preflight(intended, confirm)
if (refusals.length) {
  return { mode: 'refused', refusals } // abort the whole apply; nothing was forced to win
}
```

Key points:
- It is **reject-by-default**: `confirm` must return `true` for a row to be
  eligible; anything it can't vouch for is refused, not waved through.
- A non-empty `refusals` aborts the **entire** apply — you don't partially force
  a batch you couldn't fully verify.
- This is a convention + snippet, not a framework. Copy it into a recovery eval
  and supply the `confirm` predicate that fits the incident.

## See also

- [docs/data-integrity-defense.html](../../docs/data-integrity-defense.html) —
  invariants, failure classes, the six defense layers, blind spots, roadmap.
- [scripts/supabase-health.mjs](../supabase-health.mjs) — the L5 server-side
  anomaly detectors on the hourly probe (`runDataIntegrityChecks`).
