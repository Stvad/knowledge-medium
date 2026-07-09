---
name: publish-agent-cli
description: Build and publish a new version of the @knowledge-medium/agent-cli npm package (packages/agent-cli). Use when asked to release/publish/cut a new agent-cli (a.k.a. kmagent) version, bump its npm version, or push it to the registry.
---

# Publish a new agent-cli version

Releases `@knowledge-medium/agent-cli` (the `kmagent` CLI + bridge) to public npm.

## The normal path is now CI — just bump + push

`.github/workflows/publish-packages.yml` auto-publishes on **version change**: after a green `Run Tests` on master, `scripts/publish-packages.mjs` publishes any workspace package (`agent-cli` **and** `agent-dispatch`) whose `package.json` version isn't on npm yet, via npm **Trusted Publishing (OIDC)** — no token, no OTP. So a release is just:

1. **Bump the version — then undo the lockfile damage.** `npm version` runs an install that, in this **yarn** workspace, churns `yarn.lock` and writes a stray `package-lock.json`. Only the `package.json` change should survive.
   ```bash
   cd packages/agent-cli && npm version <new> --no-git-tag-version
   cd ../.. && git checkout yarn.lock && rm -f package-lock.json
   ```
   Pick the bump from the changes (`git log --oneline <last-release>..HEAD -- packages/agent-cli/src`): pre-1.0, new commands/features → **minor**; fixes only → patch.

2. **Commit** just the version bump, then **push/merge to master**. CI publishes it. **Verify:** `npm view @knowledge-medium/agent-cli version` shows the new version once the `Publish packages` run goes green.

Don't run `npm publish` by hand for a routine release — that double-publishes outside the CI flow (and races its ordering).

## Manual publish (fallback only)

Use this only when CI can't do it — e.g. the very first publish of a brand-new package before its npm trusted publisher is registered, or CI is down. Needs `npm login` + a per-attempt OTP (see the auth gotcha below):
```bash
cd packages/agent-cli && npm publish --otp=<code>
```
`prepublishOnly` runs a clean `build:clean && build` for you, so no need to pre-build.

## Gotchas that actually bite

- **Publish builds the *whole app*, not just agent-cli.** `prepublishOnly` → `build` regenerates the vendored kernel-types `.d.ts` tree from the entire app's `@/` source (`scripts/build-kernel-types.mjs`). So a half-finished refactor anywhere in `src/` — e.g. a dangling `@/foo.js` import from an uncommitted rename — **fails the publish**, even though agent-cli itself compiles. A plain `yarn run build` can pass here while publish fails, because it's *incremental* (cached `.tsbuildinfo`) and skips re-checking unchanged files; `build:clean` wipes that cache and surfaces the break. **Publish from a clean, committed tree.** If a broken working tree blocks it, that's the user's in-progress work — surface it, don't silently fix or stash it without asking.

- **Auth + 2FA.** Needs `npm login` (browser/interactive — the user does it; the token in `~/.npmrc` may be stale and 401). Each `npm publish` then needs a fresh TOTP `--otp=<code>`; a scoped-package publish without valid auth fails with a misleading `404`, not `401`. Ask the user for a new code per attempt — they expire fast.
