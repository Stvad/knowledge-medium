# PR preview deployments

> **Status:** current — last verified against code 2026-07-02 (`.github/workflows/deploy-pages.yml`, `.github/workflows/pr-preview.yml`).

Every pull request gets its own live, clickable build of the app so you can
open it and click around before merging:

```
https://stvad.github.io/knowledge-medium/pr-preview/pr-<number>/
```

`rossjrw/pr-preview-action` posts a sticky comment on the PR with that link on
each push, and removes the preview when the PR is merged or closed.

## How it works

Both production and previews are served from **one `gh-pages` branch**, because
GitHub Pages serves a single site per repo:

- `gh-pages` **root** — production (`.github/workflows/deploy-pages.yml`, on push
  to `master`). Built with `APP_BASE_PATH=/knowledge-medium/`.
- `gh-pages` **`pr-preview/pr-<n>/`** — one subtree per open PR
  (`.github/workflows/pr-preview.yml`, on `pull_request`). Built with
  `APP_BASE_PATH=/knowledge-medium/pr-preview/pr-<n>/`.

The build is already base-path aware: Vite's `base` comes from `APP_BASE_PATH`
(`vite.config.ts`), the service worker registers at `${BASE_URL}sw.js` scoped to
that path (`src/registerServiceWorker.ts`), and `inject-sw-build-id.mjs`
base-prefixes precache URLs. So a subpath preview is fully self-contained and
its service worker is scoped to its own path — it never touches production's.

Coexistence on the shared branch is kept safe by two settings on the production
deploy: `clean-exclude: pr-preview` (production never wipes live preview
subtrees) and `force: false` (a normal fetch+rebase push, so a concurrent
preview deploy isn't force-overwritten). The two workflows also use separate
concurrency groups so a queued preview can't cancel a queued production deploy.

### Why same-origin matters here

Previews live on `stvad.github.io` (only the path differs), so two referrer /
origin-scoped things keep working with no extra config:

- the **Google Maps** key (HTTP-referrer restricted to the Pages host), and
- the **agent bridge** origin allowlist (`https://stvad.github.io`, README).

A different host (Netlify/Vercel/`*.pages.dev`) would have needed both updated.

## One-time setup (required — the workflows don't work until this is done)

The switch from the Pages *artifact* flow to *branch* serving needs one manual
change, and the order matters so production is never dark:

1. **Merge this to `master`** (or run **Deploy Pages** via *workflow_dispatch*).
   This runs the new production workflow, which creates/populates the
   `gh-pages` branch with an identical build. The live site is still served by
   the previous artifact deploy at this point, so nothing changes yet.
2. Confirm the `gh-pages` branch now exists and has the built site at its root.
3. **Settings → Pages → Build and deployment → Source → "Deploy from a
   branch"**, branch **`gh-pages`**, folder **`/ (root)`**, Save. The live site
   is now served from the branch — the same build — so the cutover is seamless.

After that, master pushes update the root and PRs manage their own
`pr-preview/pr-<n>/` subtree automatically.

### If secrets are environment-scoped

The workflows read `VITE_*` as `vars.X || secrets.X` at the repo level (no
`environment:` block). If those values were configured as **environment**
secrets under the old `github-pages` environment rather than **repository**
secrets/variables, the "Validate build variables" step fails fast (before any
deploy) — move them to repository-level secrets/variables (Settings → Secrets
and variables → Actions). This is the standard setup and almost certainly
already the case.

### If a preview push 403s

The workflows request `contents: write` explicitly, which is enough on its own.
If a push is still rejected, enable Settings → Actions → General → Workflow
permissions → **Read and write permissions**.

## Notes / limitations

- **Forks are skipped by design.** Fork PRs get neither the `VITE_*` secrets nor
  write access to `gh-pages`, so the preview job is gated to same-repo PRs. All
  PRs to this repo come from same-repo branches.
- **Shared backend.** Previews point at the same Supabase / PowerSync as
  production (same `VITE_*`). A preview is a preview of the *frontend*; a PR that
  changes data shapes can read/write real data. Use a scratch page.
- **`gh-pages` history grows** (no `single-commit`, since squashing the branch
  would drop live preview subtrees). Squash the branch manually if it ever gets
  unwieldy.
- `public/.nojekyll` disables Jekyll on the branch-served site (Jekyll would
  otherwise drop `_`-prefixed paths).
