# Storage persistence & durability

## What we keep on-device

Knowledge Medium is local-first. Significant state lives in per-origin browser
storage:

- **The SQLite database** — OPFS, via PowerSync / wa-sqlite (`OPFSCoopSyncVFS`).
  This is the painful one to lose: it can hold unsynced edits and local-only
  history the server has never seen.
- **The E2EE workspace-key store** — IndexedDB `km-e2ee-keys`
  ([src/sync/keys/keyStore.ts](../src/sync/keys/keyStore.ts)). Backup-recoverable
  (the keys can be re-derived / re-imported), but still better kept.
- **A media-attachment byte queue + display cache** — planned, not yet built.
  Largely re-fetchable; the least painful to lose.

## The default-bucket problem

Under the [WHATWG Storage Standard](https://storage.spec.whatwg.org/),
IndexedDB, OPFS, and the Cache API all share **one per-origin quota** and live
in the origin's **default bucket**. By default that bucket is **best-effort**:
the browser may evict the whole thing under storage pressure (low disk, OS
cleanup), taking the SQLite DB with it.

The lever is [`navigator.storage.persist()`](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist).
A persistent origin is exempt from automatic eviction — it's cleared only by an
explicit user action (clearing site data, etc.). It returns a boolean and may
be granted silently via engagement / installed-PWA heuristics, or — in some
browsers (Firefox) — prompt the user.

## What we do today

[src/requestPersistentStorage.ts](../src/requestPersistentStorage.ts), called
once from [src/main.tsx](../src/main.tsx) at boot:

1. Feature-detects `StorageManager.persist`/`persisted` (a generic check — only
   very old engines lack them; we no-op there and let the platform's own rules
   apply).
2. Checks `persisted()` first, so an already-persistent origin doesn't
   re-request. This also picks up a later *browser*-driven grant — e.g.
   Chromium auto-persists on PWA install — without us asking again.
3. If a durable **`'denied'`** Permissions API state is present
   (`persistent-storage`), skips permanently — that's an explicit user "no"
   (Firefox "Block") we never re-prompt. In practice this is Firefox-only:
   Chromium and Safari grant silently and never report `'denied'`.
4. Otherwise requests persistence **at most once per cooldown window** (guarded
   by an origin-wide `localStorage` timestamp, `storage.persistAttemptedAt`,
   currently one week), and logs the outcome (`granted` / `not granted` /
   `failed`).

### Why this exact gating — two competing constraints

The request resolves differently per engine, which forces the design:

- **Chromium and Safari (17+)** never prompt; they grant silently from
  heuristics (engagement, installed PWA, notifications…). A `false` is a
  *silent* denial that a **later** call can flip to `true` as those signals
  change. (Safari ≥ 17 behaves like Chromium here — no special-casing.)
- **Firefox** shows a permission prompt; "Block" is a durable denial, a
  dismissal leaves it undecided.

So we must satisfy both at once:

- **Don't nag.** Re-calling `persist()` every reload would re-prompt a Firefox
  user. Hence the permanent skip on Permissions API `'denied'` (the strongest
  "user said no") *and* the once-per-cooldown guard for the undecided case
  (covers a dismissed prompt without repeating it on reloads — or in another
  tab). The marker is written *before* the request so even a dismissal counts
  as the attempt.
- **Don't permanently gate silent denials.** A Chromium/Safari silent denial
  reports `'prompt'`, not `'denied'`, so it never trips the permanent skip; and
  because the marker **expires** (and is origin-wide `localStorage`, shared
  across tabs, not per-tab `sessionStorage`), a later attempt retries — letting
  persistence be granted once engagement grows. The expiry is what keeps it from
  becoming a permanent block: an un-expiring marker would stop Chromium/Safari
  from ever being promoted.

A deliberate, user-initiated retry (a future settings affordance that can
explain *why* first) calls `requestPersistentStorage({force: true})` to bypass
both gates.

`navigator.storage.estimate()` is already used elsewhere for the
export-space precheck ([src/utils/exportSqliteDb.ts](../src/utils/exportSqliteDb.ts));
it's orthogonal to persistence (quota/usage reporting, not eviction policy).

## Differential durability (Storage Buckets API) — deferred

`persist()` is **origin-wide and all-or-nothing**: it makes the *entire*
default bucket persistent. It cannot express "keep the SQLite DB but let the
display cache be evicted first under pressure."

Our design intent is exactly that gradient: full offline operation is a goal,
so we want to **preserve caches by default** — but under *genuine* storage
pressure, **preserving the database takes priority over caches**. With only
`persist()` we get the coarse version of this: persist the whole origin, so
the database is safe, and the (re-fetchable) media cache rides along as
persistent too. We never evict the cache to save the DB; we just don't evict
anything automatically.

True differential durability needs the
[Storage Buckets API](https://developer.mozilla.org/en-US/docs/Web/API/Storage_Buckets_API)
(`navigator.storageBuckets.open(name, { persisted })`). It lets us split storage
into separately named buckets, each with its **own** `persisted` flag. Eviction
order is governed by that flag: the browser sheds all non-persisted
(best-effort) buckets before touching a `persisted: true` one. So we'd open the
database/keys bucket with `persisted: true` and the media-cache bucket as
`persisted: false` (the default) — the cache is shed first, the DB survives.
That is the right primitive for "DB survives, cache is sacrificial."

> Note: the buckets' `durability: 'strict' | 'relaxed'` option is **not** this
> lever — it's a per-write flush-vs-buffer hint (data safety across power loss),
> unrelated to eviction order. Eviction is controlled solely by `persisted`.
> Conflating the two would leave the DB bucket non-persistent and just as
> evictable as the cache — the opposite of the intent.

**Is it worth pursuing now? Not yet.**

- **Browser support is narrow.** Storage Buckets is Chromium-only at time of
  writing; Firefox and Safari don't ship it. We'd be writing a path that most
  users never hit and still need the origin-wide `persist()` fallback anyway.
- **The downside it guards against is mild.** The thing we'd let go is the
  *re-fetchable* media display cache. Origin-wide `persist()` keeps the cache
  too, which is strictly nicer for offline use; the only cost is that the cache
  counts against the (large) persistent quota. We have no measured eviction
  pressure today.
- **It's additive later.** Moving the planned media cache into a non-persisted
  (`persisted: false`) bucket is a self-contained change when the cache is
  built; nothing about the current origin-wide request blocks it. The DB and key
  store stay in the default (now persistent) bucket; only the new cache opts into
  a sacrificial bucket.

**Recommendation:** origin-wide `persist()` is sufficient for now. Revisit
Storage Buckets when (a) the media cache exists and is large enough to matter,
and (b) we see real eviction pressure or quota complaints — and even then,
scope it to the cache bucket only, keeping the DB/keys in the persistent
default bucket as the durability floor with a non-bucketed fallback for
unsupported browsers.
