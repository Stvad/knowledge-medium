verification:
- use `pnpm run check` for verification unless otherwise stated
- bridge/server tests that bind `127.0.0.1` fail in the Codex sandbox with `listen EPERM`; run `pnpm run check` or those specific tests with elevated permissions

inner loop (this repo is built primarily by agents — keep the edit→verify cycle tight):
- iterate against ONE test file: `pnpm vitest run <path>` (~1s). `pnpm run check` (~64s, the full gate) is for *before a commit*, not after every edit.
- inspect the LIVE client with no rebuild via the agent bridge: `pnpm agent <verb>` — `runtime-summary` / `describe-runtime` for runtime + data-model context, `sql all "<query>"`, `get-block`, `subtree` for data. Full surface + pairing: `packages/agent-cli/README.md`. Read verbs (above) are safe to run freely; mutating verbs (`eval`, `sql execute`, `create-block`/`update-block`, `run-action`, `reload`, `navigate`) act on the live user client — use deliberately, and prefer a scratch page over touching real data.
- the data layer lives in `src/data/` (`Repo`: `query` / `tx` / `mutate` over blocks); prefer the bridge's `describe-runtime` over inferring internal shapes from memory.
- `pnpm run check` does NOT cover `agent-extensions/` (eslint-ignored, outside the app tsconfig). Verify those separately with a scoped `tsc` against the kernel-types stubs (`pnpm agent types`).

delegate code to cheaper models:
- top-tier context is the scarce resource here (this repo is built primarily by agents). Spend it on judgement, review, and synthesis. When a task is primarily *writing / editing* code, delegate it to a cheaper subagent when the work is bounded and easy to audit, and keep the deciding / auditing / data-synthesis in the main loop.
- Claude Code: use the Agent tool with `model:` set, or `agent(prompt, {model})` in a Workflow. Rough default (your call per task): `sonnet` for substantive implementation, `haiku` for trivial / mechanical edits.
- Codex: when `spawn_agent` exposes `gpt-5.3-codex-spark`, prefer it with `xhigh` reasoning effort for concrete, self-contained, parallelizable tasks with clear file ownership or file-path evidence. Otherwise use the cheapest available suitable subagent model or omit the model override. Additional reason: subagents have a separate token budget, so this can preserve main-agent context while advancing work in parallel.
- don't delegate the parts where a subtle mistake is expensive to catch later — architecture calls, data-layer invariants, tricky state semantics, concurrency, migrations, security-sensitive paths, final integration, final verification, or commit decisions.

waiting on background subagents / tasks (they die more often than you think):
- a USER INTERRUPTION of the main session kills in-flight background subagents too — their transcript ends with `[Request interrupted by user]` and the completion notification NEVER arrives. After any interruption, before resuming a wait, re-verify liveness of everything you were waiting on.
- Vlad interrupts to STEER, not to cancel: an interruption is normally new input for the main thread, not a verdict on background work. After handling the steer, resume the killed background agents by default (only drop them if the new input supersedes their task).
- never wait open-ended on a notification alone. Pair every wait with a scheduled fallback wakeup, and when the fallback fires (or after an interruption), check liveness instead of re-waiting: stat the agent's transcript/output file — a small size or minutes-stale mtime with no notification means presume dead. Confirm by tailing the transcript's last entries (bounded `tail -c`, don't read the whole JSONL) for `[Request interrupted by user]` or an error.
- a dead agent may have made partial edits — `git status` its target files before deciding. Prefer resuming the SAME agent via SendMessage (general-purpose subagents resume with full context; Explore/Plan are one-shot and can't) over re-spawning from scratch; re-spawn only if resume fails or the agent had barely started.
- background Bash tasks piped through `| tail`/`| head` report the PIPE's exit code — the harness "completed (exit 0)" line can mask a failing command. Capture the real status explicitly (`; echo "EXIT:$?"` before any pipe, or write to a log file and tail that) and read the output before declaring success.

secret handling:
- do not read `.env`, `.env.*`, or other local secret files unless the user explicitly asks for it
- do not print, echo, cat, grep, or otherwise reveal secrets or secret-bearing files in chat or command output
- when a task needs secret-backed config, infer variable names from code/docs and have the user provide or set values out of band
- if a command must touch a secret file, avoid outputting its contents and avoid relaying secret values back to the user

testing:
- don't add tests that just re-state the code (like testing what is our default shortcut binding is. this just duplicates the shortcut string for no benefit)
- fuzz suites (`*.fuzz.test.ts`, fast-check) run as a small fixed-seed smoke tier inside the normal gate and as random-seed deep runs via `pnpm fuzz` + the nightly `fuzz-nightly.yml` workflow. Reproduce failures with `FUZZ_SEED`/`FUZZ_PATH`; conventions + oracle discipline in `docs/fuzzing.md`. Never weaken a failing property to make it pass — diagnose (real bug vs wrong oracle) first.
- share one DB per test file: open with `createTestDb()` once in module scope / `beforeAll`, reset with `resetTestDb()` in `beforeEach`. Don't call `createTestDb()` per test.
- don't `await new Promise(r => setTimeout(r, N))` to wait on a DB/subscription/BroadcastChannel round-trip — it's slow and flaky. Poll the outcome with `vi.waitFor`.
- proving a write does NOT fire/invalidate:
  - loader-backed query handles (`repo.query.*`): assert the invalidation counter, NOT `fired.length`. Subscriber notifications sit downstream of the loader's structural-diff dedup + mid-load coalescing, so an erroneous invalidation that re-resolves to an equal value (or coalesces with a later control write) is deduped and never reaches a subscriber — `fired` can't see it. Snapshot `env.repo.handleStore.metrics.loaderInvalidations`, do the no-op write, then assert it's unchanged: the post-commit fan-out is synchronous inside `repo.tx` and the counter increments before any dedup, so the count is complete the moment `tx` resolves — provided nothing can re-invalidate the handle a tick later (in the kernel tests that holds because the writes are local `blocks`-only, the only registered post-commit processor — the kernel's `core.aliasClaimRederive` — never writes blocks from its apply, and the default sync observer only reacts to `blocks_synced`). Keep a control-write fence (`vi.waitFor` a real change) as a liveness check. (see `src/data/internals/kernelQueries.test.ts`)
  - raw event listeners (BroadcastChannel / EventEmitter, no dedup layer): a FIFO fence IS sound — after the no-op signal, send a signal that DOES fire and `vi.waitFor` it; in-order delivery proves the no-op produced nothing.

design docs (`docs/*.html`) are intent/history, not ground truth:
- they drift; several are stale in places. CODE + TESTS are authoritative, then the load-bearing rationale in nearby code comments (which move with the code). A design doc is a dated snapshot of intent.
- the `docs/*.html` design docs carry a status banner at the top — an `<aside class="doc-status">` with `Status:` + "last verified against code"; `.md` design docs use a `> **Status:** …` blockquote with the same two fields. Read it first. `unverified` / `superseded` / `partially current` means don't rely on the doc's claims without checking the code. A design doc with NO banner (most `docs/*.md` predate this) is itself `unverified` — treat it that way; absence of a banner is not a sign the file is wrong.
- before relying on a doc claim that matters to the task, confirm it's reflected in the code. If the doc describes a mechanism the code doesn't have, presume it was abandoned or never built — NOT "planned/coming" — and flag the divergence instead of designing around it.
- when a doc contradicts the code, say so in your output and (if cheap) fix or re-stamp the doc; don't silently inherit the stale claim.
- when you open a PR that adds or changes an HTML doc (`docs/*.html`), include a rendered-preview link in the PR body so reviewers can read it without checking out the branch: `https://htmlpreview.github.io/?https://github.com/Stvad/knowledge-medium/blob/<branch>/docs/<file>.html` (GitHub serves raw HTML as text/plain, so the blob URL alone won't render).

cloud / remote sessions (Claude Code on the web) and git worktrees:
- when running in a cloud/remote execution environment, OR working in a non-main git worktree (a checkout that isn't the primary repo dir), open a ready-for-review pull request as soon as the branch has its first commit — don't wait to be asked — then subscribe to the PR's activity so review comments and CI failures come back into the session and can be addressed. (This standing authorization applies to cloud sessions and non-main worktrees; a plain local run in the main checkout still defaults to not opening a PR unless asked.)

ui event channels (audit B3 — do not reintroduce the untyped window.CustomEvent UI bus):
- dialogs / pickers / one-shot prompts: `openDialog(Component, props)` from `@/utils/dialogs` (returns a promise; the component takes `resolve`/`cancel` via `DialogContextProps`). The plugin must pull in `dialogAppMountExtension` so DialogHost is mounted.
- toggle/open surfaces (palette, sidebar, search overlays): a module store from `createToggleStore` (`@/utils/toggleStore`) read with `useSyncExternalStore`; the action/header flips it directly. Cross-plugin or external callers trigger it via `runActionById(ACTION_ID)`, never by importing the store or an event name.
- request/response between components: a typed module registry of imperative handles (see `video-player/registry.ts`), not `respond()` callbacks in event detail.
- `window.dispatchEvent(new CustomEvent(...))` is reserved for GENUINE broadcast and is blocked in non-test `src/` by a `no-restricted-syntax` ESLint error — opt in per-site with `// eslint-disable-next-line no-restricted-syntax -- genuine broadcast: <why>`.

supabase / hosted database:
- never create a table in the `public` schema of the hosted Supabase project without RLS. Supabase grants `anon`/`authenticated` full CRUD on public tables by default, and `CREATE TABLE` / `CREATE TABLE AS` do NOT enable RLS — so the table is immediately world-readable/writable via the anon key until locked down. This includes ad-hoc backup/snapshot/staging tables created via `db query` or `psql`, not just app tables in migrations.
- create such tables with `enable row level security` (no policy = default-deny) + `revoke all ... from anon, authenticated` in the same transaction, or in a schema PostgREST doesn't expose. After any ad-hoc table creation, confirm `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity` returns zero rows. See the supabase skill for the full recipe.
