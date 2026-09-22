# PR preview deployments

> **Status:** current — last verified against code 2026-09-22 (`.github/workflows/deploy-pages.yml`, `.github/workflows/pr-preview.yml`, `.github/workflows/approved-pr-preview.yml`, `.github/workflows/remove-approved-pr-preview.yml`, `scripts/ensure-pages-published.sh`).

Every same-repository pull request gets its own live, clickable build of the app
so you can open it and click around before merging:

```
https://stvad.github.io/knowledge-medium/pr-preview/pr-<number>/
```

`rossjrw/pr-preview-action` posts a sticky comment on the PR with that link on
each push, and removes the same-repository preview when the PR is merged or
closed. Fork **preview builds** do not run automatically; a maintainer can
explicitly approve one current fork head for the same URL. Its sticky comment
records the approved SHA and deployment run.

## How it works

Both production and previews are served from **one `gh-pages` branch**, because
GitHub Pages serves a single site per repo:

- `gh-pages` **root** — production (`.github/workflows/deploy-pages.yml`, on push
  to `master`). Built with `APP_BASE_PATH=/knowledge-medium/`.
- `gh-pages` **`pr-preview/pr-<n>/`** — one subtree per open PR. Same-repo PRs
  use `.github/workflows/pr-preview.yml` on `pull_request`; maintainer-approved
  fork PRs use `.github/workflows/approved-pr-preview.yml`.
  Both build with `APP_BASE_PATH=/knowledge-medium/pr-preview/pr-<n>/`.

The build is already base-path aware: Vite's `base` comes from `APP_BASE_PATH`
(`vite.config.ts`), the service worker registers at `${BASE_URL}sw.js` scoped to
that path (`src/registerServiceWorker.ts`), and `scripts/inject-sw-build-id.ts`
base-prefixes precache URLs. So each preview's assets and its *own* service
worker are scoped to its subpath.

Previews share production's **origin** (`stvad.github.io`), so per-origin client
state (Cache Storage, OPFS, IndexedDB, localStorage) is a shared namespace with
production. The two riskiest overlaps are handled explicitly (namespaced per
deploy):

- **Service-worker caches / offline shell** (`src/sw/sw.ts`) — production's SW no
  longer intercepts or caches `/pr-preview/…` requests (so an offline production
  load can't boot a preview build), and each SW's `activate` GC deletes only its
  own deploy's generations, so a preview SW no longer evicts production's caches
  (and vice-versa). Verified in a real browser (both directions). A merged
  preview's SW then stops running, so its `km-shell-*`/`km-assets-*` caches would
  otherwise leak on the shared origin forever; on `activate` every SW also runs a
  cross-scope sweep (`computeReapableCaches`, `src/sw/ledger.ts`) that reclaims
  the generation caches + ledger entry of any **preview** scope untouched for 14
  days. It is preview-only by construction — production is never a preview scope,
  so the sweep is structurally incapable of reaping prod caches — and spares any
  generation a surviving scope still references.
- **Local SQLite DB** (`kmp-v6-<user>.db`, `src/data/repoProvider.ts`) — preview
  builds suffix the filename with `-pr-<n>`, so a preview gets its **own** local
  DB and a preview PR's client migration can't touch production's real store.
  Production's filename is unchanged.

> **⚠️ Still shared with production:** the **remote backend** (same Supabase /
> PowerSync — a preview reads/writes real synced data) and a few minor
> per-origin `localStorage` keys (e.g. the e2ee mode pin, last-workspace). So a
> preview is a preview of the *frontend* against live data — for anything that
> writes, use a scratch page (and, if you want belt-and-braces, a separate
> browser profile).

Coexistence on the shared branch is kept safe by two settings on the production
deploy: `clean-exclude: pr-preview` (production never wipes live preview
subtrees) and `force: false` (a normal fetch+rebase push, so a concurrent
preview deploy isn't force-overwritten). Each preview workflow serializes work
for its PR number in the `pr-preview-<n>` concurrency group; production keeps a
separate group, so a queued preview cannot cancel a queued production deploy.

### Publish reliability (retry the flaky publisher)

A push to `gh-pages` only updates the branch. What actually *serves* it is
GitHub's own auto-triggered **"pages build and deployment"** run (a dynamic
workflow we don't author), and that publisher is intermittently flaky — its
deploy step returns `Deployment failed, try again later.` or stalls in
`deployment_queued`. When a push's publish flakes, that push's content stays
**404 until the next successful publish sweeps it in** (any later build rebuilds
the whole branch HEAD). This bit the first production cutover and early previews.

Each deploying workflow therefore ends with an **`Ensure Pages published`** step
(`scripts/ensure-pages-published.sh`, needs `pages: write`). After the push, it
polls that deploy's own `version.json` path for the exact SHA stamped in its
`dist/version.json`. On a stall or failure, it requests a Pages retry with
`POST /pages/builds` for a few rounds. Seeing the expected SHA at the deploy's
path proves that particular content is live, even while another branch update is
also publishing. This is also what makes a routine `master` merge reliably go
live.

### Why same-origin matters here

Previews live on `stvad.github.io` (only the path differs), so two referrer /
origin-scoped things keep working with no extra config:

- the **Google Maps** key (HTTP-referrer restricted to the Pages host), and
- the **agent bridge** origin allowlist (`https://stvad.github.io`, README).

A different host (Netlify/Vercel/`*.pages.dev`) would have needed both updated.

## Maintainer-approved fork previews

**Deploy approved PR preview** is a manual workflow for a fork PR. The workflow
is available in the Actions UI only after this change is merged to `master`; run
it from the selected `master` branch, never from a PR branch. It takes:

- `pr_number`
- `head_sha`, the full, lowercase, 40-character head SHA to approve

It validates that the PR is open, targets `master`, and still has exactly that
head SHA before it builds. It checks the same facts again immediately before
publication. The build checks out that exact head, not a merge result, with a
read-only token and `persist-credentials: false`. It receives only public
`VITE_*` client configuration through the existing `vars.* || secrets.*`
fallback.

The build intentionally runs the approved contributor commit's install and build
scripts. It has no publishing credentials, disables dependency caching, and
uses `cache-mode: none`, GitHub Actions' enforced runtime cache restriction, so
fork code cannot use the dispatch on `master` to poison a cache. The separate
fresh publishing job checks out the trusted workflow commit, consumes only the
static artifact, and never checks out or executes contributor code or scripts.

Approving the workflow is therefore approval to publish and run that frontend on
the production origin/backend. The per-preview service-worker and local DB
namespaces prevent routine state collisions; their path-based DB naming is not a
security boundary against a frontend trusted on that origin.

Fork pushes never auto-update an approved preview. The URL keeps serving the
last approved SHA until a maintainer runs this workflow again with the new head.
The sticky comment records the approved SHA and the deployment run URL.

To approve a fork head in the GitHub UI:

1. Open the PR and copy its current **head commit** SHA. Confirm it is open and
   targets `master`.
2. Open **Actions → Deploy approved PR preview → Run workflow**, then select
   `master` as the workflow branch.
3. Enter the PR number and the complete lowercase 40-character SHA, then run
   the workflow.
4. Open the sticky preview comment to confirm its SHA and deployment-run link.

With GitHub CLI, this approves PR 1128's current head and explicitly dispatches
the trusted `master` workflow:

```sh
pr_number=1128
head_sha="$(gh pr view "$pr_number" --repo Stvad/knowledge-medium --json headRefOid --jq .headRefOid)"
gh workflow run "Deploy approved PR preview" \
  --repo Stvad/knowledge-medium \
  --ref master \
  -f pr_number="$pr_number" \
  -f head_sha="$head_sha"
```

The workflow rejects an abbreviated, uppercase, stale, closed, or non-`master`
PR head. Rerun it after a fork push to approve that new commit.

### Removal

`.github/workflows/remove-approved-pr-preview.yml` removes a fork preview when
its PR closes. Its `pull_request_target` trigger is limited to the trusted close
event, and it never checks out contributor code. It also supports
`workflow_dispatch` with `pr_number` for manual removal. The deploy and removal
workflows use the same per-PR concurrency group, so they cannot publish and
remove one fork preview concurrently. Same-repository automatic previews remain
managed by `.github/workflows/pr-preview.yml`.

## One-time setup (required — the workflows don't work until this is done)

The switch from the Pages *artifact* flow to *branch* serving needs one manual
change, and the order matters so production is never dark:

1. **Merge this to `master`** (or run **Deploy Pages** via *workflow_dispatch*).
   This runs the new production workflow, which creates/populates the
   `gh-pages` branch with an identical build. The live site is still served by
   the previous artifact deploy at this point, so nothing changes yet.
2. Confirm the built site is at the branch **root** — both `index.html` **and**
   `.nojekyll` at `gh-pages` `/`. The branch may **already exist** from a preview
   run, containing only `pr-preview/pr-<n>/` and *no root build* — mere existence
   is NOT readiness. Flipping the source before a production deploy populates the
   root would 404 production and leave Jekyll active site-wide (a root
   `.nojekyll` is what disables it; without it Jekyll strips the `_virtual/`
   chunks `preserveModules` emits, breaking previews too).
3. **Settings → Pages → Build and deployment → Source → "Deploy from a
   branch"**, branch **`gh-pages`**, folder **`/ (root)`**, Save. The live site
   is now served from the branch — the same build — so the cutover is seamless.

After that, master pushes update the root, same-repo PRs manage their own
`pr-preview/pr-<n>/` subtree automatically, and maintainers can approve a fork
head through the workflow above.

### If secrets are environment-scoped

The workflows read `VITE_*` as `vars.X || secrets.X` at the repo level (no
`environment:` block). If those values were configured as **environment**
secrets under the old `github-pages` environment rather than **repository**
secrets/variables, the "Validate build variables" step fails fast (before any
deploy) — move them to repository-level secrets/variables (Settings → Secrets
and variables → Actions). This is the standard setup and almost certainly
already the case.

### If a preview push 403s

The publishing jobs request `contents: write` explicitly, which is enough on its
own. If a push is still rejected, enable Settings → Actions → General → Workflow
permissions → **Read and write permissions**.

## Notes / limitations

- **Fork preview builds require explicit approval.** A fork's ordinary CI may
  still build its code, but this repository never automatically runs a fork
  preview build with the production client configuration or `gh-pages` publish
  permission. A maintainer uses the workflow above for a reviewed head.
- **Shared backend.** Previews use the same Supabase / PowerSync as production
  (same `VITE_*`); the SW caches and local DB are isolated per deploy, but the
  remote data and a few minor `localStorage` keys are shared (see the ⚠️ box). A
  preview is a preview of the *frontend* against live data — use a scratch page
  for anything that writes.
- **Merge-time branch race (self-limiting).** Merging a PR fires the production
  deploy (push→`master`) and a preview removal (`closed`) concurrently. Preview
  deploy/removal for a particular PR serialize in their shared group, and
  `force: false` makes branch updates fetch+rebase+retry, so production never
  goes dark; the worst case is a removed preview subtree that lingers
  (re-runnable, or cleared by a later branch squash).
- **`gh-pages` history grows** (no `single-commit`, since squashing the branch
  would drop live preview subtrees). Squash the branch manually if it ever gets
  unwieldy.
- `public/.nojekyll` disables Jekyll on the branch-served site (Jekyll would
  otherwise drop the `_virtual/` chunks `preserveModules` emits). It must sit at
  the branch **root**; the copy in each preview subtree is inert.

## Same-origin isolation (implemented)

Because previews share production's origin, per-origin client state is
namespaced by deploy to prevent routine cache and local-store collisions. This
is not a security boundary for an approved frontend:

- **`src/sw/sw.ts`** — (a) production's SW ignores `/pr-preview/…` requests
  (`isForeignPreviewRequest`), so it can't cache preview content under
  production's keys; (b) each SW's `activate` GC deletes only its own deploy's
  expired ledger generations rather than blanket-deleting every `km-*` cache on
  the origin, so a preview SW can't evict production's caches. Verified in a real
  browser (both directions).
- **`src/data/repoProvider.ts`** — `dbFilenameForUser` suffixes the local DB
  filename with `-pr-<n>` for preview builds only (`BASE_URL` under
  `/pr-preview/`); production's filename is byte-for-byte unchanged. The suffix
  is carved out of the user-segment budget to stay under wa-sqlite's 64-char
  pathname cap (covered by `repoProvider.test.ts`). This separates local files;
  it does not isolate production-origin credentials or the shared backend.

**Residual (not namespaced):** a few per-origin `localStorage` keys (the e2ee
mode pin `kmp-e2ee-mode:*`, last-workspace) remain shared. They're per-user and
low-risk for a same-user preview; namespacing them by deploy is a possible
future hardening if fuller isolation is wanted.
