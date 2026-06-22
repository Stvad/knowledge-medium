# Lock & Wipe: should the selective flow become a coarse `destroyAllLocalData()`?

Design investigation. **No code change in this doc** — it recommends a direction and
scopes it. Grounded against `src/sync/keys/flows/lockAndWipe.ts`, `keyStore.ts`,
`modePin.ts`, `resolver.ts`, `src/data/repoProvider.ts`, `src/utils/exportSqliteDb.ts`,
`src/shortcuts/defaultShortcuts.ts`, `docs/e2ee-design.html` §6, and the media-attachments
design (PR #230) §7.2 / §7.3 / §8 / §9 / §15 / §17 / §18.

## TL;DR

**Recommend: replace the selective flow with a coarse `destroyAllLocalData()` as the
single "panic / lock this device" action — but with one small, principled carve-out: the
boot-time nuke preserves the E2EE *mode pins* (and the planned pin-seed marker).** Those
two are the *only* piece of today's selectivity that is security-load-bearing rather than
edge-case convenience. Everything else the selective flow scopes or preserves
(per-user key clearing, per-user DB-file targeting, keeping the session alive) is either
an artifact of the shared key store / per-user DB file, or a deliberate "don't log out"
choice that the threat model doesn't actually require.

A coarse primitive also subsumes, **for free**, every bespoke "Lock & Wipe participant"
the media-attachments design is currently forced to wire by hand (SW asset cache, bearer-
token store, per-asset hash mirror, the durable byte replica/display cache, the byte
upload queue). That is a large, real chunk of complexity the media doc is already leaning
toward dropping (its §7.3 and §18 say as much).

Keep one thing regardless of coarse-vs-selective: the **best-effort upload drain** before
the wipe (`flushUploadQueue` for `ps_crud`, plus the media byte-queue drain), so a deliberate
wipe doesn't silently lose unsynced edits.

---

## 1. What's selective today, and which reasons still matter

`lockAndWipe` (lock time) + `consumePendingWipe` (next boot) deliberately scope or preserve
six things. Enumerated, with the reason and whether it still holds:

| # | Selective / preserved | Why it's scoped today | Does the reason still matter? |
|---|---|---|---|
| 1 | **Key clear is per-user** — `keyStore.clearForUser(userId)`, not a whole-store clear | The IndexedDB key store `km-e2ee-keys` is **shared across every account in the browser profile**; wiping account A must not drop B's WKs (which would lock B's E2EE workspaces without wiping B's DB) | **Edge-case only.** Matters *only* when a second account is signed into the same profile. Typical usage is ~2 users across a few devices; two accounts in one browser profile is the exception. |
| 2 | **DB-file wipe is per-user** — marker + delete keyed to `kmp-v6-<userId>.db` | Same reason: the SQLite file is per-user, so the wipe must not delete account B's DB | **Edge-case only**, same as #1. |
| 3 | **Mode pins preserved (all users)** — `kmp-e2ee-mode:*` in localStorage, never touched | An E2EE workspace whose WK was just dropped must re-enter its **locked read-only** state on reboot, not be re-evaluated as never-pinned and **silently downgraded to plaintext** | **Yes — genuinely load-bearing.** This is the one piece of selectivity that defends a real security invariant (see §2 and the e2ee §6 analysis below). |
| 4 | **Pin-seed marker preserved** (planned; `e2ee-design.html` §6 rule 3 rollout bullet — *not yet in code*) | The one-time "trust the server's `encryption_mode` during rollout" seed must **never re-fire** on the empty DB a wipe recreates, or a hostile server could pin an E2EE workspace `plaintext` with no user interaction | **Yes — load-bearing when it lands.** Must join the preserve-list with #3. |
| 5 | **Session preserved — NOT a logout** — you stay signed in; synced data re-downloads | Lock & wipe is framed as "re-lock *this device*," not "sign out." It's the deliberate scoping that distinguishes it from logout (see file header §9.2 / `defaultShortcuts.ts` copy) | **No — this is a *choice*, not a constraint.** The threat model (destroy local plaintext on this device) is fully served by a logout-to-clean-slate. Keeping the session alive is a UX nicety, and it's the main thing coarse changes. |
| 6 | **Compiled-extension cache** (`km-extension-compiled`) | — | **Not selective at all.** It's already cleared *wholesale* (no per-user/workspace dimension) at boot by `clearCompiledModuleCache`. Coarse changes nothing here except it stops being a special-cased participant. |

**Net:** of the six, only **#3 and #4** encode a reason that still matters. #1/#2 are pure
consequences of the shared-key-store / per-user-DB-file layout and only bite the multi-
account-in-one-profile edge case. #5 is a deliberate "don't log out" decision the security
goal doesn't require. #6 is already coarse.

So "nearly all of the complexity comes from selectivity, not from destruction" is correct —
and more specifically, **almost all of that selectivity is either edge-case-only (#1, #2) or
a UX choice (#5)**. The small kernel that's actually security-load-bearing (#3, #4) is a
*localStorage key-prefix allowlist* — cheap to keep even under a coarse nuke.

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
DB re-downloads from the server on next sign-in, B re-pastes the WK for E2EE workspaces
(which the pin survival, §2b, keeps as a *locked* prompt, never a downgrade). It's heavier
than today (B has to re-auth and re-paste), but it's not data loss beyond the local-only /
unsynced edits a wipe is *meant* to destroy. For the security goal — *destroy local
plaintext on this device* — wiping the whole profile is squarely acceptable; a user paranoid
enough to want zero residue would reach for the browser's "clear all site data" anyway (and
that's the right tool for *that* job — see §5).

### 2b. The pin / seed downgrade defense (the #3/#4 reasons) — the one real correctness issue

This is the part that *cannot* be hand-waved, and it's the reason the recommendation keeps a
carve-out rather than nuking literally everything.

The mode pin — not the server's `encryption_mode` flag — is the authority on whether a
workspace is E2EE for this client (`resolver.ts`, `e2ee-design.html` §6 rule 1). It survives
the selective wipe **on purpose** so that after the wipe:

- an E2EE-pinned workspace whose WK was dropped re-enters the **locked** state
  (`getMaterializability → 'defer'`, read-only, "paste WK") — *not* re-quarantine, *not*
  downgrade;
- the rollout pin-seed (which trusts the server's flag exactly once) does **not** re-run on
  the freshly-recreated empty DB.

If a coarse nuke destroyed the pins (and seed marker), then on the next boot every workspace
is **unpinned**, and the workspace falls back into e2ee §6 rule 3's *first-encounter* logic:

- **Branch (a)** — server says `e2ee` → prompt for the WK before loading. **Safe**; a hostile
  server flipping the flag achieves at most a lockout, never a downgrade.
- **Branch (b)** — server says `none` on a workspace that is *really* E2EE → "encryption-
  uncertain quarantine," read-only, offering **both** "paste WK" *and* "confirm this is
  plaintext." A user who clicks *confirm plaintext* on their own E2EE workspace sets a
  durable `plaintext` pin = **silent downgrade**.
- **Seed re-fire** (worse) — if the planned pin-seed marker is also gone, the rollout seed
  could pin E2EE workspaces `plaintext` straight from the server's `none` flag with **no user
  interaction at all**.

So destroying the pins re-opens precisely the downgrade window the surviving-pins design was
built to close. **The fix is trivial and principled:** the boot-time coarse wipe preserves a
*localStorage key-prefix allowlist* — `kmp-e2ee-mode:*` (and the seed marker when it lands) —
while nuking everything else. The pins are **non-secret** (a workspace-id + an `e2ee` /
`plaintext` label — metadata, never content plaintext), so keeping them costs no plaintext-
at-rest. With that carve-out, coarse is **security-equivalent to selective on the downgrade
axis**, and re-login behaves identically (E2EE workspace re-prompts for its WK; seed never
re-fires).

> If a future "true panic, leave zero residue" mode is wanted, it can drop the pins too —
> but then it must lean on canary-quarantine (branch a/b) + hardened seed-gating instead, and
> the honest recommendation is to point that user at the browser's clear-all-site-data control
> rather than weaken the in-app default.

**Bottom line on cost:** the only cost that survives scrutiny is "it's a logout and it wipes
the whole profile." For the threat model that's acceptable. The downgrade defense is preserved
by a one-line allowlist, not by retaining the whole selective machine.

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
   *before any store opens a connection* sidesteps the block entirely.

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
5. If the marker is armed:
   - recursively `removeEntry` the **entire OPFS root** (DB files + journal/wal/shm siblings
     + future `attachments/` tree), retrying on `NoModificationAllowedError` to absorb a
     sibling still tearing down — same small retry loop as today;
   - delete/clear **every IndexedDB database** (key store, compiled cache, PowerSync IDB,
     future media upload-queue + hash-mirror);
   - `caches.delete(...)` **every Cache API** entry (future SW asset cache + token store);
   - clear `sessionStorage` and **all of `localStorage` *except* the preserve-allowlist**
     (`kmp-e2ee-mode:*`, the seed marker, and the wipe marker itself until step 6).
6. Disarm the marker; land on the logged-out login screen.

Two notable differences from today's `consumePendingWipe`, both *simplifications*:

- **No per-user filename resolution** — it blows away whole directories / whole databases, so
  there's no `dbFilenameForUser` threading, no per-user key scoping.
- **Placement moves earlier** — today's consume runs *inside* `ensurePowerSyncReady` (per-user,
  post-login). A profile-wide coarse wipe must run at **app boot, before the auth/repo
  providers mount and before any store singleton opens a connection** — which is *also* what
  makes `deleteDatabase` non-blocked (no connection exists yet) and guarantees nothing
  repopulates. That placement change is the main new wiring.

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
"lock & wipe this device" action**, with the small preserve-allowlist carve-out. Concretely:

1. **`destroyAllLocalData()` becomes the action** behind `lock_and_wipe_local_data`. It:
   (1) best-effort drains pending uploads (`ps_crud` + media byte queue — kept), (2) arms one
   profile-wide marker + broadcasts reload, (3) reloads to a logged-out clean slate, with the
   actual destruction done at next boot (§3 sequence) over the whole origin **except** the
   `kmp-e2ee-mode:*` pins and the pin-seed marker.
2. **Retain selective `lockAndWipe` only if a concrete per-account-preservation need appears.**
   Today there is none that outweighs the simplification: the only thing selective buys over
   coarse-with-allowlist is "keep a *second* account in the *same* profile signed in and un-
   wiped," which is the edge case (§2a). My recommendation is to **drop the selective machinery**
   (per-user key scoping in the wipe path, per-user wipe marker, per-user DB-file consume,
   compiled-cache ordering dance) rather than carry two flows. If product later wants a
   genuine "re-lock without logging out" affordance, add it back as a *narrow* variant, not as
   the default.
3. **Point true-paranoia users at the browser's "clear all site data"** for zero-residue (it
   also clears the pins + HTTP cache + cookies the in-app action intentionally preserves).

### Rough scope of the change

- **New:** `destroyAllLocalData()` (arm + drain + broadcast) and a boot-time `consumeDestroyAll()`
  that walks OPFS root, enumerates + clears IndexedDB, clears Cache API, and clears
  sessionStorage + localStorage-minus-allowlist. ~ the size of today's `lockAndWipe.ts`, but
  with simpler internals (no per-user threading).
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
    "preserves mode pins" test (`lockAndWipe.test.ts:139`) **stays and gets stronger** — it
    becomes the load-bearing "coarse wipe preserves the pin allowlist (no downgrade)"
    regression. The "refuses when localStorage can't arm" and "no half-state on key-clear
    failure" tests fold into "arming the single marker fails closed."
  - `consumePendingWipe` block — **replaced** by `consumeDestroyAll` tests: clears OPFS / IDB /
    Cache / storage-minus-allowlist; **preserves `kmp-e2ee-mode:*`**; retries OPFS removal on
    `NoModificationAllowedError`; leaves the marker armed (retry next boot) if the load-bearing
    destruction fails. The FIFO-fence / loader-invalidation testing guidance in `AGENTS.md`
    still applies to the broadcast-reload test.
  - cross-tab block — **mostly unchanged** (now profile-wide).
- **Media design's `lockAndWipe`-flavored tests (§7.2 / §15 phase 3):** these **no longer need
  to exist as separate per-participant purge tests.** The single `consumeDestroyAll` test that
  asserts "Cache API + IDB + OPFS all cleared, pins survive" *is* the "plaintext survives lock"
  regression the doc asks for — written once, not once per byte store.

### Open decision for the reviewer

The one genuine fork is **§2b's carve-out vs. a true-panic zero-residue mode.** My
recommendation keeps the pins (security-equivalent to today, non-secret, cheap). If you'd
rather the in-app action leave *nothing* — accepting reliance on canary-quarantine +
hardened seed-gating for the downgrade defense — say so and the allowlist drops to just the
in-progress wipe marker. I lean toward keeping the carve-out: it preserves a real invariant
for one prefix's worth of code, and "clear all site data" already exists for users who want
the scorched-earth version.

---

## Appendix — prototype sketch (feasibility, not wired in)

Shows the two halves and that the enumeration APIs exist (`navigator.storage.getDirectory()`
+ async-iterable entries, `indexedDB.databases()`, `caches.keys()`). Not production code —
no error/retry polish, no DI seams, illustrative only.

```ts
// localStorage prefixes the boot-time nuke must NOT clear (the downgrade defense, §2b).
const PRESERVE_LS_PREFIXES = [
  'kmp-e2ee-mode:',        // mode pins — set-once authority, no silent downgrade
  'kmp-e2ee-pins-seeded:', // planned rollout seed marker (e2ee §6 rule 3) — when it lands
]
const DESTROY_ALL_MARKER = 'kmp-destroy-all-pending'

// ── Lock time (page live): arm + reload. Destruction is deferred to boot. ──
// Caller (defaultShortcuts) still runs flushUploadQueue(ps_crud) + media-queue drain first,
// then broadcastWipeReload() to all tabs, then window.location.reload().
export const destroyAllLocalData = (): void => {
  localStorage.setItem(DESTROY_ALL_MARKER, '1') // single profile-wide marker, not per-user
}

export const isDestroyAllPending = (): boolean =>
  localStorage.getItem(DESTROY_ALL_MARKER) === '1'

// ── Next boot, BEFORE auth/repo providers mount and before any store opens a handle. ──
export const consumeDestroyAll = async (): Promise<boolean> => {
  if (!isDestroyAllPending()) return false

  // 1. OPFS tree — retry on NoModificationAllowedError to absorb a sibling tab still
  //    tearing down its wa-sqlite worker. The whole root goes (DB files + future attachments/).
  await withRetry(async () => {
    const root = await navigator.storage.getDirectory()
    // @ts-expect-error entries() is async-iterable in the OPFS spec
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true })
    }
  })

  // 2. Every IndexedDB database — non-blocking here because we run before anything opened a
  //    connection. (indexedDB.databases() is Chromium/WebKit; Firefox falls back to a known
  //    list: km-e2ee-keys, km-extension-compiled, PowerSync's, + future media stores.)
  const dbs = (await indexedDB.databases?.()) ?? KNOWN_IDB_FALLBACK.map(name => ({ name }))
  await Promise.all(dbs.map(({ name }) => name ? deleteDatabase(name) : null))

  // 3. Cache API — future SW asset cache + token store.
  if (typeof caches !== 'undefined') {
    await Promise.all((await caches.keys()).map(k => caches.delete(k)))
  }

  // 4. sessionStorage in full; localStorage minus the preserve-allowlist (and the marker,
  //    cleared last in step 5).
  sessionStorage.clear()
  for (const key of Object.keys(localStorage)) {
    if (key === DESTROY_ALL_MARKER) continue
    if (PRESERVE_LS_PREFIXES.some(p => key.startsWith(p))) continue
    localStorage.removeItem(key)
  }

  // 5. Disarm only after the load-bearing destruction (1–3) succeeded — same "keep the marker
  //    armed, retry next boot" guarantee the per-user consume has today, now for one operation.
  localStorage.removeItem(DESTROY_ALL_MARKER)
  return true
}
```

What the sketch confirms: the destruction needs *no per-user input* (no `userId`, no
`dbFilenameForUser`), the enumeration APIs to clear the whole origin exist, and the only
real subtlety left is the same two the codebase already handles — the OPFS open-handle retry
and running before any connection opens. The per-store ordering / best-effort-vs-load-bearing
matrix that `consumePendingWipe` + every media "participant" carries today collapses into the
single `if (destruction 1–3 succeeded) disarm` at the bottom.

