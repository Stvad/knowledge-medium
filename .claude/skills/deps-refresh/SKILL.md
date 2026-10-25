---
name: deps-refresh
description: Refresh this repo's dependencies to the newest versions its release cooldown allows, and open a PR. Use for the scheduled dependency update, or when asked to update / upgrade / bump dependencies or run a dependency audit. Covers the same-major refresh, the override floors, the scaffold pins, GitHub Actions, the standalone extension install, when to take or hold a major, and when to stop.
---

# Dependency refresh

The output is one PR with one commit per concern. It takes everything safe under the cooldown and names everything it holds back, with the reason. Never merge it.

## Ground rules

- `minimumReleaseAge` in `pnpm-workspace.yaml` (7 days) governs every resolution. Never lower it or route around it:
  - not in either `pnpm-workspace.yaml`;
  - not with a `--config.minimumReleaseAge` flag or a `pnpm_config_*`/`npm_config_*` variable;
  - not by approving pnpm's interactive prompt;
  - never with `minimumReleaseAgeExclude`, or a new `overrides` entry that pulls a version in.

  `ERR_PNPM_NO_MATURE_MATCHING_VERSION` means the version is held. A security fix still inside the cooldown goes in the PR's Audit section with the date it clears.
- Start from an up-to-date master on a fresh branch, with a clean tree.
- **Baseline.**
  1. Run `pnpm install --frozen-lockfile` here and in `agent-extensions/social-media-publisher`.
  2. Run `pnpm run check` once on the untouched tree, and record its last line and the test count.
  3. If it isn't `check: PASS` (after the one re-run §4 allows), stop and report: master is red, and a refresh doesn't fix that.
- **Snapshot.**
  - Run `node scripts/deps-report.mjs`, then again with `--cwd agent-extensions/social-media-publisher`.
  - Record `pnpm audit`'s counts. It exits 1 whenever it finds an advisory; that is a finding, not a failure.

## 1. Same-major refresh (first commit)

1. Run the commands under the report's "Apply with": one `pnpm --filter <project> up name@version …` per project, then `pnpm up -r`. Bump an aliased dependency (an `npm:` specifier, such as `typescript-native`) by hand, as the report says.
2. Raise every `overrides` entry in `pnpm-workspace.yaml`:
   - to its direct dependency's specifier;
   - or, for an override with no direct dependency, to `^` plus the version the lockfile resolves.

   Then run a plain `pnpm install`, so the lockfile records the new overrides. Without both halves, the frozen install in §4 fails.
3. Mirror the toolchain pins in `packages/agent-cli/src/scaffold.ts`. The scaffolded extension's devDependencies follow the app's.
4. If `src/vendor/vendorEntries.test.ts` fails after a React bump, do what its message says, in the React bump's commit.
5. In the standalone install, run the commands its own report printed. They carry `-C agent-extensions/social-media-publisher`. Its dependencies are exact pins, and only those commands move them.
6. Remove a direct dependency nothing references, instead of bumping it.
   - Check its imports, config keys, CSS `@import`/`@plugin`, `package.json` scripts and bins, workflow files, and plugins named by string.
   - An `@types/*` package counts as used when its runtime package is.
   - When unsure, keep it.
7. Same-major bumps of a package on §2's always-hold list go in their own commit. Quote their changelog lines in the PR under **Data-path updates**.

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

  `@types/*` packages are tooling, not on this list.
- **Hold it** when a peer range blocks it. Check the peer each run instead of assuming it still blocks.
  - Example: typescript-eslint's `typescript` peer. `typescript` stays on the newest version that peer allows, and the native compiler is a separate `typescript-native` alias.
- **Hold it** when you could not verify a behaviour change.

## 3. GitHub Actions and pnpm

- Take an action major only when both hold:
  - its latest release is at least 7 days old (the report's "released" column);
  - a workflow that runs on pull requests uses it, so the PR's own CI exercises it.

  Otherwise hold it, and name the workflows that run only after merge or on a schedule.
- Put Actions bumps in the last commit. If a push is refused over a workflow file, drop that commit and list those bumps as held.
- If the report could not read the releases, read them with the GitHub MCP tools. Never go looking for a token.
- Leave a SHA-pinned ref alone unless a comment beside it says which tag it tracks.
- `packageManager`:
  - A pnpm patch or minor goes in the first commit. Set `agent-extensions/social-media-publisher/package.json`'s pin to the same version.
  - A pnpm major changes installs for every worktree and agent, so hold it for its own PR.

## 4. Verify (all of it, before the PR)

- `pnpm install --frozen-lockfile` passes, both here and in `agent-extensions/social-media-publisher`.
- `pnpm run check` ends in `check: PASS`, and the test count doesn't drop below the baseline. If it ends in `check: FAIL`:
  - if every verdict reads `failed only under load`, re-run the whole gate once;
  - if the re-run again shows only load verdicts, proceed and list those files under Verification as load flakes;
  - any `fails alone too` is a real break.
- `pnpm build` passes.
- The extension checks CI runs pass: `pnpm agent types --force`, then each `agent-extensions/<name>` package's `check` script.
- `git status --porcelain` is empty after the checks, so nothing rewrote a lockfile behind your back.
- Run `pnpm audit` again and compare it with the snapshot.
- A bump that breaks any of this, without a small and mechanical fix:
  - put that package back to its current version;
  - list it under Held with the failing test;
  - verify again.

  Never edit a test, a lint rule, a tsconfig option or the gate to make a bump pass, beyond what its migration guide requires.

## 5. The PR

- Title it `deps: refresh <YYYY-MM-DD>`.
- Body sections:
  - **Changes**, per commit.
  - **Data-path updates** (§1.7).
  - **Majors taken**, with what was verified.
  - **Held**: package, target, reason.
  - **Audit**: before → after. For anything left, give the date its fix clears the cooldown and whether the shipped app can reach it.
  - **Verification**: the baseline and final test counts, and any load flakes.
- Paste the report's tables as the appendix.

## In a cloud session

- Don't run `bd`; follow-ups go in the PR body.
- Use the Node major in `.nvmrc`. Node 25+ ships no corepack, so install pnpm at the `packageManager` version with `npm i -g pnpm@<version>` if it's missing.
