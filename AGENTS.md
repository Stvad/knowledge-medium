verification:
- use `yarn run check` for verification unless otherwise stated
- bridge/server tests that bind `127.0.0.1` fail in the Codex sandbox with `listen EPERM`; run `yarn run check` or those specific tests with elevated permissions

secret handling:
- do not read `.env`, `.env.*`, or other local secret files unless the user explicitly asks for it
- do not print, echo, cat, grep, or otherwise reveal secrets or secret-bearing files in chat or command output
- when a task needs secret-backed config, infer variable names from code/docs and have the user provide or set values out of band
- if a command must touch a secret file, avoid outputting its contents and avoid relaying secret values back to the user

testing:
- don't add tests that just re-state the code (like testing what is our default shortcut binding is. this just duplicates the shortcut string for no benefit)
- share one DB per test file: open with `createTestDb()` once in module scope / `beforeAll`, reset with `resetTestDb()` in `beforeEach`. Don't call `createTestDb()` per test.
- don't `await new Promise(r => setTimeout(r, N))` to wait on a DB/subscription/BroadcastChannel round-trip — it's slow and flaky. Poll the outcome with `vi.waitFor`. For a "does NOT invalidate/fire" assertion, use a control-write fence: after the no-op write, make a write that DOES change the result, `vi.waitFor` that single emission, then assert the emission count (e.g. `fired.length` is exactly the fence count). Channels are FIFO, so the fence proves the no-op produced nothing. (see `src/data/internals/kernelQueries.test.ts`)
