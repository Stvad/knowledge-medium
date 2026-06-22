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

1. Feature-detects `StorageManager.persist`/`persisted` (older Safari lacks
   them; we no-op there and let the platform's own rules apply).
2. Checks `persisted()` first, so an already-persistent origin doesn't
   re-request (and we don't risk an unnecessary prompt).
3. Otherwise calls `persist()` **once** — one attempt per page load, no nagging
   — and logs the outcome (`granted` / `not granted` / `failed`).

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
(`navigator.storageBuckets.open(name, { durability, persisted })`). It lets us
split storage into separately named buckets, each with its own persistence and
an eviction **priority** (`durability: 'strict' | 'relaxed'`), so the browser
sheds the relaxed display-cache bucket before touching the strict database
bucket. That is the right primitive for "DB survives, cache is sacrificial."

**Is it worth pursuing now? Not yet.**

- **Browser support is narrow.** Storage Buckets is Chromium-only at time of
  writing; Firefox and Safari don't ship it. We'd be writing a path that most
  users never hit and still need the origin-wide `persist()` fallback anyway.
- **The downside it guards against is mild.** The thing we'd let go is the
  *re-fetchable* media display cache. Origin-wide `persist()` keeps the cache
  too, which is strictly nicer for offline use; the only cost is that the cache
  counts against the (large) persistent quota. We have no measured eviction
  pressure today.
- **It's additive later.** Moving the planned media cache into a `relaxed`
  bucket is a self-contained change when the cache is built; nothing about the
  current origin-wide request blocks it. The DB and key store stay in the
  default (now persistent) bucket; only the new cache opts into a sacrificial
  bucket.

**Recommendation:** origin-wide `persist()` is sufficient for now. Revisit
Storage Buckets when (a) the media cache exists and is large enough to matter,
and (b) we see real eviction pressure or quota complaints — and even then,
scope it to the cache bucket only, keeping the DB/keys in the persistent
default bucket as the durability floor with a non-bucketed fallback for
unsupported browsers.
