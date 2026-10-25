---
name: deps-refresh
description: Refresh this repo's dependencies to the newest versions its release cooldown allows, and open a PR. Use for the scheduled dependency update, or when asked to update / upgrade / bump dependencies or run a dependency audit. Covers the same-major refresh, the override floors, the scaffold pins, GitHub Actions, the standalone extension install, and when to take or hold a major.
---

# Dependency refresh

The output is one PR with one commit per concern. It takes everything safe under the cooldown and names everything it holds back, with the reason. Never merge it, and never push to master.

## Ground rules

- `minimumReleaseAge` in `pnpm-workspace.yaml` (7 days) governs every resolution.
  - Never lower it, and never add a `minimumReleaseAgeExclude` to pull something in sooner.
  - A security fix still inside the cooldown goes in the PR's Audit section with the date it clears. Whether to make an exclusion is Vlad's call.
- Start from an up-to-date master on a fresh branch, with a clean tree.
- Snapshot first, after `pnpm install --frozen-lockfile` here and in `agent-extensions/social-media-publisher`. The report reads the lockfile, but the gate needs the install:
  - Run `node scripts/deps-report.mjs`. Run it again with `--cwd agent-extensions/social-media-publisher`, a standalone install with its own lockfile.
  - Record `pnpm audit` (counts by severity) and the test count from the last `pnpm run check`.
  - The PR compares against these.

## 1. Same-major refresh (first commit)

1. Run the two commands the report prints.
   - `pnpm up -r name@version …` names every same-major target. It keeps each specifier's pin style, and it is the only way to move an exact pin.
   - Then `pnpm up -r` updates everything else in range, transitive dependencies included.
   - Bump an aliased dependency (an `npm:` specifier, such as `typescript-native`) by hand, as the report says.
2. Set each `overrides` entry in `pnpm-workspace.yaml` to the specifier its direct dependency now carries, then run a plain `pnpm install` so the lockfile records the new overrides. Skip either half and the gate's `pnpm install --frozen-lockfile` fails, either with "specifiers in the lockfile don't match" or with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`.
3. Mirror the toolchain pins in `packages/agent-cli/src/scaffold.ts`. The scaffolded extension's devDependencies follow the app's.
4. React: extensions get the app's own React through the hand-written export lists in `src/vendor/`, which the page importmap points at. When a React bump changes React's exports or browser subpaths, `src/vendor/vendorEntries.test.ts` fails. Update the facades to the set it names. `react-dom/profiling` stays unmapped on purpose.
5. In the standalone install, run `pnpm -C agent-extensions/social-media-publisher up`. CI installs it with `--frozen-lockfile`.
6. Remove a direct dependency nothing references instead of bumping it.
   - Check with `git grep` for its imports, config keys, and CSS `@import`/`@plugin`.
   - An `@types/*` package counts as used when its runtime package is.

## 2. Majors (one commit each, or held)

For each row under "Eligible majors", read the release notes or migration guide from the current version to the target. Grep this repo for every API, option and config key the breaking changes touch.

- **Take it** only when all three hold:
  - it is dev, test or build tooling;
  - the breaking changes miss how this repo uses it, or the fix is small and mechanical;
  - the gate and the build pass.

  The commit message says what changed and what was checked.
- **Hold it, always**, when it can change stored data or how stored user content runs. Name it in the PR with what a dedicated PR would need:
  - `@powersync/*` and `better-sqlite3`: the local DB format and core schema migrations.
  - `@babel/standalone`: it compiles stored user extensions, so an output change breaks them on recompile.
  - Crypto (`@noble/*`, `@scure/*`), and `@supabase/*`.
- **Hold it** when a peer range blocks it. Check the peer each run instead of assuming it still blocks.
  - Example: typescript-eslint's `typescript` peer. `typescript` stays on the newest version that peer allows, and the native compiler is a separate `typescript-native` alias.
- **Hold it** when you could not verify a behaviour change.

## 3. GitHub Actions and pnpm

- For each action behind its latest major (see the report table), read the breaking changes and bump the `uses:` refs across `.github/workflows/`.
  - If the report says the GitHub API rate-limited it, set `GITHUB_TOKEN` and re-run it. Where no token is available, read each action's latest release with the GitHub MCP tools instead.
  - Leave a SHA-pinned ref alone unless a comment beside it says which tag it tracks.
- The report's esm.sh URL pins are agent extensions' runtime imports, not app dependencies. List them in the PR, but leave bumping one to a change to that extension.
- `packageManager`: a pnpm patch or minor goes in the first commit. Bump `agent-extensions/social-media-publisher/package.json`'s pin to the same version, since the standalone install pins pnpm separately. A pnpm major changes installs for every worktree and agent, so hold it for its own PR.

## 4. Verify (all of it, before the PR)

- `pnpm install --frozen-lockfile` passes.
- `pnpm run check` passes. Run it in the background and read its last line, `check: PASS`, not a pipe's exit code. The test count must not drop below the snapshot.
- `pnpm build` passes (it includes `check-dist-exports`).
- The extension checks CI runs pass: `pnpm agent types --force`, then each `agent-extensions/<name>` package's `check` script.
- Run `pnpm audit` again and compare it with the snapshot.

## 5. The PR

- Title it `deps: refresh <YYYY-MM-DD>`.
- Body sections:
  - **Changes**, per commit.
  - **Majors taken**, with what was verified.
  - **Held**: package, target, reason.
  - **Audit**: before → after. For anything left, give the date its fix clears the cooldown and whether the shipped app can reach it.
  - **Verification**, with counts.
- Paste the report's tables as the appendix.
- Published text carries no local paths and no workspace or private names.

## In a cloud session

- Read `docs/cloud-sessions.md` first. Don't run `bd`; follow-ups go in the PR body.
- Use the Node major in `.nvmrc`. Node 25+ ships no corepack, so install pnpm at the `packageManager` version with `npm i -g pnpm@<version>` if it's missing.
