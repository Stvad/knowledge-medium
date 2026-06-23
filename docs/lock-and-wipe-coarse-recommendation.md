# Lock & Wipe: selective flow, coarse `destroyAllLocalData()`, or delegate to the platform?

> **Answer: delegate to the platform (§0).** Neither the selective flow nor a hand-rolled coarse
> wipe is worth building; the browser's own origin wipe is more complete and avoids the §3
> mechanics. Build only a thin panic action in front of it.

> **Status: current** (written 2026-06-22) · recommendation/design — *not yet implemented*.
> Last verified against code: 2026-06-22.
> Code + tests are ground truth (see `AGENTS.md` → "design docs"); this proposes a direction,
> so verify against the code before treating any "today it does X" claim as still true.

Design investigation. **No code change in this doc** — it recommends a direction and
scopes it. Grounded against `src/sync/keys/flows/lockAndWipe.ts`, `keyStore.ts`,
`modePin.ts`, `resolver.ts`, `workspaceAccess.ts`, `src/data/repoProvider.ts`,
`src/utils/exportSqliteDb.ts`, `src/shortcuts/defaultShortcuts.ts`, `src/main.tsx`,
`public/sw.js`, `docs/e2ee-design.html` §6, and the media-attachments design (PR #230)
§7.2 / §7.3 / §8 / §9 / §15 / §17 / §18.

> **Update (post-review):** rollout pinning has been **removed** from the codebase
> (`workspaceAccess.ts`: "no server-trusting rollout seed anymore"), and product accepts that a
> user re-confirms each workspace's mode after a wipe — so the mode pins carry no security weight
> and a full nuke is acceptable. A second adversarial-review pass then showed the *destruction
> mechanics* of a hand-rolled coarse wipe are **not** free (service-worker survival, a cross-tab
> OPFS race, a real boot gate; §3). **Final decision (supersedes the "build coarse" framing
> below): don't hand-roll a wipe — delegate to the platform's "clear site data" (§0).** Lock &
> Wipe becomes a *panic* action that drains unsynced uploads (best-effort) and hands off to the
> browser's own origin wipe. §1–§5 are retained as the supporting analysis — i.e. *why* a
> hand-rolled selective/coarse wipe isn't worth building — not as the recommendation.

## TL;DR

**Recommend: don't hand-roll a wipe — delegate to the platform's "clear site data" (§0).**
A full nuke is the accepted behavior (a *panic* option; no selective/per-user preservation is
needed — §1/§2), and the browser's own origin wipe is *more complete* than anything we can
write: it runs **outside** the page/service-worker context, so it's structurally immune to the
three problems that make a hand-rolled `destroyAllLocalData()` costly (the cross-tab OPFS race,
the surviving service worker, and the pre-render boot gate — §3). Hand-rolling the wipe is, to a
real degree, fighting the platform.

So Lock & Wipe becomes a thin **panic action**: confirm → (optionally) drain unsynced uploads →
hand off to the platform wipe. The hand-off is either:
- **trigger** it, if we serve the app from a header-capable origin: a `/wipe` route returns
  `Clear-Site-Data: "*"` and the browser wipes the origin in one click (§0.2); or
- **guide** the user to the browser's built-in clear-site-data control, when we can't set the
  header (today, on GitHub Pages — §0.3). There is no JS API to open that UI, so "redirect"
  means concise, browser-specific instructions.

Build the JS enumeration wipe (selective **or** coarse) only as a **last resort** — if you both
need *save-then-wipe* and can't emit `Clear-Site-Data`. §1–§5 below explain why that bar is
high.

The one piece worth keeping from the old flow regardless: the **best-effort upload drain**
(`flushUploadQueue` for `ps_crud`, plus the media byte-queue) — the platform wipe can't save
unsynced work first. Mind its limits (§2a): it covers only the *active* account; `flushed:true`
can include transactions the server **rejected** (`ps_crud_rejected`, count→0); and a
**local-only** account has no server copy, so its wipe is unrecoverable total loss. State these
in the confirm dialog.

---

## 0. Recommended approach: delegate to the platform

The whole investigation below converges on coarse ≈ "wipe the origin and log out." Once you're
there, the honest next question is: *why hand-roll that when the platform already does it?*

### 0.1 The platform already does a more complete wipe than we can

Every browser ships an origin wipe ("Clear site data" / "Cookies and site data → Remove"), and
every OS ships an app-data clear (Android Settings → App → Storage → Clear data; an installed
PWA exposes its own "Clear data"). These clear **everything** for the origin — localStorage,
sessionStorage, IndexedDB, the Cache API, service workers, cookies, **and OPFS** — atomically.

Crucially, they run **outside the page and service-worker context**, which is exactly why they
dodge the three hard problems a hand-rolled wipe hits (§3):
- no **cross-tab OPFS race** — the browser tears down all the origin's workers/handles itself;
- no **surviving service worker** — the browser unregisters it; our page-side `caches.delete`
  can't (§3.3);
- no **boot-gate / import-order** hazard — there's no page code racing storage it lives inside
  (§3.4).

So the platform wipe isn't a weaker substitute for `destroyAllLocalData()`; it's a *stronger*
one. Hand-rolling is fighting the platform.

### 0.2 `Clear-Site-Data` — the one way to *trigger* it from the app, and why it's safe

`Clear-Site-Data` is an HTTP **response** header. When the browser receives a response carrying
e.g. `Clear-Site-Data: "*"` (or specific buckets `"cache"`, `"cookies"`, `"storage"`,
`"executionContexts"`), it clears that data **for the responding origin only**.

It is **not** a "wipe the whole device" power, and that scoping is the load-bearing safety
property:
- **Same-origin only.** A response from origin X can only clear X's data. A hostile site cannot
  return a header that wipes another site's data or the whole browser. (`"storage"` is the
  bucket that takes IndexedDB / Cache / service workers / **OPFS**.)
- **No new privilege.** An origin can already delete its own storage from its own JavaScript
  (`localStorage.clear()`, `indexedDB.deleteDatabase()`, …). `Clear-Site-Data` is just an
  atomic, complete way to clear *its own* footprint — including bits JS can't cleanly reach,
  like unregistering its own SW. Same power, cleaner mechanism.
- **HTTPS / secure-context only.**

The trigger pattern: a dedicated path on our origin (e.g. `/wipe`) responds with
`Clear-Site-Data: "*"`; the app navigates there, the browser wipes the origin, and the response
redirects to the logged-out app. One click, browser-grade, none of the §3 machinery.

### 0.3 Hosting reality (today) and what to actually build

The catch: the `Clear-Site-Data` header must come from **our** origin's response, and the app
is served from **GitHub Pages** (static — no custom response headers). A service-worker–
synthesized `Clear-Site-Data` is unreliable and self-referential (it would unregister the SW
emitting it), so it's not a dependable substitute. There is also **no JS API** to open the
browser's clear-data UI from a page.

So:
- **Now (GitHub Pages):** the in-app action **guides** the user to the browser's clear-site-data
  control (concise, browser-specific instructions; link to the OS/PWA "Clear data" where
  applicable). Best-effort, but honest and zero-maintenance.
- **If/when served from a header-capable origin** (a small edge function, or a CDN/host that
  allows response headers, or putting GH Pages behind one): add the `/wipe` route from §0.2 for
  a true one-click trigger. This is the recommended target.

**What to build is therefore thin** and has no destruction code of its own:
`lock_and_wipe_local_data` → confirm (state the §2a data-loss costs) → *optionally*
`flushUploadQueue` (the one thing the platform can't do — save unsynced work first) →
**trigger `Clear-Site-Data` if available, else show the guide.** No OPFS walk, no IDB
enumeration, no SW handshake, no boot gate — the browser owns all of that.

### 0.4 When (and only when) to hand-roll

Build the JS enumeration wipe (selective or coarse, §3) **only** if both hold: (a) the panic
action must *save unsynced work and then* destroy local in the same gesture, **and** (b) you
can't emit `Clear-Site-Data` (stuck on header-less hosting, SW path unverified). Absent both,
delegate. §1–§5 below are the cost analysis that sets that bar — read them as *why not to
hand-roll*, not as the build plan.

---

## 1. What's selective today, and which reasons still matter
> *(Background / cost analysis. The recommendation is §0; §1–§5 explain why hand-rolling a
> selective or coarse wipe isn't worth it versus delegating to the platform.)*

`lockAndWipe` (lock time) + `consumePendingWipe` (next boot) deliberately scope or preserve
six things. Enumerated, with the reason and whether it still holds:

| # | Selective / preserved | Why it's scoped today | Does the reason still matter? |
|---|---|---|---|
| 1 | **Key clear is per-user** — `keyStore.clearForUser(userId)`, not a whole-store clear | The **production** IndexedDB key store `km-e2ee-keys` is **shared across every account in the browser profile** (the in-memory fallback, used only when IDB is unavailable, is per-page); wiping account A must not drop B's WKs (which would lock B's E2EE workspaces without wiping B's DB) | **Edge-case only.** Matters *only* when a second account is signed into the same profile. Typical usage is ~2 users across a few devices; two accounts in one browser profile is the exception. |
| 2 | **DB-file wipe is per-user** — marker + delete keyed to `kmp-v6-<userId>.db` | Same reason: the SQLite file is per-user, so the wipe must not delete account B's DB | **Edge-case only**, same as #1. |
| 3 | **Mode pins preserved (all users)** — `kmp-e2ee-mode:*` in localStorage, never touched | An E2EE workspace whose WK was just dropped re-enters its **locked read-only** state on reboot rather than being re-evaluated as never-pinned | **Security weight gone, real UX cost remains.** Rollout pinning is removed (so the silent seed-downgrade vector is gone) and product accepts re-confirmation, so preserving pins is **not a security requirement** (§2b). But it is **more than a nicety**: the pin is also a *set-once / immutable* anchor (`modePin.setModePin` throws on a mode flip), and dropping it profile-wide means the user must **re-establish every E2EE workspace's mode for every account** after the wipe (re-paste each WK), not "skip one prompt" (§2b). |
| 4 | ~~**Pin-seed marker preserved**~~ — *obsolete* | This row described the rollout "trust the server's `encryption_mode` once" seed (`e2ee-design.html` §6 rule 3 rollout bullet) | **Gone.** Rollout pinning has been removed (`workspaceAccess.ts`), so there is no seed to re-fire and no marker to preserve. The `e2ee-design.html` rollout bullet is stale on this point (its banner now says so). |
| 5 | **Session preserved — NOT a logout** — you stay signed in; synced data re-downloads | Lock & wipe is framed as "re-lock *this device*," not "sign out." It's the deliberate scoping that distinguishes it from logout (see file header §9.2 / `defaultShortcuts.ts` copy) | **No — this is a *choice*, not a constraint.** The threat model (destroy local plaintext on this device) is fully served by a logout-to-clean-slate. Keeping the session alive is a UX nicety, and it's the main thing coarse changes. |
| 6 | **Compiled-extension cache** (`km-extension-compiled`) | — | **Not selective at all.** It's already cleared *wholesale* (no per-user/workspace dimension) at boot by `clearCompiledModuleCache`. Coarse changes nothing here except it stops being a special-cased participant. |

**Net:** with rollout pinning removed and post-wipe re-confirmation accepted, **none of the
six encodes a reason that forces selectivity.** #1/#2 are pure consequences of the
shared-key-store / per-user-DB-file layout and only bite the multi-account-in-one-profile
edge case. #3's *security* weight has evaporated (its residual cost is UX, not safety — see
§2b). #4 is obsolete. #5 is a deliberate "don't log out" decision the security goal doesn't
require. #6 is already coarse.

So "nearly all of the complexity comes from selectivity, not from destruction" is correct *for
the security/selectivity axis* — a coarse nuke needs **no preserve-allowlist**. It is **not**
correct that the destruction itself is therefore trivial; §3 is where coarse's own mechanics
turn out to cost roughly what the per-store wiring did.

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

**The data-loss corners (raised in review). The drain is narrower than "we keep your work"
implies:**

1. **Only the active account drains.** `flushUploadQueue` runs against the *active* user's
   PowerSync DB only. A coarse nuke also destroys any **inactive / signed-out** per-user DB in
   the profile, which `repoProvider.ts` (top-of-file) *deliberately leaves intact* so a
   same-user re-sign-in resumes uploading its `ps_crud`. Those rows are destroyed **undrained**.
   This is **not fixable by "drain every DB first"**: per-user DBs exist precisely so one
   session never retries another's uploads under the wrong JWT (`repoProvider.ts` header), so
   you cannot flush B's queue without B signing in.
2. **`flushed:true` ≠ persisted, even for the active account.** `flushUploadQueue`'s own
   docblock notes that the connector moves permanently-**rejected** transactions to
   `ps_crud_rejected` and completes them, which also drops the queue count to 0 — so a
   `flushed:true` can hide edits the server refused (RLS change, conflict). The wipe then
   destroys them, and the confirm dialog shows no "remaining" count. (This is true of today's
   flow too; coarse just makes it worth re-stating because the DB is *destroyed*, not kept.)
3. **A local-only active account is unconditional total loss.** A user in local-only mode
   (`ftm.localOnly`, `useRemoteSync:false`) has **no server copy**. For them, drain or not, a
   coarse wipe destroys everything with no re-download — and `localStorage.clear()` also drops
   the local-only opt-in. The "re-downloads from server" framing above does **not** apply.

(A *mid-flush* abort is **not** on this list: `flushUploadQueue` returns `flushed:true` only
once `ps_crud` reaches count 0, and PowerSync deletes those rows via `complete()` *after* the
awaited server call — so queue-empty already **is** the acknowledgement; nothing is in flight
when the drain returns and the lock flow reloads. The only "drained but not persisted" case is
the rejected rows of #2.)

So the honest treatment is to **state these as accepted loss** in the confirm dialog
("erases ALL local data for every account on this device, including unsynced changes that
can't be saved first, and — for a local-only account — everything, with nothing to
re-download"), not to imply the drain protects everyone. If that loss is judged unacceptable,
the only real mitigation is to keep the wipe *selective* for the multi-account case — which
loops back to the edge-case-only cost above.

### 2b. The downgrade defense (the #3/#4 reasons) — resolved, no longer a blocker

The original draft treated mode-pin survival as a load-bearing downgrade defense and kept a
preserve-allowlist for it. **Two facts retire the *security* concern:**

1. **Rollout pinning has been removed.** The dangerous path was the *silent* one — a one-time
   "trust the server's `encryption_mode`" seed re-firing on the wiped DB and pinning an E2EE
   workspace `plaintext` from a hostile `none` flag with no user interaction. The code is
   explicit that this is gone (`workspaceAccess.ts`: *"With no server-trusting rollout seed
   anymore, EVERY unpinned workspace takes this gate on first encounter."*). The
   `e2ee-design.html` §6 rule 3 rollout bullet is stale on this point.
2. **Post-wipe re-confirmation is accepted.** Without pins, re-login runs every workspace
   through e2ee §6 rule 3 first-encounter (`resolveWorkspaceAccess`): branch (a) (server says
   `e2ee`) prompts for the WK — safe, no downgrade; branch (b) (server says `none`) quarantines
   read-only and offers "paste WK" or "confirm plaintext." The only residual is a *hostile
   server* lying `none` on a genuinely-E2EE workspace **and** the user confirming plaintext —
   and product's position is that a user who just deliberately wiped the device re-confirming
   their own workspaces' modes is fine. For an honest server an E2EE workspace reports `e2ee`
   → branch (a) → the "confirm plaintext" option never even appears. I checked for any
   *auto*-pin path that could re-fire post-wipe: there is none — `setModePin` is set-once and
   throws on a conflicting flip, and `confirmPlaintextForSession` only ever holds
   *user-confirmed* plaintext, never anything server-derived.

So mode pins can be **dropped with everything else** — no allowlist, **no security cost.** But
the cost isn't zero: §1 row 3 — dropping pins discards the *set-once immutability anchor* and
forces the user to **re-paste every E2EE workspace key for every account** after the wipe (the
selective flow preserves the pin so the workspace re-enters *locked read-only* and the user
re-pastes lazily, only when they next open it). That is a real availability/UX cost, not a
"skip one prompt" nicety — but it is **product-accepted** and security-neutral. A pin carve-out
remains available later purely to soften that UX (remember workspace modes across a wipe); it
would carry no security weight.

**Bottom line on cost:** the costs that survive scrutiny are (1) it's a logout that wipes the
whole profile; (2) the data-loss corners in §2a (inactive accounts, rejected rows, local-only
total loss); and (3) the re-paste-everything UX of dropping pins. All are
acceptable for the threat model and should be stated plainly in the confirm dialog. There is
**no downgrade-defense cost** and therefore no required carve-out.

---

## 3. Boot-time vs inline, and the destruction mechanics that *don't* collapse

**A coarse wipe still needs the next-boot `consume` pattern** — the open OPFS SQLite file can't
be removed while any tab holds it (below) — and, contrary to an earlier draft, the boot half is
**not** a clean collapse to "one marker, one operation." It re-shapes the per-store wiring into
three problems the selective flow avoids or handles better. Take them in order.

### 3.1 What blocks an inline wipe (unchanged from today)

1. **The open OPFS SQLite file.** wa-sqlite holds an OPFS *sync-access handle* on
   `kmp-v6-<userId>.db`; `removeEntry` on it throws `NoModificationAllowedError` while open.
   We *could* `repo.db.close()` first (that's what `importRawSqliteDb` does to release the
   handle), but with `enableMultiTabs: true` **sibling tabs still hold their own handles** —
   closing this tab's doesn't release theirs.
2. **`indexedDB.deleteDatabase` is blocked by open connections** — including this tab's own
   stores *and* sibling tabs'. This is why `clearCompiledModuleCache` uses a `clear()`
   transaction, not `deleteDatabase`. A `clear()` readwrite tx is *not* blocked by other
   connections, so it sidesteps the IDB block. **But note the scope: `clear()` solves the
   IndexedDB block only. It does nothing for OPFS (problem 1) or the service worker (3.3).**

### 3.2 Problem A — a profile-wide marker turns *every* tab's reboot into a wipe-consumer racing every other tab's live OPFS handle

The selective flow's marker is **per-user**, and its consume runs *inside* `ensurePowerSyncReady`
(post-login, for that one user) — so there is exactly **one** consumer, gated behind that user's
login. A coarse design that arms **one profile-wide marker** and consumes it **at app boot
before login** makes *every* tab of *every* account a potential consumer of a *shared* marker.

Failure scenario: tabs A (locking) and B (sibling). A arms the marker and broadcasts; B reloads
immediately (`App.tsx` → `onWipeReload` → `reload`), reboots first, and runs the OPFS walk
**while A is still finishing its drain and hasn't released its sqlite handle**. B's
`removeEntry` on A's open `.db` throws `NoModificationAllowedError`; the retry loop (≈1 s)
absorbs a sibling *finishing* teardown, but not one **actively using** the DB or one that never
reloads (a frozen background tab, a `beforeunload` prompt). Retries exhaust → the wipe wedges,
half-done, marker still armed. `clear()` does **not** help here — OPFS is the load-bearing step
and is blocked exactly as today.

**This must be designed, not assumed away — and election alone is not enough.** A
`navigator.locks` election only *chooses* which boot tab runs `consumeDestroyAll`; it does
**not** make an already-loaded sibling **release** its wa-sqlite OPFS handle. A tab can win the
election while a frozen background tab — or one stuck in a `beforeunload` prompt — still holds
the DB, so `removeEntry` exhausts its retries and wedges the marker anyway. The real requirement
is an **exclusive barrier over the live DB handles**: every tab that opens the DB holds a
*shared* lock for the DB's lifetime, and the wiper must acquire that lock **exclusively** —
which by construction can't succeed until every holder has released (i.e. torn down its
wa-sqlite worker). Equivalently, an explicit teardown **ack handshake** where every live tab
confirms "handle released" before any tab wipes. Election picks the runner; the barrier/ack is
what actually guarantees no live sibling handle remains. (And `clear()` still removes only the
IDB half — OPFS is the gated step.)

### 3.3 Problem B — the service worker survives the reload and repopulates the Cache API

`public/sw.js` is a **separate worker process**, unaffected by a page reload. It serves the boot
page itself cache-first and owns persistent caches (`km-shell-*`, `km-assets-*`, `km-vendor`,
`km-meta`), writing a generation ledger on `install`/`activate`. So a page-side
`caches.delete(...)` at boot **races the SW re-populating** — the very act of loading the wipe
page re-`cache.put`s assets — and, crucially, **cannot reach state the SW holds**: for the media
design's planned SW-path **bearer-token store** (§7.2), a page-side delete can't guarantee the
SW has dropped a token it may hold in memory or re-stash on its next fetch. The current media
§7.2 design routes the purge *through* the SW ("Lock & Wipe must reach the SW") for exactly this
reason; a coarse page-side `caches.delete` is **not** an equivalent substitute.

**This must be designed, and `unregister()` alone is not enough.** Per the SW spec,
`ServiceWorkerRegistration.unregister()` only takes effect for *subsequent* navigations — the
**active worker keeps controlling the current page** (and any in-memory bearer token) until its
clients unload, so a bare `await unregister()` mid-sequence does **not** prove the SW dropped its
secrets before we clear caches and remove the marker. So the coarse path must **`postMessage`
the SW to drop its in-memory secrets + its caches and `await` an explicit ack** (the robust
path), *or* `unregister()` **and force a controller-change / second navigation** so the active
worker is actually discarded before the wipe is declared complete. "`caches.delete` every Cache"
is necessary but not sufficient for the SW participant.

### 3.4 Problem C — "run before any handle opens" is a concrete new boot gate, not a settled simplification

Today's consume survives only because it lives *inside* `ensurePowerSyncReady` (per-user,
post-login, under React Suspense), so "before this user's DB opens" is automatic. `src/main.tsx`
is **fully synchronous** — `registerServiceWorker()` then `createRoot(...).render(...)` with no
async gate. A profile-wide, pre-login consume requires a **new awaited boot gate before
`render`** — but **an async IIFE in the current `main.tsx` is not enough.** ES modules evaluate
*all* static imports before the module body runs, and `main.tsx` statically imports `Login` →
`src/services/supabase.ts`, which builds `createClient(…, {persistSession:true,
autoRefreshToken:true, detectSessionInUrl:true})` **at module load** (`supabase.ts:9-17`). So by
the time the IIFE's `await consumeDestroyAll()` runs, the Supabase auth client has already
rehydrated the persisted session into memory (and may auto-refresh / detect a URL session) —
leaving the supposedly logged-out wipe with a **live in-memory session that can render or
reconnect even after `localStorage.clear()`**. The same hazard applies to any lazy singleton
(`getWorkspaceKeyStore()` / `getCompiledModuleCache()`) whose module-eval touches storage.

So the gate needs an **import-minimal entrypoint**: a tiny entry that statically imports *only*
`consumeDestroyAll` (and what it needs), `await`s it, and **dynamically `import()`s the real
app afterward** — so nothing that touches storage/auth is statically evaluated ahead of the
wipe. (The alternative — an audited guarantee that *no* static import touches storage at
eval time — fails today, because `supabase.ts` does.) The `isDestroyAllPending()` short-circuit
keeps the cold-boot common case cheap. This is **the load-bearing structural change**, not a
one-liner — and it's exactly the kind of thing that "looks like a one-liner" and isn't.

### 3.5 The minimal sequence (with the three problems addressed)

**Lock time (page live):**
1. Best-effort drain the active account's pending uploads — `flushUploadQueue(ps_crud)` + the
   media byte-queue drain. (Queue-empty already implies acknowledgement — §2a; no extra wait.)
2. Arm **one** profile-wide marker (`kmp-destroy-all-pending`).
3. Signal all tabs to reload (profile-wide). Pair with the §3.2 **exclusive DB-handle barrier**
   (or teardown ack handshake) so the wipe has exactly one runner *and* no live sibling handle.
4. `window.location.reload()`.

**Next boot — at the §3.4 pre-render gate, before any store opens a handle:**
5. If armed, and this tab holds the §3.2 exclusive DB-handle barrier (so no live sibling handle
   remains): run the load-bearing destruction, each step
   leaving the marker armed on failure (retry next boot; never disarm on partial success):
   - **SW first (§3.3):** `postMessage` the SW to drop its in-memory secrets + caches and
     `await` its ack (or `unregister()` **and** force a controller-change / second navigation —
     bare `unregister()` leaves the active worker controlling this page) so it can neither hold a
     token nor repopulate caches mid-wipe;
   - recursively `removeEntry` the **entire OPFS root** (DB files + journal/wal/shm siblings +
     future `attachments/`), retrying on `NoModificationAllowedError`. This is still the gated
     load-bearing step (§3.1 / §3.2);
   - empty **every IndexedDB database** via per-store `clear()` (not `deleteDatabase`, §3.1).
     On Firefox `indexedDB.databases()` is unavailable → a **curated** known-list fallback;
     treat a list miss as a *silent incomplete wipe* (a future store left behind), so the list
     must be kept current or `deleteDatabase` + `onblocked` used for completeness;
   - `caches.delete(...)` every remaining Cache API entry.
6. Only after 5 fully succeeds: `sessionStorage.clear()` + `localStorage.clear()` (this removes
   the marker — no allowlist, §2b). Clearing storage **last** is what gives 5 the "still armed
   on failure → retry next boot" guarantee — but that guarantee is only as good as step 5
   actually *throwing* on every incomplete sub-step (hence the Firefox-list caveat above).

What genuinely simplifies vs. today: no `dbFilenameForUser` threading, no per-user key scoping,
no compiled-cache "clear after the file delete" ordering *for the single-tab case*. What does
**not** collapse: the OPFS open-handle gating (now a cross-tab DB-handle barrier), the SW
participant (now a handshake), and the boot placement (now a real import-minimal gate). Honest
tally: coarse trades
per-store wipe wiring for SW + cross-tab + boot-gate wiring — comparable, not free.

---

## 4. Interaction with the media-attachments design (PR #230)

This is the strongest argument for coarse. The media design already **references**
`destroyAllLocalData()` once (§7.3, where it notes a coarse wipe makes the attachment store's
wipe "not a differentiator" between its decryption-boundary options), and §18 calls out "a
second store in the lock-wipe lifecycle" as one of its biggest complexity sources. A coarse
primitive lets that doc **drop the *storage-wipe* half** of several bespoke participants —
though note this is orthogonal to the doc's own open fork (SW-decrypt vs app-thread-decrypt),
which coarse does **not** decide:

- **§7.2 ("Lock & Wipe must reach the SW")** mandates a *marker-gated, must-block-marker-clear*
  purge of `caches.delete('assets:<userId>')` + the SW token store. A coarse boot-time nuke
  covers the **Cache/IDB storage** under one marker — **but only if it includes the SW
  purge handshake of §3.3** (`postMessage`→ack; bare `unregister()` is insufficient). A
  page-side `caches.delete` alone does *not* subsume the
  SW token store; that was an overstatement in an earlier draft. With the handshake, §7.2
  collapses to "covered by the coarse wipe."
- **§8 (byte replica / display cache)** and **§9 (durable upload queue)** each carry a "this
  store is a Lock & Wipe participant too" clause with `user_id`-namespaced purge keys. Under
  coarse the **purge half** of each — replica, display cache, upload-queue store — is free (OPFS
  + IDB + Cache all go at once). The per-user namespacing is no longer needed *for wipe* (it may
  still be wanted for **drain** scoping and read-time multi-account isolation, §7/§16 — separate
  concerns). The **per-asset hash mirror** is *not* a wipe concern at all: it exists because the
  SW can't read app state (§7.1.1), so coarse clears its storage but doesn't remove the *need*
  for it — don't credit that to the wipe.
- **§15 phase 3** lists "the marker-gated boot-time purge of cache + token + hash-mirror (§7.2),
  covered by `lockAndWipe`-flavored tests incl. a 'plaintext survives lock' regression." Under
  coarse (with §3.3) that purge is one shared primitive, tested once, rather than per-store.
- **§17 / §18** get weaker on the "second store in the lock-wipe lifecycle" axis: coarse removes
  the *per-store* lifecycle (it's all just "in the origin, the nuke gets it") — provided §3.3 is
  honoured for the one store (the SW caches) a page can't reach by itself.

**What coarse does *not* subsume — keep these:**

- The **best-effort byte-queue drain** before the wipe (§9 upload + §10.1 confirm). Coarse
  removes the *purge* half, not the *drain* half — same as `flushUploadQueue` for `ps_crud`.
- The **`ps_crud` compensating-delete** (§9): for an asset block whose *metadata synced* but
  *bytes never uploaded*, enqueue a delete so peers don't render a permanently-broken embed.
  That's **fleet/peer consistency**, which a *local* nuke can't fix; it rides the existing
  `ps_crud` flush and stays regardless of coarse-vs-selective.

Net: coarse lets §7.2/§8/§9/§15/§17/§18 drop "Lock & Wipe participant" *storage wiring* from
every byte store, **once the coarse primitive itself reaches the SW (§3.3)**. It does not
resolve the media doc's decryption-boundary fork, and the hash mirror survives as a
boundary concern.

---

## 5. Fallback design: if you must hand-roll the wipe

> **The recommendation is §0 (delegate to the platform).** This section is retained only for the
> §0.4 last-resort case — you need *save-then-wipe in one gesture* **and** can't emit
> `Clear-Site-Data`. If you do delegate, build only the thin §0.3 action (confirm → optional
> `flushUploadQueue` → trigger-or-guide) and ignore the machinery below.

If you genuinely must hand-roll: a coarse `destroyAllLocalData()` beats the selective flow —
*on the strength of the security/selectivity collapse (§1/§2b) and the media-participant
subsumption (§4), not on the wipe being mechanically simpler (§3).* Concretely:

1. **`destroyAllLocalData()` becomes the action** behind `lock_and_wipe_local_data`: drain the
   active account (§2a), arm one profile-wide marker, signal reload + acquire the §3.2 exclusive
   DB-handle barrier, reload. Destruction at the §3.4 import-minimal gate: SW purge handshake (§3.3) →
   OPFS root → IDB `clear()` → Cache delete → storage clear last. No preserve-allowlist (§2b).
2. **Drop the selective machinery** (per-user key scoping in the wipe path, per-user marker,
   per-user DB-file consume, compiled-cache ordering) rather than carry two flows. If product
   later wants "re-lock without logging out," add it back as a *narrow* variant.
3. **Point true-paranoia users at the browser's "clear all site data"** for zero-residue.
4. **State the costs in the confirm dialog** (§2a): signs you out; erases **all** local data
   for **every** account on this device, including unsynced changes that can't be saved first;
   **total, unrecoverable** for a local-only account; and you'll **re-paste each E2EE workspace
   key** afterward (§2b).

### Required design work (the part that isn't free)

- **An exclusive barrier over live DB handles**, not just a single-consumer election (§3.2):
  every tab holds a shared `navigator.locks` lock for the DB's lifetime and the wiper acquires
  it exclusively (or a teardown ack handshake). Election alone picks a runner but doesn't make a
  frozen / `beforeunload`-stuck sibling release its OPFS handle.
- **An SW purge handshake** — `postMessage`→ack (or `unregister()` + forced controller-change);
  bare `unregister()` is insufficient (§3.3), and without this the Cache/token participant isn't
  actually wiped.
- **An import-minimal boot entrypoint** (§3.4), not just an async IIFE: statically import only
  `consumeDestroyAll`, `await` it, then **dynamically `import()`** the app — because static
  imports (incl. `supabase.ts`'s `createClient(persistSession:true)` at module load) evaluate
  before any IIFE body and would rehydrate an auth session into memory ahead of the wipe.
- **A current curated IDB known-list** for the Firefox `databases()` gap, or `deleteDatabase`
  + `onblocked`, so a missed store isn't a silent incomplete wipe (§3.5).

### Rough scope

- **New:** `destroyAllLocalData()` (drain + elect + arm + signal) and a boot-time
  `consumeDestroyAll()` (SW purge → OPFS → IDB `clear()` → Cache → storage). Roughly the size of
  today's `lockAndWipe.ts`, with *different* internals — less per-user threading, more cross-tab
  + SW + boot-gate orchestration.
- **Move the boot consume earlier** — from inside `ensurePowerSyncReady` (per-user, post-login,
  `repoProvider.ts:207`) to a pre-render gate in `src/main.tsx` (§3.4). This is the main
  structural change.
- **Callers:** `defaultShortcuts.ts:524` keeps confirm + drain + reload but calls the coarse
  primitive; the confirm copy changes from "you stay signed in" (`defaultShortcuts.ts:536`) to
  "you'll be signed out and all local data on this device is erased" + the §4 cost list.
- **Delete (from the wipe path):** per-user `clearForUser` *as used by the wipe* (the method may
  stay for other callers), the per-user `PENDING_WIPE` marker, `consumePendingWipe`'s per-user
  file delete + compiled-cache ordering, and the `dbFilenameForUser`/`removeOpfsDbFile` wipe
  wiring (export/import still use them).
- **Keep:** `flushUploadQueue` (and `UploadQueueProbe`/`FlushResult`) — the data-loss guard,
  orthogonal to coarse-vs-selective. The cross-tab reload signal stays but becomes profile-wide
  (drop the per-user match in `onWipeReload`, `App.tsx:264`) **and** gains the §3.2 DB-handle
  barrier — that's a behavior change, not a no-op.

### Test implications

- **`lockAndWipe.test.ts`:**
  - `flushUploadQueue` block — **unchanged**.
  - `lockAndWipe commit` block — **replaced** by `destroyAllLocalData` arm/drain/elect tests. The
    "preserves mode pins" test (`lockAndWipe.test.ts:139`) is **deleted**; the inverse becomes
    the assertion (`consumeDestroyAll` clears `kmp-e2ee-mode:*` too).
  - `consumePendingWipe` block — **replaced** by `consumeDestroyAll` tests: SW purge invoked
    before storage steps; OPFS retry on `NoModificationAllowedError`; IDB via `clear()` (or a
    `deleteDatabase`+`onblocked` test proving the marker stays armed); a **DB-handle barrier**
    test (a second "tab" still holding the lock/handle blocks the wipe — no half-wipe — until it
    releases); marker stays armed on any incomplete step; storage cleared **last**.
  - cross-tab block — now also asserts the DB-handle barrier (a live sibling handle blocks the
    wipe), not just reload fan-out.
- **Media design's `lockAndWipe`-flavored tests (§7.2 / §15 phase 3):** collapse to one
  `consumeDestroyAll` test ("SW purged + Cache + IDB + OPFS cleared") **including the SW
  handshake** — that, not a page-side `caches.delete` assertion, is the real "plaintext survives
  lock" regression.

### Decisions resolved / left open

- **Resolved: no security carve-out** — pins carry no security weight post-rollout-removal
  (§2b). A pin carve-out remains available *purely* as a UX softener for the re-paste-everything
  cost; product has accepted that cost, so default to dropping pins.
- **Open (engineering, not policy):** the §3 mechanics — the DB-handle barrier / teardown-ack shape, SW
  handshake vs unregister, and the exact boot-gate placement — are real design choices that
  must be settled before implementation. They don't change the recommendation; they're why "as
  written, coarse is not yet a drop-in simplification."

---

## Appendix — prototype sketch (feasibility, not wired in)

Illustrative, not production code. It shows the *destruction* primitives are reachable; it does
**not** show the §3 orchestration (the DB-handle barrier, SW handshake, the `main.tsx` boot
gate), which is the part that needs real design. Portability caveats: `indexedDB.databases()`
exists on Chromium/WebKit but **not Firefox** (hence the known-list fallback), and OPFS
`FileSystemDirectoryHandle.entries()` async iteration has uneven support and isn't in the lib
typings (the `@ts-expect-error` below). So "the enumeration APIs exist" holds on Chromium/WebKit
with a Firefox fallback, not universally.

```ts
const DESTROY_ALL_MARKER = 'kmp-destroy-all-pending'

// ── Lock time: drain (active account), elect a single consumer, arm, signal, reload. ──
// NOT shown: the navigator.locks election / teardown handshake (§3.2) the signal must pair with.
export const destroyAllLocalData = (): void => {
  localStorage.setItem(DESTROY_ALL_MARKER, '1') // single profile-wide marker, not per-user
}

export const isDestroyAllPending = (): boolean =>
  localStorage.getItem(DESTROY_ALL_MARKER) === '1'

// ── Next boot, at the §3.4 import-minimal gate, holding the §3.2 exclusive DB-handle barrier. ──
export const consumeDestroyAll = async (): Promise<boolean> => {
  if (!isDestroyAllPending()) return false

  // 0. SW FIRST (§3.3): a page-side caches.delete can't reach the SW's in-memory state, and the
  //    SW repopulates caches by serving the boot page. unregister() is NOT enough on its own —
  //    per spec it only affects subsequent navigations, so the active worker keeps controlling
  //    THIS page (and any in-memory token) until it unloads. So message the SW to drop its
  //    secrets + caches and await an ack; unregister() + a forced controller-change is the
  //    alternative. (Sketch shows the ack path; the SW side must implement the handler.)
  await purgeServiceWorker() // postMessage({type:'wipe'}) → await {type:'wiped'} ack, with timeout

  // 1. OPFS tree — STILL the gated load-bearing step. clear() (step 2) does NOT help here: a
  //    sibling tab that hasn't released its sqlite handle blocks removeEntry exactly as today,
  //    which is why §3.2's exclusive DB-handle barrier (not election alone) must guarantee no
  //    live sibling here. Throws
  //    after retries → marker stays armed (step 4 not reached) → retry next boot.
  await withRetry(async () => {
    const root = await navigator.storage.getDirectory()
    // @ts-expect-error entries() is async-iterable in the OPFS spec but not in the lib typings
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true })
    }
  })

  // 2. IndexedDB — empty each DB via a clear() tx per store (not deleteDatabase: clear() isn't
  //    blocked by other connections). On Firefox indexedDB.databases() is undefined → a CURATED
  //    known-list; a list miss is a SILENT incomplete wipe (a future store survives), so keep it
  //    current or use deleteDatabase+onblocked for completeness.
  const dbs = (await indexedDB.databases?.()) ?? KNOWN_IDB_FALLBACK.map(name => ({ name }))
  await Promise.all(dbs.map(({ name }) => name && clearAllStores(name)))

  // 3. Any remaining Cache API entries (the SW already unregistered in step 0).
  if (typeof caches !== 'undefined') {
    await Promise.all((await caches.keys()).map(k => caches.delete(k)))
  }

  // 4. Only after 0–3 fully succeed: storage in full (also removes the marker — no allowlist).
  //    "Last" only buys the retry guarantee if every prior step THROWS on incomplete work.
  sessionStorage.clear()
  localStorage.clear()
  return true
}
```

What the sketch confirms: the destruction needs *no per-user input* and *no allowlist*, and the
enumeration APIs are reachable (with the Firefox/OPFS caveats above). What it deliberately omits
is exactly what §3 shows is not free — the DB-handle barrier, the SW handshake placement,
and the pre-render boot gate. Those are the difference between "the primitives exist" and "the
coarse wipe is safe to ship."
