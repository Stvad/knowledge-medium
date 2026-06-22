# Lock & Wipe: should the selective flow become a coarse `destroyAllLocalData()`?

Design investigation. **No code change in this doc** — it recommends a direction and
scopes it. Grounded against `src/sync/keys/flows/lockAndWipe.ts`, `keyStore.ts`,
`modePin.ts`, `resolver.ts`, `src/data/repoProvider.ts`, `src/utils/exportSqliteDb.ts`,
`src/shortcuts/defaultShortcuts.ts`, `docs/e2ee-design.html` §6, and the media-attachments
design (PR #230) §7.2 / §7.3 / §8 / §9 / §15 / §17 / §18.

> **Update (post-review):** rollout pinning has been **removed** from the codebase, and
> product accepts that a user re-confirms each workspace's mode after a wipe. That deletes
> the only security reason for preserving the mode pins, so the recommendation below is now
> **fully coarse — no preserve-allowlist.** The original "keep the pins" carve-out is kept in
> the text only as the now-resolved decision (see §2b / §5).

## TL;DR

**Recommend: replace the selective flow with a coarse `destroyAllLocalData()` as the single
"panic / lock this device" action, clearing the entire origin with no carve-out.** Every
thing the selective flow scopes or preserves is now either edge-case-only (per-user key
clearing, per-user DB-file targeting — artifacts of the shared key store / per-user DB file),
a deliberate "don't log out" UX choice the threat model doesn't require, or — in the case of
the mode pins — **no longer load-bearing** now that rollout pinning is gone and post-wipe
re-confirmation is accepted (§2b).

A coarse primitive also subsumes, **for free**, every bespoke "Lock & Wipe participant"
the media-attachments design is currently forced to wire by hand (SW asset cache, bearer-
token store, per-asset hash mirror, the durable byte replica/display cache, the byte
upload queue). That is a large, real chunk of complexity the media doc is already leaning
toward dropping (its §7.3 and §18 say as much).

Keep one thing regardless of coarse-vs-selective: the **best-effort upload drain** before
the wipe (`flushUploadQueue` for `ps_crud`, plus the media byte-queue drain), so a deliberate
wipe doesn't silently lose unsynced edits — **with the limit that it only covers the *active*
account; an inactive/signed-out account's DB in the same profile is destroyed undrained**
(§2a, can't upload its queue without that account's JWT).

---

## 1. What's selective today, and which reasons still matter

`lockAndWipe` (lock time) + `consumePendingWipe` (next boot) deliberately scope or preserve
six things. Enumerated, with the reason and whether it still holds:

| # | Selective / preserved | Why it's scoped today | Does the reason still matter? |
|---|---|---|---|
| 1 | **Key clear is per-user** — `keyStore.clearForUser(userId)`, not a whole-store clear | The IndexedDB key store `km-e2ee-keys` is **shared across every account in the browser profile**; wiping account A must not drop B's WKs (which would lock B's E2EE workspaces without wiping B's DB) | **Edge-case only.** Matters *only* when a second account is signed into the same profile. Typical usage is ~2 users across a few devices; two accounts in one browser profile is the exception. |
| 2 | **DB-file wipe is per-user** — marker + delete keyed to `kmp-v6-<userId>.db` | Same reason: the SQLite file is per-user, so the wipe must not delete account B's DB | **Edge-case only**, same as #1. |
| 3 | **Mode pins preserved (all users)** — `kmp-e2ee-mode:*` in localStorage, never touched | An E2EE workspace whose WK was just dropped re-enters its **locked read-only** state on reboot rather than being re-evaluated as never-pinned (and possibly re-confirmed as plaintext) | **No longer load-bearing.** This *was* the one security-relevant piece of selectivity, but: rollout pinning is **removed** (so the silent seed-downgrade vector below is gone), and product **accepts** the user re-confirming a workspace's mode after a deliberate wipe. So preserving pins is now only a UX nicety (skip re-quarantine), not a security requirement (see §2b). |
| 4 | ~~**Pin-seed marker preserved**~~ — *obsolete* | This row described the rollout "trust the server's `encryption_mode` once" seed (`e2ee-design.html` §6 rule 3 rollout bullet) | **Gone.** Rollout pinning has been removed, so there is no seed to re-fire and no marker to preserve. The `e2ee-design.html` rollout bullet is stale on this point. |
| 5 | **Session preserved — NOT a logout** — you stay signed in; synced data re-downloads | Lock & wipe is framed as "re-lock *this device*," not "sign out." It's the deliberate scoping that distinguishes it from logout (see file header §9.2 / `defaultShortcuts.ts` copy) | **No — this is a *choice*, not a constraint.** The threat model (destroy local plaintext on this device) is fully served by a logout-to-clean-slate. Keeping the session alive is a UX nicety, and it's the main thing coarse changes. |
| 6 | **Compiled-extension cache** (`km-extension-compiled`) | — | **Not selective at all.** It's already cleared *wholesale* (no per-user/workspace dimension) at boot by `clearCompiledModuleCache`. Coarse changes nothing here except it stops being a special-cased participant. |

**Net:** with rollout pinning removed and post-wipe re-confirmation accepted, **none of the
six encodes a reason that forces selectivity.** #1/#2 are pure consequences of the
shared-key-store / per-user-DB-file layout and only bite the multi-account-in-one-profile
edge case. #3's security weight has evaporated (it's now UX-only). #4 is obsolete. #5 is a
deliberate "don't log out" decision the security goal doesn't require. #6 is already coarse.

So "nearly all of the complexity comes from selectivity, not from destruction" is correct —
and the remaining selectivity is now **all** either edge-case-only (#1, #2), pure UX (#3, #5),
or already-coarse (#6). A coarse nuke needs **no preserve-allowlist**.

---

## 2. The cost of going coarse

The headline cost is exactly as framed: **a coarse nuke logs out / wipes every account and
workspace in the browser profile at once, not just the locking one.** Two sub-costs:

### 2a. Multi-account-in-one-profile (the #1/#2 reasons) — small and acceptable

Selective scoping exists so account A's wipe leaves B's DB + keys intact and B keeps
working. Going coarse means A's wipe also nukes B's DB and keys and logs B out.

How real is this? **Low.** Per the stated usage (~2 users, a few devices), the common case
is *one* account per browser profile; a second signed-in account in the *same* profile is
the edge case. And even in that edge case the outcome is **consistent, not corrupting**: B's
DB re-downloads from the server on next sign-in, and B re-pastes the WK for E2EE workspaces
(first-encounter prompts again — §2b). It's heavier than today (B has to re-auth and
re-establish workspace modes), but it's not data loss *beyond* the unsynced edits called out
next. For the security goal — *destroy local plaintext on this device* — wiping the whole
profile is squarely acceptable; a user paranoid enough to want zero residue would reach for
the browser's "clear all site data" anyway (the right tool for *that* job — see §5).

**The one genuine data-loss corner (raised in review): the drain only covers the *active*
account.** The recommendation keeps the best-effort upload drain (`flushUploadQueue`) to avoid
losing unsynced work — but it runs against the *active* user's PowerSync DB only. A coarse nuke
also destroys any **inactive / signed-out** per-user DB in the profile, which `repoProvider.ts`
(top-of-file) *deliberately leaves intact* so a same-user re-sign-in resumes uploading its
`ps_crud`. Those inactive-account unsynced rows are destroyed **undrained**.

This is **not fixable by "drain every DB first"**: per-user DBs exist precisely so one
session's pending uploads are never retried under another user's JWT (`repoProvider.ts`
header) — you cannot upload account B's queue from account A's session, so there's no way to
flush B's queue without B signing in. So the honest treatment is to **call it out as accepted
data loss**: a profile-wide wipe is unconditionally destructive for every account except the
one actively draining, exactly as "clear all site data" would be. The UI copy should say so
("erases ALL local data for every account on this device, including unsynced changes in
other accounts that can't be saved first"), rather than implying the drain protects everyone.
If that loss is ever judged unacceptable, the only real mitigation is to keep the wipe
*selective* for the multi-account case — which loops back to the edge-case-only cost above.

### 2b. The downgrade defense (the #3/#4 reasons) — resolved, no longer a blocker

The original draft treated mode-pin survival as a load-bearing downgrade defense and kept a
preserve-allowlist for it. **Two facts retire that concern:**

1. **Rollout pinning has been removed.** The dangerous path was the *silent* one — the
   one-time "trust the server's `encryption_mode`" seed re-firing on the wiped DB and pinning
   an E2EE workspace `plaintext` from a hostile `none` flag with no user interaction. With no
   seed in the code, that vector doesn't exist. (The `e2ee-design.html` §6 rule 3 rollout
   bullet is stale on this point.)
2. **Post-wipe re-confirmation is accepted.** Without pins, re-login runs every workspace
   through e2ee §6 rule 3 first-encounter: branch (a) (server says `e2ee`) prompts for the WK
   — safe, no downgrade; branch (b) (server says `none`) quarantines read-only and offers
   "paste WK" or "confirm plaintext." The only residual is a *hostile server* lying `none` on
   a genuinely-E2EE workspace **and** the user confirming plaintext — and product's position
   is that a user who just deliberately wiped the device re-confirming their own workspaces'
   modes is fine. For an honest server, an E2EE workspace reports `e2ee` → branch (a) → the
   "confirm plaintext" option never even appears.

So mode pins can be **dropped with everything else** — no allowlist. Preserving them would
only be a UX nicety (skip the re-quarantine prompt on re-login); it carries no security
weight anymore, and dropping them keeps the primitive a clean "nuke the whole origin." A
future "remember my workspace modes across a wipe" UX could re-add a pin carve-out purely for
convenience, but that's optional and explicitly not security-motivated.

**Bottom line on cost:** the costs that survive scrutiny are (1) it's a logout that wipes the
whole profile, and (2) inactive-account unsynced edits are destroyed undrained. Both are
acceptable for the threat model and should be stated plainly in the confirm dialog. There is
**no downgrade-defense cost** and therefore no carve-out.

---

## 3. Boot-time vs inline — can coarse run inline before reload?

**No — a coarse wipe still needs the next-boot `consume` pattern, for the same root reason the
selective one does**, plus a second reason. But the boot half gets *simpler*, and most of the
non-DB clearing *can* run inline.

What blocks an inline wipe:

1. **The open OPFS SQLite file.** wa-sqlite holds an OPFS *sync-access handle* on
   `kmp-v6-<userId>.db`; `removeEntry` on it throws `NoModificationAllowedError` while open.
   We *could* `repo.db.close()` first (that's what `importRawSqliteDb` does to release the
   handle), but with `enableMultiTabs: true` **sibling tabs still hold their own handles** —
   closing this tab's doesn't release theirs. This is the exact constraint the current file
   header documents, and it doesn't change under coarse.
2. **`indexedDB.deleteDatabase` is blocked by open connections** — including this tab's own
   `km-e2ee-keys` / `km-extension-compiled` / PowerSync IDB *and* sibling tabs'. (This is why
   `clearCompiledModuleCache` uses a `clear()` transaction, not `deleteDatabase`.) Running
   *before this tab opens any store* removes *this tab's* connections — but **not a sibling
   tab's**: a tab that missed or was slow to process the profile-wide reload (broadcast is
   best-effort) can still hold a `km-e2ee-keys` / PowerSync connection when the boot wipe runs.
   So `deleteDatabase` here can fire `onblocked` and **hang the boot** if not handled. See the
   `clear()`-vs-`deleteDatabase` note in the sequence below.

So the minimal reliable sequence is structurally the same two-lifetime split as today, just
profile-wide and run earlier:

**Lock time (page live):**
1. Best-effort drain pending uploads — `flushUploadQueue(ps_crud)` + the media byte-queue
   drain (unchanged; this is the data-loss guard, kept regardless).
2. Arm **one** profile-wide marker in localStorage (e.g. `kmp-destroy-all-pending`).
3. `broadcastWipeReload()` to all tabs (now profile-wide, not per-user) so siblings reload
   and drop their plaintext + release their OPFS/IDB handles.
4. `window.location.reload()`.

**Next boot — *before login*, before any DB / key store / cache singleton opens a handle:**
5. If the marker is armed, run the load-bearing destruction, **each step retry-and-marker-
   retained** (any failure leaves the marker armed so the next boot retries — never disarm on
   partial success):
   - recursively `removeEntry` the **entire OPFS root** (DB files + journal/wal/shm siblings
     + future `attachments/` tree), retrying on `NoModificationAllowedError` to absorb a
     sibling still tearing down — same small retry loop as today;
   - clear **every IndexedDB database** (key store, compiled cache, PowerSync IDB, future
     media upload-queue + hash-mirror). **Prefer per-store `clear()` over `deleteDatabase`** —
     a `clear()` readwrite tx is *not* blocked by other connections (the exact reason
     `clearCompiledModuleCache` already uses it), so a slow sibling tab can't hang the wipe; an
     emptied DB shell is harmless. If full DB *removal* is wanted instead, `deleteDatabase`
     **must** attach an `onblocked` handler with a short timeout that leaves the marker armed
     (retry next boot) and surfaces the actionable "close other tabs" error — never block the
     boot indefinitely. *(Raised in review — this was the OPFS-only-retry gap.)*
   - `caches.delete(...)` **every Cache API** entry (future SW asset cache + token store);
6. Only after 5 succeeds: clear `sessionStorage` and `localStorage` in full (this also removes
   the wipe marker — no allowlist, since §2b retires the pin carve-out), then land on the
   logged-out login screen. Clearing storage *last* is what gives 5 its "marker still armed on
   failure → retry next boot" guarantee.

Two notable differences from today's `consumePendingWipe`, both *simplifications*:

- **No per-user filename resolution** — it blows away whole directories / whole databases, so
  there's no `dbFilenameForUser` threading, no per-user key scoping.
- **Placement moves earlier** — today's consume runs *inside* `ensurePowerSyncReady` (per-user,
  post-login). A profile-wide coarse wipe must run at **app boot, before the auth/repo
  providers mount and before any store singleton opens a connection** — which removes *this
  tab's* connections (so its own handles aren't a blocker) and guarantees nothing repopulates.
  It does **not** remove a sibling tab's connections, which is why step 5 still needs the
  `clear()`/`onblocked` handling above. That placement change is the main new wiring.

The compiled-cache "must run *after* the file delete succeeds" ordering dance and the
"best-effort vs load-bearing" split between participants **all collapse**: there's a single
load-bearing destructive operation gated by a single marker, instead of N participants each
needing their own gating + ordering + retry reasoning.

---

## 4. Interaction with the media-attachments design (PR #230)

This is where coarse pays off most. The media design is *already* leaning toward
`destroyAllLocalData()` — it names the function in §7.3 — and a coarse primitive lets that
doc **delete a whole category of bespoke lock-wipe wiring**:

- **§7.2 ("Lock & Wipe must reach the SW")** currently mandates a *marker-gated, must-block-
  marker-clear* purge of `caches.delete('assets:<userId>')` + the SW token store, wired "from
  day one" and "covered by the same flavor of tests that pin `lockAndWipe`," with explicit
  reasoning that it's load-bearing (not best-effort like the compiled cache) and must keep the
  marker armed if the purge fails. **A coarse boot-time nuke subsumes all of this** — the
  Cache API and the IDB token store are cleared wholesale, under the one marker, with the one
  must-succeed guarantee. The §7.2 "fix" *is* the coarse wipe; the section shrinks to a pointer.
- **§8 (byte replica / display cache)** and **§9 (durable upload queue)** each currently carry
  a "this store is a Lock & Wipe participant too" clause with per-user purge keys (the
  `user_id`-namespaced records exist *partly* so "Lock & Wipe and draining are per-user").
  Under coarse, the **purge half** of every one of these — replica, display cache, upload-queue
  store, hash mirror — is free (OPFS tree + IDB + Cache all go at once). The per-user namespacing
  is no longer needed *for wipe* (it may still be wanted for **drain** scoping and for
  multi-account cache isolation at *read* time, §7/§16 — those are separate concerns).
- **§15 phase 3** currently lists "the marker-gated boot-time purge of cache + token + hash-
  mirror (§7.2) — covered by `lockAndWipe`-flavored tests incl. a 'plaintext survives lock'
  regression" as scoped work. Under coarse that line **disappears** from phase 3 (the wipe is
  one shared primitive, tested once).
- **§17** (first tradeoff row: "decrypted bytes + token in a new location … Wipe is marker-
  gated at next boot … mandatory and tested") and **§18** (which calls out "caches plaintext
  (→ a second store in the lock-wipe lifecycle)" as one of *the biggest sources of genuine
  complexity*) both get materially weaker: coarse removes the "second store in the lock-wipe
  lifecycle" cost entirely, because there's no per-store lifecycle — just "it's in the origin,
  so the nuke gets it."

**What coarse does *not* subsume from the media design — keep these:**

- The **best-effort byte-queue drain** before the wipe (the §9 upload + the §10.1 confirm).
  Coarse removes the *purge* half, not the *drain* half — you still want to push un-uploaded
  bytes before destroying them, exactly as `flushUploadQueue` does for `ps_crud`.
- The **`ps_crud` compensating-delete** (§9): for an asset block whose *metadata already
  synced* but whose *bytes never uploaded*, enqueue a delete so peers don't render a
  permanently-broken embed. That's about **fleet/peer consistency**, which a *local* nuke
  can't fix — it rides the existing `ps_crud` flush and stays regardless of coarse-vs-selective.

Net for the doc: adopting coarse lets §7.2 collapse to "the coarse `destroyAllLocalData()`
covers the SW cache + token; no per-participant wipe wiring," and lets §8/§9/§15/§17/§18 drop
"Lock & Wipe participant" from every byte store. The media design's own §18 already flags this
as the direction — coarse makes it the default rather than an aside.

---

## 5. Recommendation

**Replace the selective flow with a coarse `destroyAllLocalData()` as the single, recommended
"lock & wipe this device" action — clearing the whole origin, no carve-out.** Concretely:

1. **`destroyAllLocalData()` becomes the action** behind `lock_and_wipe_local_data`. It:
   (1) best-effort drains the *active* account's pending uploads (`ps_crud` + media byte queue
   — kept), (2) arms one profile-wide marker + broadcasts reload, (3) reloads to a logged-out
   clean slate, with the actual destruction done at next boot (§3 sequence) over the **entire
   origin** — OPFS tree, every IndexedDB DB (incl. the key store), Cache API, localStorage,
   sessionStorage. No preserve-allowlist: §2b retires the pin carve-out (rollout pinning
   removed; post-wipe re-confirmation accepted).
2. **Drop the selective machinery.** There's no remaining per-account-preservation need that
   outweighs the simplification: the only thing selective buys is "keep a *second* account in
   the *same* profile signed in and un-wiped" (edge case, §2a). Remove per-user key scoping in
   the wipe path, the per-user wipe marker, the per-user DB-file consume, and the
   compiled-cache ordering dance, rather than carrying two flows. If product later wants a
   genuine "re-lock without logging out" affordance, add it back as a *narrow* variant, not as
   the default.
3. **Point true-paranoia users at the browser's "clear all site data"** for zero-residue (it
   also clears HTTP cache + cookies the in-app action doesn't).
4. **State the costs in the confirm dialog** (§2a): it signs you out and erases **all** local
   data for **every** account on this device — including unsynced changes in *other* accounts
   that can't be saved first (only the active account's queue is drained).

### Rough scope of the change

- **New:** `destroyAllLocalData()` (arm + drain + broadcast) and a boot-time `consumeDestroyAll()`
  that walks OPFS root, clears every IndexedDB DB (per-store `clear()`, §3), clears the Cache
  API, and clears sessionStorage + localStorage in full. ~ the size of today's
  `lockAndWipe.ts`, but with simpler internals (no per-user threading, no allowlist).
- **Move the boot consume call earlier** — from inside `ensurePowerSyncReady` (per-user, post-
  login, `repoProvider.ts:207`) to **app boot before the auth/repo providers mount**. This is
  the main structural change and the thing to get right (it must run before any IDB/OPFS handle
  opens).
- **Simplify callers:** `defaultShortcuts.ts:524` keeps its confirm + drain + "reload"
  structure but calls the coarse primitive; the confirm copy changes from "you stay signed in"
  to "you'll be signed out and all local data on this device is erased."
- **Delete:** per-user `clearForUser` *as used by the wipe* (the method can stay on the store
  interface if anything else needs it, but the wipe no longer calls it), the per-user
  `PENDING_WIPE` marker, the `consumePendingWipe` per-user file delete + compiled-cache ordering,
  and the `dbFilenameForUser`/`removeOpfsDbFile` wiring *in the wipe path* (export/import still
  use them).
- **Keep:** `flushUploadQueue` (and its `UploadQueueProbe`/`FlushResult` contract) unchanged —
  it's the data-loss guard and is orthogonal to coarse-vs-selective. `broadcastWipeReload` /
  `onWipeReload` stay (now keyed profile-wide, not per-user) — `App.tsx:264` keeps subscribing.

### Test implications

- **`lockAndWipe.test.ts`:**
  - `flushUploadQueue` block — **unchanged** (kept as-is).
  - `lockAndWipe commit` block — **replaced** by `destroyAllLocalData` arm/drain tests. The
    "preserves mode pins" test (`lockAndWipe.test.ts:139`) is **deleted** — coarse no longer
    preserves pins, so the inverse becomes the assertion: `consumeDestroyAll` clears
    `kmp-e2ee-mode:*` along with everything else. The "refuses when localStorage can't arm" and
    "no half-state on key-clear failure" tests fold into "arming the single marker fails closed."
  - `consumePendingWipe` block — **replaced** by `consumeDestroyAll` tests: clears OPFS / IDB /
    Cache / localStorage / sessionStorage **in full**; retries OPFS removal on
    `NoModificationAllowedError`; **uses `clear()` (not `deleteDatabase`) so a still-open
    sibling connection can't block** (or, if `deleteDatabase` is chosen, an `onblocked` test
    proving the marker stays armed); leaves the marker armed (retry next boot) if any
    load-bearing step fails; clears storage **last**. The FIFO-fence / loader-invalidation
    testing guidance in `AGENTS.md` still applies to the broadcast-reload test.
  - cross-tab block — **mostly unchanged** (now profile-wide).
- **Media design's `lockAndWipe`-flavored tests (§7.2 / §15 phase 3):** these **no longer need
  to exist as separate per-participant purge tests.** A single `consumeDestroyAll` test that
  asserts "Cache API + IDB + OPFS all cleared" covers what the media doc wanted, written once,
  not once per byte store.

### Decisions resolved (was: open fork)

The earlier draft left open whether to keep a pin preserve-allowlist for downgrade defense.
**Resolved: no carve-out** — rollout pinning is removed (no silent seed-downgrade vector) and
post-wipe re-confirmation is accepted, so the pins carry no security weight and are dropped
with everything else (§2b). A pin carve-out could still be added later purely as a UX nicety
(remember workspace modes across a wipe), but it is explicitly *not* security-motivated.

---

## Appendix — prototype sketch (feasibility, not wired in)

Shows the two halves and that the enumeration APIs exist (`navigator.storage.getDirectory()`
+ async-iterable entries, `indexedDB.databases()`, `caches.keys()`). Not production code —
illustrative only. Note the two review-raised points baked in: IDB cleared via `clear()` (not
`deleteDatabase`) so a slow sibling tab can't block, and **no preserve-allowlist** (§2b).

```ts
const DESTROY_ALL_MARKER = 'kmp-destroy-all-pending'

// ── Lock time (page live): arm + reload. Destruction is deferred to boot. ──
// Caller (defaultShortcuts) still runs flushUploadQueue(ps_crud) + media-queue drain first
// (active account only — §2a), then broadcastWipeReload() to all tabs, then location.reload().
export const destroyAllLocalData = (): void => {
  localStorage.setItem(DESTROY_ALL_MARKER, '1') // single profile-wide marker, not per-user
}

export const isDestroyAllPending = (): boolean =>
  localStorage.getItem(DESTROY_ALL_MARKER) === '1'

// ── Next boot, BEFORE auth/repo providers mount and before this tab opens any store. ──
export const consumeDestroyAll = async (): Promise<boolean> => {
  if (!isDestroyAllPending()) return false

  // 1. OPFS tree — retry on NoModificationAllowedError to absorb a sibling tab still tearing
  //    down its wa-sqlite worker. The whole root goes (DB files + future attachments/). Throws
  //    after its retries are exhausted → marker stays armed (step 4 not reached) → retry next boot.
  await withRetry(async () => {
    const root = await navigator.storage.getDirectory()
    // @ts-expect-error entries() is async-iterable in the OPFS spec
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true })
    }
  })

  // 2. Every IndexedDB database, EMPTIED via a clear() tx per object store — NOT
  //    deleteDatabase. clear() is not blocked by other connections (the exact reason
  //    clearCompiledModuleCache uses it), so a sibling tab that hasn't finished reloading can't
  //    hang the wipe; an emptied DB shell is harmless. (If full removal were required instead,
  //    deleteDatabase would need an onblocked handler with a timeout that re-throws so the
  //    marker stays armed — never await it unbounded.) Names: indexedDB.databases() on
  //    Chromium/WebKit, a known-list fallback on Firefox (km-e2ee-keys, km-extension-compiled,
  //    PowerSync's, + future media stores).
  const dbs = (await indexedDB.databases?.()) ?? KNOWN_IDB_FALLBACK.map(name => ({ name }))
  await Promise.all(dbs.map(({ name }) => name && clearAllStores(name)))

  // 3. Cache API — future SW asset cache + token store.
  if (typeof caches !== 'undefined') {
    await Promise.all((await caches.keys()).map(k => caches.delete(k)))
  }

  // 4. Only after 1–3 succeed: storage in full. No allowlist — pins go too (§2b). Clearing the
  //    marker is part of localStorage.clear(), so doing it LAST is what gives 1–3 their
  //    "still armed on failure → retry next boot" guarantee.
  sessionStorage.clear()
  localStorage.clear()
  return true
}
```

What the sketch confirms: the destruction needs *no per-user input* (no `userId`, no
`dbFilenameForUser`) and *no allowlist*; the enumeration APIs to clear the whole origin exist;
and the only real subtleties are the two the codebase already knows how to handle — the OPFS
open-handle retry and avoiding `deleteDatabase`'s cross-connection block (use `clear()`). The
per-store ordering / best-effort-vs-load-bearing matrix that `consumePendingWipe` + every media
"participant" carries today collapses into "do 1–3, then `localStorage.clear()` last."

