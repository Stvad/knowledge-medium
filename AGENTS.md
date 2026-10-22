working here (the corrections that recur most — read these first):
- Vlad treats you as a colleague: give real opinions, push back when a request is worse than its alternative, say "I don't know" plainly. Separate what you OBSERVED from what you HYPOTHESIZE and say which a claim is ("measured" / "reasoned, not measured"); a wrong confident claim costs more than a slow correct one. Report failures plainly, with the output.
- live user data and its history are paramount: this graph is about ten years of Vlad's notes. Never let a change silently drop, mangle or re-type stored data, never answer an edge case by discarding data, and name the recovery path before a migration or repair. Strict schemas beat back-compat shims, but losing data is never the price (`bd recall feedback_no_backcompat_in_alpha`).
- nothing private in anything committed or published — commits, PR text, code, and beads (they become public issues): no workspace or page names, block ids, uuids, content, emails, local paths, device or browser-profile names, or personal context (`bd recall feedback_no_pii_in_commits`).
- be averse to complexity built around a marginal concern; every guard, branch, option and state is permanent weight that later edits must remember. The biggest source here is assuming every workspace has many users and devices changing at once, and then engineering every edge case of an infra change around that — mixed-version windows, clients writing mid-migration, rollout races. Rollouts here can be COORDINATED (drain the devices, deploy, reload), and that is usually good enough. Before building for a case, SIZE it (one read-only query usually does). This is about mechanism, not design quality: never pick a worse abstraction because the user base is small.
- do small adjacent work instead of filing it: if fixing it costs about what describing it would, and it is in the area you are in, do it and say so. File what is genuinely separate.
- when you need a decision: one question, each option with a concrete example and its tradeoff, and your pick. Define any term you introduce; don't coin a name for something that already has one.
- a question usually wants the assessment, not the fix; a request for a change wants it done and committed. In chat, name issues by GitHub number, read from `bd show <id>` → `External:` (none yet → `pnpm bd:sync` mints one), not by bead id.

verification and the inner loop (this repo is built primarily by agents — keep the edit→verify cycle tight):
- iterate against ONE test file: `pnpm vitest run <path>` (~1s). `pnpm run check` is the full gate, for before a commit: about 1.5–3 min on a quiet machine, several times that while other sessions run gates. On timeout-only failures check `uptime` (a load average in the hundreds makes timeouts noise) and re-run just those files before believing them.
- run the gate, and anything else long, with `run_in_background` and wait for its completion notice. Never poll in the foreground (the harness refuses `sleep N; tail …`, and an `until … sleep` loop blocks you for up to 10 min). A pipe reports the LAST stage's exit code, so `check | tail && git push` pushes red: capture `; echo "EXIT:$?"` before any pipe, or write to a log and read it.
- vitest excludes `tmp/`, so a throwaway test that must run goes under `src/` as an ordinary `*.test.ts`, deleted before you commit.
- a recycled worktree can carry a stale `node_modules`: missing modules or impossible type errors mean reinstall first, `pnpm install --frozen-lockfile --config.confirmModulesPurge=false` (a plain `pnpm install` can abort without a TTY). Before believing a "flake on master" you reproduced, check the install.
- Codex sandbox: bridge/server tests that bind `127.0.0.1` fail with `listen EPERM`; run them with elevated permissions.
- the agent bridge inspects the LIVE client with no rebuild: `pnpm agent <verb> --profile <name>`. Pass the profile unless your shell exports `AGENT_RUNTIME_PROFILE`; a token error prints your token store and the selected profile, so read that before concluding the bridge is down (`pnpm agent profiles` prints it on demand). Read verbs (`runtime-summary`, `describe-runtime`, `sql all`, `get-block`, `subtree`) are free. Mutating verbs (`eval`, `sql execute`, `create-block`/`update-block`, `run-action`, `reload`, `navigate`) act on the user's live client: prefer a scratch page. Full surface and pairing: `packages/agent-cli/README.md`.
- for `src/` work prefer a LOCAL dev server over the live client: `pnpm dev`, a browser profile that is NOT the main account, **"Use without sync (local-only)"** on the login screen, and a CLI profile paired to that origin (`AGENT_RUNTIME_APP_URL=http://localhost:<port>/ pnpm agent connect --profile localdev`). Local-only touches no PowerSync or Supabase, so mutating verbs are free there and a `src/` edit is a `pnpm agent reload --profile localdev` away. Edits under `vite-plugins/` or to `vite.config.ts` need a server RESTART, and so, silently, can a `src/` edit that splits kernel/extension module identity (a provider or context stops working after a reload). Setup and the dev-vs-production mismatch list: the `local-dev-loop` skill.
- the data layer lives in `src/data/` (`Repo`: `query` / `tx` / `mutate` over blocks); prefer the bridge's `describe-runtime` over inferring internal shapes from memory.

shell (zsh on macOS):
- `$VAR` is not word-split (use an array or `xargs`); an unquoted glob that matches nothing is an error, so quote `--include='*.ts'`; `status` and `path` are reserved variables; `echo ===` fails; there is no `timeout` binary; `sed -i` is BSD's.
- temp files go in your session scratchpad, never a shared `/tmp/claude-*/` path another session may have written (a stale PR body there has been published more than once).

data model (read BEFORE designing what an extension or plugin stores):
- `pnpm agent describe-runtime --guide record-grain` is the doctrine, with a worked example. Short version: a block is the unit of everything the app gives you free (SQL, references/backlinks, undo, sync, hand-editing) — anything you'd want to see, link, undo or edit on its own is its own block, never a row inside a JSON property. Pointers are `ref`/`optional-ref`/`refList` properties with `targetTypes`, never id strings and never names. Compose an existing type (`todo`, `page`, daily note) before declaring its fields again. Namespace every type id and property name. Type the blocks you READ too, not just the ones you write.
- seed identity is FROZEN once shipped. A property seed's `name`, `presetId` and `codec.type`, and a type seed's `id`, are the keys stored data lives under; renaming, re-encoding, freeing or reusing one silently unsets, throws on, or reinterprets existing values, and nothing migrates them. `src/data/seedIdentityLedger.ts` (its header) holds the rules, and its test prints the remedy for each kind of change. Config is not frozen; widening is routine.
- `createTypedChild(repo, tx, {...})` (`@/data/typedRecords.js`) writes one record block — create + type-tag + typed properties in one call — so the granular shape stays as cheap as the shortcut.
- extension authoring, verification, installs and preset-change refusals: `agent-extensions/AGENTS.md` — read it before working there (Claude Code loads it automatically; Codex only when you launch inside that directory). Property-migration tooling (`audit-properties`, `rematerialize-workspace`): `packages/agent-cli/README.md` and `bd recall reference_audit_properties_reading`.

one-shot catch-up passes (two KINDS; picking the wrong one is silent and expensive — `bd recall reference_oneshot_passes_two_kinds`):
- DERIVATION passes rebuild local, per-device state and are safe everywhere; DATA MIGRATIONS repair source-of-truth rows and upload them — once per GRAPH, claimed in synced data, never from a stale device. Don't merge the two behind one abstraction.
- first ask whether a pass is needed at all: a change the user makes in a tx can usually fan out in that SAME tx (`core.migratePropertyDefinition`) — one undoable step, synced as ordinary rows, nothing to claim or re-detect.
- a migration that writes: CLEAR the workspace undo stack and tell the user (undo replays whole `before` rows and would revert it), and put the "am I safe to write" check INSIDE each writing transaction, not at scheduling time.

guarding a gesture (refusals, skips, eligibility checks — `bd recall reference_gesture_guard_checklist`): a gesture with an EDIT-MODE branch has TWO write paths and only one is a tx, so refuse BEFORE dispatching into the editor; refuse before the EXPENSIVE step (file picker, fetch, block minting); FILTER INSIDE THE QUERY, before the LIMIT; re-check inside the writing tx, not against a pre-dialog snapshot; when the same decision exists in two places, extract it.

comments (lint carries the mechanical half — `comments/no-invisible-jsdoc`, `comments/no-review-provenance`; method: `bd recall feedback_comments_state_the_invariant_not_the_understanding`):
- apply the test per SENTENCE: keep what a competent editor would act on — the invariant, a guard's position, "the obvious refactor is wrong because X", a labelled defence-in-depth — and cut how the rule was learned (the incident, the earlier version, the review round, the measured figure). That goes in the PR body and the issue. A bare `#N` pointer is fine; a design citation is a `docs/` path, never a `§` alone. Write the comment from the invariant before the first commit; reviewers keep catching incident prose the lint misses.
- a long comment is a symptom; fix the code first: a paragraph explaining a boolean → a named predicate; captioned cases → a discriminated union; a magic value → a named const; "X, then Y, then Z" → three functions; "callers must first do P" → the type; and, the dominant shape here, the SAME rule at N sites → ONE owner the other sites point at.
- a comment that contradicts its code is worse than none; fix or delete it on sight, even off-task. A decline recorded at a declaration is one line: the rule and the rejected alternative.

testing:
- don't add tests that re-state the code (e.g. asserting the default shortcut string).
- fuzz suites (`*.fuzz.test.ts`, fast-check) run as a fixed-seed smoke tier in the gate and as deep runs via `pnpm fuzz` + the nightly `fuzz-nightly.yml`. Reproduce with `FUZZ_SEED`/`FUZZ_PATH`; conventions in `docs/fuzzing.md`. Never weaken a failing property to make it pass — diagnose real bug vs wrong oracle first.
- share one DB per test file: `createTestDb()` once in module scope / `beforeAll`, `resetTestDb()` in `beforeEach`.
- don't sleep (`setTimeout`) to wait on a DB/subscription/BroadcastChannel round-trip; poll the outcome with `vi.waitFor`.
- timeouts under load (the #1 source of "a disjoint set of files failed each run"): under the full gate a test's wall-clock stretches ~3x at p99 and ~6x at p99.9. A test measured over ~800ms gets an explicit `it(…, 20_000)` or `describe(name, {timeout: 30_000}, …)` with its measured cost in a comment; fuzz properties use `fuzzTestTimeout()` from `@/test/fuzz`. Don't raise the global `testTimeout`. Every INNER budget must be strictly below the enclosing test's (`vi.waitFor` defaults to 1000ms; Testing Library's `findBy*`/`waitFor` are 3000ms in `src/test/setup.ts`).
- a row a PROCESSOR would fix before your assertion: set it up with a raw `db.writeTransaction`, which maintains the trigger-backed side indexes (`block_aliases`, `block_references`) but fires no post-commit processor — the shape a sync-applied or pre-upgrade row has. A row created already in its final state usually passes with the code under test deleted.
- crowding a row out of a bounded window: order by rank (id, or a lower match bucket), not recency — a fast test stamps every row in the same millisecond.
- two races that look like timeouts: a fixed sleep before a ONE-SHOT event (fence on the observable precondition instead, plus `await act(async () => {})` for a React commit); and a real timer left armed across an awaited `repo.tx` (cancel it at capture time — `captureDebounceTimer`'s `neutralize` in `src/extensions/PanelContentRecovery.test.tsx`).
- proving a write does NOT fire/invalidate: for loader-backed query handles assert the loader-invalidation COUNTER, never `fired.length` (subscriber dedup hides erroneous invalidations); for raw listeners a FIFO fence is sound (`bd recall testing_prove_write_does_not_fire`).

verifying a guard or fix (a green suite is weak evidence on its own):
- after adding or changing a guard, REVERT it and confirm a specific named test fails — per CLAUSE, not per commit (a narrow clause hides behind a broader one in the same predicate), and per POSITION for an early return added to an existing function (move it above each preceding check in turn; a different named test should fail for each).
- commit (a wip commit is fine) BEFORE mutating, and undo the mutation by reverting your edit. `git checkout -- <file>` restores HEAD and wipes every uncommitted edit in that file — the most common way work is lost here.
- DELETE the clause; do not SUBSTITUTE a value for it. A stand-in return is stronger than removing the guard and reports as pinned something that isn't. If deleting the clause fails nothing, it is defence in depth: pin it with a direct unit test and LABEL it so at its declaration.
- four ways a test passes for the wrong reason: another layer catches the case first (pin directly, label defence in depth); a repair path launders the damage before the assertion (use the raw-write setup above so no repair is scheduled); the scenario never reached the code under test (assert the precondition explicitly); an "it is absent" assertion ran before the thing that would make it present had resolved (prime and prove the positive case first, or assert on the cause, e.g. `expect(repo.tx).not.toHaveBeenCalled()`). A negative test never seen to fail is not evidence.
- when the claim is "X renders wrong", drive the REAL plugin and assert on node VALUES, not node counts.

review rounds (Codex-on-PR, `/areview loop`, any reviewer that re-reviews each fix):
- before fixing anything in a round, sort its findings by ROOT CAUSE and ask of each cause: where else is this decided, and is there a shape where the class cannot arise? A finding that names a previous round's own guard, the Nth instance of one rule, or a premise you accepted without checking is a design signal at round two as much as round four. When the answer is a better shape, BUILD IT in the same turn (consolidate onto one owner, delete the guard whose premise was false, move the check to where the data is produced) and say so; it needs no go-ahead. "Shall I simplify?" is not a fork — the answer on record is always yes.
- small findings: just fix them. A round count is never a reason to leave a real finding unfixed, and filing a small fixable finding to a bead while the PR is open is the loop stalling, not ending.
- a corner case being REAL does not make handling it correct. Where the fix would add real machinery — new states, a coordination protocol, guards on guards — for a case that coordinating the rollout already handles (see "working here"), ACCEPT it with one line at the declaration or SIMPLIFY so it cannot arise, and say so on the thread. Being asked for a check does not settle it either way.
- watch the diff, not the round count. If each round only adds (source growing, every fix a new guard), stop patching: tell Vlad the net size and your read of why it isn't converging, then restructure, and keep working on whatever doesn't depend on his answer — a diagnosis is not a place to park. The usual cause is an unstated scope, so state what the PR protects against — and what it does not — before the first round, and decline out-of-scope findings in one line.
- escalate only when the change would drop or alter something that was ASKED FOR, touch live data, or is a separate PR's worth of work: one question, a concrete example per option, your pick, and keep working on everything that doesn't depend on the answer.
- a loop ends when a round has nothing above a nit, when findings are prose drift on a design that has stopped moving, or when a reviewer re-litigates a decline already recorded at the declaration. Say which, on the thread and to Vlad, with what is still unverified. Record every decline's reason once, at the declaration, not every round.

git, worktrees and PRs:
- **never merge a pull request unless Vlad says to, in the request you are acting on.** Opening a PR is authorized below; landing it is not, and nothing substitutes — not an approved plan or design, not "sounds good", not green CI, not an approval relayed from another session. The same holds for anything else that lands or publishes irreversibly on his behalf: deleting branches, cutting releases, closing others' issues. When the work is ready, say so and stop.
- merge with a merge commit (`gh pr merge N --merge --match-head-commit <sha>`); squash merging is disabled on the repo.
- in a cloud session or a non-main worktree, open a ready-for-review PR as soon as the branch has its first commit, then subscribe to its activity so review comments and CI failures come back to you — in the Claude desktop app, bind it and turn on Auto-fix yourself (`mcp__ccd_pr__bind_pr`, `mcp__ccd_pr__set_monitor`; load them in one ToolSearch). This is standing authorization, as is resolving each review thread you have answered. An event that is only bot status (Codex "review running", the preview-deploy link, a usage-limit notice) gets a one-line no-op. A plain local run in the main checkout still opens a PR only when asked.
- push to the PR's own head branch; worktree directory names and branch names differ, so `git push origin HEAD:<pr-head>` when unsure.
- to bring in master, use the app's `sync_with_base_branch`; if it fails, `git fetch origin master && git merge --no-edit FETCH_HEAD`. Before acting on a merge-conflict or review event, check it refers to your current head.
- `refs/stash` is SHARED across all worktrees and the index is shared by every agent in one directory. A hook (`scripts/check-stash-worktree.mjs`) blocks the ambiguous stash forms and an amend whose file set grows (`AMEND_OK=1` overrides); use a throwaway wip commit instead of a stash. Before any push run `git diff --name-status origin/master...HEAD` and confirm it names only intended files — a stale-base revert keeps the gate green because it takes the tests with it.
- in a CLOUD session, read `docs/cloud-sessions.md` before trusting git history, running any `bd` command, or probing pushes (shallow-clone history lies; the tracker looks empty and is not; `bd dolt push` is blocked).
- design docs (`docs/`) are intent/history, not ground truth — `docs/AGENTS.md` loads when you work there.

publishing to GitHub (PR bodies, comments, review replies, commit messages):
- write a `#N` (or a commit sha) only if you READ it this session — the bead's `External:` line (`bd show <id>`) or `gh issue list --search`. A guessed number resolves to a real, unrelated issue and reads as correct to every reviewer; a wrong `Fixes #N` closes it on merge. This covers chat, reports, handoff notes and memories too. In public text, if you only know the bead id, write the bead id: the gate blocks once and hands you the mapping. A bead with no `External:` line has no number until `pnpm bd:sync` mints one.
- the shape the publish gate reads back without blocking: write the body with the Write tool into your session scratchpad, then ONE bare command — `gh pr create --base master --head <branch> --title "…" --body-file <path>`, `gh pr edit N --body-file <path>`, or `pnpm pr:reply <pr> <comment-id> <path>` for a review-thread reply. No `cd … &&`, pipe, `;`, `$(…)`, heredoc, or `--repo`/`-R`/`GH_REPO=` in that command. A blocked command ran NOTHING — not the `git add`, not the file write before it.
- when the gate echoes titles for the numbers in your text, check them, then re-run with `KM_ISSUE_REFS_OK=1` prefixed to the command (an `export` doesn't count). `KM_ALLOW_BEAD_IDS=1` is only for text that must name a bead id.
- "Fixes #N" is the right pattern: when the merge closes #N, the next sync closes the bead. Don't hand-close either side before the merge. What each hook covers and why: `docs/beads.md`.

beads (`bd`, prefix `km`): the issue tracker AND the memory store. This section wins wherever the generated block at the end of this file conflicts with it; `agent.profile` is `team-maintainer`, so that block's no-commit default does not apply.
- beads is the source of truth; GitHub issues are its mirror. Sync with `pnpm bd:sync`, never a bare `bd github sync` (it re-opens closed issues and overwrites newer local edits). It also runs at session end, and its health check warns at session start — act on that warning and tell Vlad. To reopen an issue, reopen BOTH sides (`bd reopen <id>` + a `bd comments add` reason, `gh issue reopen <N>`), then sync.
- a bead becomes a PUBLIC GitHub issue automatically, comments included, and bd has no verb to edit or delete a comment. It must be publishable at creation (the privacy rule in "working here"); state that can't be scrubbed stays in a memory, and you say so.
- a "worth looking at separately" note in a PR body, a message to Vlad, or a TODO is not tracking. LOOK at it now or FILE it (`bd create`, with the reproduction and the fix direction). Wire dependencies when you file (`bd dep <blocker> --blocks <blocked>`), so `bd ready` means unblocked rather than just open.
- beads owns durable work; the harness task list is for the current turn only (this overrides the generated block below). Commit policy is this repo's: commit after each requested change, stay on the current branch. `pnpm run check`, not `bd preflight`, is the gate.
- memory lives in beads ONLY — this overrides the harness default of memory files under `~/.claude/projects/…/memory/`. Write `bd remember --key <slug> -- <content>` (the `--` matters: content starting with `---` parses as a flag), read `bd recall <key>`, search `bd memories <keyword>`. The session-start index lists keys and can be incomplete, so search before concluding there is none. First line = the rule itself (it is the index entry), blank line, body; cross-reference as `[[key]]`; date every claim. Anything that can become false — status, what's deployed or merged, what's next — belongs in a bead, which can be closed; memories have no timestamps and get trusted as current.
- beads DATA goes only to the PRIVATE Dolt remote `Stvad/knowledge-medium-beads`, never to git origin (public — anything pushed there is fetchable, `refs/dolt/*` included). Never consent when bd offers to adopt origin as its remote; push with `BD_NO_REMOTE_ADOPT=1 bd dolt push`.
- never `bd edit` (it opens `$EDITOR` and hangs); use `bd update` flags. Never upgrade bd incidentally: its first command migrates the shared store (checklist in #877). Codex: the beads skill is at `.agents/skills/beads/SKILL.md`.
- before editing `scripts/bd-*.mjs` or the publish hooks, running any `bd dolt` command, running `bd config` / `bd init` / `bd setup`, installing git hooks (`.beads/hooks/` owns `core.hooksPath`), or changing labels, read `docs/beads.md`.

delegate code to cheaper models:
- top-tier context is the scarce resource here. Spend it on judgement, review and synthesis; when a task is mostly *writing* code that is bounded and easy to audit, delegate it — Claude Code: the Agent tool with `model:` set (`sonnet` for substantive implementation, `haiku` for mechanical edits); Codex: `gpt-5.3-codex-spark` with `xhigh` effort for concrete, self-contained tasks with clear file ownership when `spawn_agent` exposes it, else the cheapest suitable model.
- don't delegate where a subtle mistake is expensive to catch later: architecture calls, data-layer invariants, tricky state semantics, concurrency, migrations, security-sensitive paths, final integration, final verification, commit decisions.

waiting on background subagents / tasks (they die more often than you think):
- a USER INTERRUPTION kills in-flight background subagents too: their transcript ends with `[Request interrupted by user]` and the completion notice never arrives. Vlad interrupts to STEER, not to cancel — after handling the steer, re-check liveness and resume the killed agents unless the new input supersedes them. A usage-limit stop kills them the same way.
- never wait open-ended on a notification alone: pair a long wait with a fallback that checks liveness (for example a background command that exits once the agent's transcript has been idle for several minutes). When it fires, or a wait goes quiet, check liveness instead of re-waiting: stat the agent's transcript (small or minutes-stale with no notice → presume dead; confirm with a bounded `tail -c`). A dead agent may have made partial edits — `git status` its files. Prefer resuming the SAME agent via SendMessage (general-purpose subagents keep their context; Explore/Plan can't resume) over re-spawning.

secret handling:
- do not read `.env`, `.env.*` or other local secret files unless the user explicitly asks; never print, echo or grep secret values into chat or command output; when a task needs secret-backed config, infer variable names from code and have the user set values out of band.

kernel/plugin boundary (the central architecture principle — enforced by lint):
- **core cannot depend on plugins; plugins may depend on core and on each other.** Core declares seams (facets, mutators, queries, actions, renderers) and plugins fill them. `src/plugins/<name>/**` is the plugin layer; everything else under `src/` is core.
- a core file reaching into `@/plugins/...` in any form is a `boundary/no-core-to-plugin-imports` error. Fix it by moving the shared contract DOWN into core (`@/facets`, `@/data/api`, `@/utils`), INVERTING it (a core facet the plugin contributes to), or moving your module INTO the plugin layer — not with the disable. Exempt: the composition root (`src/extensions/staticAppExtensions.ts` / `staticDataExtensions.ts`, where new plugin registrations go), tests, `scripts/`, `packages/`. There are ZERO per-site opt-outs in `src/`; adding the first should feel like a defeat.

extension api surface (we are EARLY — do not over-protect it):
- `src/extensions/apiCatalog.ts` is a DISCOVERY surface, not a frozen contract. Reshape or remove a listed symbol when the design is wrong; "an installed extension might read it" is not on its own a reason to keep a bad shape. Deleting is the default; don't design compat shims or deprecation windows unless a real consumer is known and Vlad asks.
- but SAY SO, every time: name the break in the commit/PR and to Vlad — what was removed, and what an extension reading it would see (a `TypeError`, a silently wrong value, a blank subtree). This relaxes nothing about user DATA.

ui event channels (do not reintroduce the untyped window.CustomEvent UI bus):
- dialogs / pickers / one-shot prompts: `openDialog(Component, props)` from `@/utils/dialogs` (returns a promise; the component takes `resolve`/`cancel` via `DialogContextProps`); the plugin must pull in `dialogAppMountExtension` so DialogHost is mounted.
- toggle/open surfaces (palette, sidebar, search overlays): a store from `createToggleStore` (`@/utils/toggleStore`) read with `useSyncExternalStore`. Other plugins trigger it via `runActionById(ACTION_ID)`, never by importing the store.
- request/response between components: a typed module registry of imperative handles (see `video-player/registry.ts`).
- `window.dispatchEvent(new CustomEvent(...))` is for GENUINE broadcast only and is a lint error in non-test `src/` — opt in per site with `// eslint-disable-next-line no-restricted-syntax -- genuine broadcast: <why>`.

supabase / hosted database:
- never create a table in the hosted project's `public` schema without RLS: Supabase grants `anon`/`authenticated` full CRUD there and `CREATE TABLE` (AS) does not enable RLS — ad-hoc backup/staging tables included. Create them with `enable row level security` + `revoke all … from anon, authenticated` in the same transaction, then confirm `select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity` returns zero rows. Recipe: the supabase skill.
- SQL and migration tests (pgTAP, stack tests) run with `pnpm check:db` on a throwaway local stack (`bd recall feedback_apple_container_supabase` for the container setup). CI does not run them yet, so run them yourself when you touch `supabase/`.

## Review guidelines

These steer automated PR review (Codex reads this section) as well as `/areview`:
- rate severity by reachability for THIS deployment: a small user base whose rollouts and migrations can be coordinated (devices drained, deploy, reload). Mixed-version windows, concurrent multi-device or multi-user writes during an infra change or migration, and hostile or malformed synced data are P2 at most unless they can lose or corrupt stored user data.
- flag added complexity that is disproportionate to the concern it addresses — new machinery for a case that coordinating the rollout already handles is itself a finding, and "accept this case with a note at the declaration" is a valid recommendation.
- do not re-raise a decline already recorded at the declaration.
- P1: data loss or corruption, a private identifier (workspace/page name, block id, uuid, email, local path) in committed or published text, a security hole reachable by a signed-in or anonymous user, a core file importing from `src/plugins/`.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
