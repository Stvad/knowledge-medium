---
name: publish-agent-cli
description: Build and publish a new version of the @knowledge-medium/agent-cli npm package (packages/agent-cli). Use when asked to release/publish/cut a new agent-cli (a.k.a. kmagent) version, bump its npm version, or push it to the registry.
---

# Publish a new agent-cli version

Releases `@knowledge-medium/agent-cli` (the `kmagent` CLI + bridge) to public npm. Run everything from `packages/agent-cli/`.

## Steps

1. **See what's live vs local.**
   ```bash
   npm view @knowledge-medium/agent-cli version   # published
   grep '"version"' packages/agent-cli/package.json
   git log --oneline <last-release-commit>..HEAD -- packages/agent-cli/src
   ```
   Pick the bump from the changes: pre-1.0, new commands/features → **minor** (`0.1.x` → `0.2.0`); fixes only → patch.

2. **Bump the version — then undo the lockfile damage.** `npm version` runs an install that, in this **yarn** workspace, churns `yarn.lock` and writes a stray `package-lock.json`. Only the `package.json` change should survive.
   ```bash
   cd packages/agent-cli && npm version <new> --no-git-tag-version
   cd ../.. && git checkout yarn.lock && rm -f package-lock.json
   ```

3. **Commit** just the version bump (per the commit-after-each-change convention). Leave the push to the user unless asked.

4. **Publish** (the package's `prepublishOnly` does a clean `build:clean && build` for you, so no need to pre-build):
   ```bash
   cd packages/agent-cli && npm publish --otp=<code>
   ```

5. **Verify:** `npm view @knowledge-medium/agent-cli version` shows the new version.

## Gotchas that actually bite

- **Publish builds the *whole app*, not just agent-cli.** `prepublishOnly` → `build` regenerates the vendored kernel-types `.d.ts` tree from the entire app's `@/` source (`scripts/build-kernel-types.mjs`). So a half-finished refactor anywhere in `src/` — e.g. a dangling `@/foo.js` import from an uncommitted rename — **fails the publish**, even though agent-cli itself compiles. A plain `yarn run build` can pass here while publish fails, because it's *incremental* (cached `.tsbuildinfo`) and skips re-checking unchanged files; `build:clean` wipes that cache and surfaces the break. **Publish from a clean, committed tree.** If a broken working tree blocks it, that's the user's in-progress work — surface it, don't silently fix or stash it without asking.

- **Auth + 2FA.** Needs `npm login` (browser/interactive — the user does it; the token in `~/.npmrc` may be stale and 401). Each `npm publish` then needs a fresh TOTP `--otp=<code>`; a scoped-package publish without valid auth fails with a misleading `404`, not `401`. Ask the user for a new code per attempt — they expire fast.
