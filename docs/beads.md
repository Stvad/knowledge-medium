# beads — sync, hooks and Dolt operations runbook

> **Status:** operational runbook (not a design doc). Moved out of AGENTS.md on 2026-10-22, which keeps only the rules every session needs. Claims are as last verified there against bd 1.3.0; re-verify against the scripts before relying on a detail.

Read this before editing `scripts/bd-*.mjs` or the publish hooks, touching the Dolt remote, running `bd config` / `bd init` / `bd setup`, upgrading bd, or changing GitHub labels. Cloud and fresh-clone specifics live in `docs/cloud-sessions.md`.

## The GitHub mirror

- beads is the source of truth for issues; GitHub is a bidirectional mirror. Each bead keeps an `External:` link to its GitHub issue; type, priority and labels carry over.
- A bare `bd github sync` needs `GITHUB_TOKEN=$(gh auth token)`; the wrapper (`pnpm bd:sync`, `scripts/bd-github-sync.mjs`) fetches the token itself.
- Judge sync state from a REAL run's output, never `--dry-run`. Dry-run over-reports: it lists every timestamp-dirty pair, and a real push then skips the content-identical ones. Even a converged full sync takes several seconds (an issue listing and one tracker read), which is why the pre-PR hook doesn't run one.

### The five traps the wrapper guards

1. It adopts GitHub-side closes into beads BEFORE pushing. Otherwise an open bead clobbers a GitHub-side close, including a merged "Fixes #N", and RE-OPENS the issue.
2. It gives a bead the pull CREATES from a GitHub-filed issue the priority its `P0–P4` / `priority::*` labels spell. The pull assigns P2 to anything without a `priority::*` machine label, which silently rots `bd ready` ordering. A linked bead is never flattened: the pull is not handed one whose priority it would default.
3. It pushes out the close of a bead that was closed before its first sync. The initial push mints the issue OPEN regardless of bead status.
4. It never hands the pull a bead whose local row is newer. The push carries it, run BEFORE the pull, and a push that did not land holds back that bead's comment mirror. A bare sync's pull applies a strictly OLDER GitHub copy over newer local edits, claims and closes, despite the documented prefer-newer default (#647, measured live: a close made locally and left unpushed reappears open after the next full sync).
5. It DEFUSES the pull's re-apply where that would lose something. bd overwrites any bead whose issue GitHub touched past the local row (a comment, a label edit, the wrapper's own step-4 close). The mapped copy then drops the assignee (bd's push never sets a GitHub one), restamps closed_at (no bd verb puts it back), and re-derives the type from labels, where a bare `enhancement` outranks a scoped `type::chore` (#955).

### Pull by identifier

The pull runs BY IDENTIFIER (`planPullSet`). It is handed the issues with no bead, plus the beads it would carry faithfully; a bead it would damage is simply never named. That takes `doPull`'s other branch: fetch each issue by number with no `last_sync` window, and never hydrate. So neither of a bulk pull's routes to a bead can reach it — the incremental window, or `fetchPrelinkedIssues` bypassing the skip-locally-modified guard for a row edited since the stamp.

This is also what keeps the mirror BIDIRECTIONAL. bd stamps `last_sync` a second into the future at the end of every non-dry-run sync, `--push-only` included. Any pre-pull push therefore leaves a BULK pull an empty window: it would import nothing at all, new GitHub-filed issues included. Protecting a bead and importing an edit are the same window, and only a pull by identifier has neither problem.

A withheld bead is reported, along with any fields that also differ on GitHub. The bead's next push sends the local values over them, and nothing here can say which side was edited last.

### Version gate, reopen, comments

- The wrapper REFUSES to sync on a bd version its guards were not verified against (`VERIFIED_BD_VERSIONS`; `KM_BD_VERSION_OK=1` overrides). An upgrade moves several of these rules at once and reports nothing, so the failure mode would be silent data loss rather than an error.
- Deliberate asymmetry: GitHub-side CLOSES are adopted, because they come from PR merges. A reopen must happen on BOTH sides before the sync, because step 1 closes any open bead whose issue is CLOSED and step 3 closes the issue of any closed bead. Reopening one side is undone. The sequence: `bd reopen <id>` with a `bd comments add` giving the reason, then `gh issue reopen <N>`, then `pnpm bd:sync`.
- Bead COMMENTS are mirrored onto their issues, one way and append-only. Each mirrored body opens with a hidden marker naming the bead comment id, so re-runs never duplicate, and bead ids in the text are rewritten to `#N`. GitHub-side comments are never pulled into beads.
- The mirror runs after the push, because a post bumps the issue past the local row and the push is handed only local-newer rows. It also runs after the pull, so a waiting GitHub-side edit lands first. A bead comment cannot be edited or deleted with bd, so write it publishable the first time.

### Triggers and health

- `.claude/settings.json`: SessionEnd runs the full sync; a PreToolUse hook gates publishing commands; a PostToolUse hook verifies what was published (below).
- Codex wires the same guards and the read-back verifier through `.codex/hooks.json`. Its SessionEnd launcher starts the sync detached, because Codex caps that hook at three seconds; output appends to `.beads/codex-sync.log` in the main checkout. Run `pnpm bd:sync` explicitly when you need it to finish before a handoff.
- Every real run writes a line to `.beads/github-sync-runs.log` in the main checkout, killed and failed runs included. Two bad runs in a row (failed, or over the time budget) make the SessionStart hook open with a warning naming why. The budget counts working time only (waiting on another run's lock and pacing posts are recorded apart), and it grows for each issue the run minted and comment it posted. A converged run's exact spawn list is pinned by a test, which is the CI half of the same alarm.

## The publish hooks

### Pre-PR gate (`bd-github-sync.mjs --hook-pre-pr`)

It gates the publishing `gh` commands: `pr create/edit/comment/review/merge`, `issue create/edit/comment/close`, `release create/edit`. They are matched anywhere UNQUOTED, which deliberately over-matches. Prose is kept out because the skeleton blanks quoted spans, but an unquoted mention in argv trips the gate. That costs one attested re-run, which is the cheap direction for a detector.

It BLOCKS bead ids in the command text and hands back a km→#N substitution table. The ids are looked up, never minted: the gate writes nothing, and names `pnpm bd:sync` for an id that has no issue yet. It also gates `git commit` close keywords, and that commit leg runs independently of any publish in the same invocation.

The `#N` title echo comes in two flavours:

- **Before publishing**, for everything the read-back does not COVER. Coverage is a whitelist (`isPostVerifiable`, shared by both hooks): a single `gh` command with no shell operator anywhere in its skeleton and no expansion in its raw text. A pipe, a redirect, `&&`, a substitution, a newline or a heredoc all leave the whitelist, `2>` included — carving out one operator is the special-casing the shape exists to avoid. The command must be aimed at this repo, on a verb and flags that leave a fetchable URL in the output: so not merge/review/close/reopen, not GraphQL, not `--silent`/`--jq`/`--template`/`-t`.
  - Readable command text gets the title tables. Re-run with `KM_ISSUE_REFS_OK=1` after checking; a number attested that way passes later commands of the same session with its title as context.
  - Blind-publish text living OUTSIDE the command (file/payload flags, api @-references, shell expansion) blocks outright, with BOTH escapes to attest — one coarse rule, no per-channel detection (#683: B).
  - A merged PR additionally gets its merge COMMIT read back post-merge, with its already-acted close keywords echoed (#683: D).
  - The two escapes stay independent everywhere: `KM_ISSUE_REFS_OK` approves numbers, never bead ids; `KM_ALLOW_BEAD_IDS` approves bead ids, never numbers.
- **After publishing**, for everything covered. `scripts/bd-publish-verify.mjs` (#672) reads the created or edited object back from the GitHub API, `gh api` mutations included (the channel review replies use). It echoes every published #N with its real title, plus any published bead id with the number to substitute. It READS ONLY: rewriting in place needed an output→command association the hook payload never states, and approximating it cost six vetoes that grew faster than the repair's reach. If a title is not the issue you meant, fix the published body immediately (`gh pr edit` / `gh api PATCH`).

Further rules:

- **A coverage claim the read-back cannot honour is reported.** When the gate called a publish covered and its output then named no object, the hook says so instead of returning silently. That keeps a gap in the gh-vocabulary half from being worse than one manual check, since that half cannot be made provably complete the way the shell half can.
- **Unrecognized spellings stay pre-gated.** A spelling the gate fails to recognize costs an attested re-run instead of a silent gap; that is the point of the direction.
- **The parsing surface is FROZEN (#672).** The gate scans raw command text only, and coverage findings about bodies it can't see (files, stdin, expansion) are declined; the verifier reads the published object instead.
- **Review-thread replies** go through `pnpm pr:reply <pr> <comment-id> <body-file>`. It appends the Autofix signature and prints the reply URL the read-back needs. A shell function over `gh api` with the signature in a variable is uncovered twice over.

### What no hook covers

Chat and report text, commit shas, and the residuals listed in the two hook headers are protected only by the read-before-you-write rule in AGENTS.md. Chat summaries, handoff notes, memories and (before the hooks grew api coverage) `gh api` review replies have each shipped a guessed number. That was five instances across two sessions; every one was wrong, and every one resolved to a real unrelated issue or PR. A hedged number ("#654-ish") is still a guess, and the hedge doesn't stop it being copied forward (actual: #672, off by 18).

## Labels

The label taxonomy is deliberately DUAL (Vlad's call). A push mints `type::*` / `priority::*` labels in the public repo alongside the hand-maintained `bug` / `P2` / `ui` ones, and there is no config to disable it. Don't "clean these up": they are the machine half, and new work filed in beads carries only them.

They are minted grey with no description and never revisited, so their colours live in `scripts/bd-label-colors.mjs` (`pnpm bd:labels`, idempotent, `--dry-run` to preview). It recolours what exists and PRE-CREATES taxonomy values beads hasn't pushed yet, since a sync applies an existing label but never recolours it. Add the value there when a new `type::` / `priority::` / `status::` / free-form label appears.

## Memory mechanics

- The SessionStart hook is `scripts/bd-prime-hook.mjs`. It reads `bd memories --json` and renders every key, grouped by prefix (`feedback: no_pii_in_commits` is the key `feedback_no_pii_in_commits`), within Claude Code's 10,000-char inline limit for hook context; it caps output at 9,800 characters. It does not run `bd prime`: prime's listing is capped by `prime.max-memory-chars` (set in `.beads/config.yaml`), and its raw output never arrives whole (#643). This repo's close policy is in AGENTS.md.
  - Keys that do not fit are counted, never dropped silently. The largest groups lose their tails first, each trimmed group ends `…(+N more)`, and the header says how many keys are not shown. An index that cannot be read says `index unavailable (<reason>)`. Either way, `bd memories` lists every key.
  - The key is all an agent sees unprompted, so a key names the rule's subject (`feedback_no_pii_in_commits`, not `feedback_commits_2`).
  - Codex routes its native lifecycle hooks through the same wrapper with `--codex <event>`. Every session start carries the index; mid-session events get it only when bd's own result carries context (Beads owns refresh timing).
- A memory is capped at 65,535 bytes (Dolt TEXT). Oversized ones are split into `<slug>` + `<slug>-part2`, each carrying a nav header naming its siblings.
- A memory that grows into an append-only project log should be REFACTORED, not left to accrete. Keep state, deferred work and traps; drop what git and the PRs already record; lift reusable lessons into their own memories. Archive the pre-refactor text verbatim under `memory/archive/` first, and re-verify every live-state claim while you are in there — stale claims survive precisely by sitting buried in oversized memories (`reference_coverage_claims_rot`).
- Why status belongs in beads: bd memories carry no timestamps, so an agent treats a two-year-old memory with the same authority as yesterday's. Upstream measured 40% of memories stale within a day, and agents following stale memories over corrected instructions (gastownhall/beads#4605, #5153). A bead can be closed; a memory cannot.
- Why beads and not files: `~/.claude` is per-machine and unsynced, so a memory written on one machine was invisible everywhere else and to Codex.

## Dolt storage and remotes

- **Beads data syncs to a PRIVATE remote, and must keep doing so.** `Stvad/knowledge-medium` is public, and a ref pushed there is fetchable by anyone via `git fetch origin 'refs/dolt/*'` — invisible in the web UI, but not private. Beads data goes to `Stvad/knowledge-medium-beads` (private) via `bd dolt push` / `bd dolt pull`. A plain `git push` never carries beads data (verified: it moves `refs/heads/*` only).
- **Auto-push runs on ONE machine.** It is set in the main checkout's untracked `.beads/config.local.yaml` (`dolt: {auto-push: true}`), which bd merges over the tracked `config.yaml`, from a worktree too.
  - Never set it in the tracked file: concurrent pushes to a git+ssh Dolt remote can leave its manifest pointing at chunks never uploaded, and a tracked setting turns it on in every clone.
  - Write the file by hand. `dolt.*` keys are yaml-only, so `bd config set dolt.…` rewrites the main checkout's TRACKED `config.yaml` instead (uncommitted — revert it).
- **Worktrees SHARE the one database** (verified). `bd` resolves through the worktree's git common-dir, so a worktree anywhere sees the same issues, memories and remote registry as the main checkout, with no setup; that covers `.claude/worktrees/`, a sibling directory, or `~/.codex/worktrees/`. Concurrent writes from two worktrees both land (tested). A separate CLONE (a cloud session, another machine) is the case that starts empty — see `docs/cloud-sessions.md`.
- **The Dolt remote registry is NOT `sync.remote`, and an empty one offers to adopt git origin — the PUBLIC repo.** `bd dolt push` reads `bd dolt remote list`, which lives in gitignored `.beads/embeddeddolt/`, so a fresh clone has none until `bd bootstrap` wires it from `sync.remote`. Never consent to that adoption. In a new clone, BEFORE any `bd dolt push`:
  ```bash
  bd dolt remote add origin git+ssh://git@github.com/Stvad/knowledge-medium-beads.git
  ```
  Prefer `BD_NO_REMOTE_ADOPT=1 bd dolt push`, which rules adoption out. On a missing registry it prints `No remote is configured — skipping` and exits 0, so read the output, not the exit code.
- **`bd dolt remote add origin` / `remove origin` git-commit `.beads/config.yaml` without asking** (`bd: update sync.remote` / `bd: clear sync.remote`; remote adoption does the same).
  - The commit lands in the MAIN checkout (even when run from a worktree), on its current branch, with git hooks off and with no pathspec, so anything already staged there rides along.
  - Nothing is committed when `sync.remote` did not change.
  - `bd config set` of a yaml-only key rewrites the file without committing.

## Upgrades, init and git hooks

- **bd upgrades are deliberate, never incidental.** A new bd version's first command migrates the shared store's schema in place, and every clone must then move together (an older bd refuses the newer schema). Pin every install path: `brew pin beads`, and the cloud-session install in `docs/cloud-sessions.md` (not pinned yet). Upgrade via the checklist in #877, and add the new version to the wrapper's `VERIFIED_BD_VERSIONS` only after re-verifying its guards.
- **Generated blocks are deliberately absent from AGENTS.md.** The managed block bd writes contradicted this repo's policy: a no-commit default, a ban on the harness task list, and "sync uses `refs/dolt/data` on your git remote", which here is the PUBLIC origin. bd writes it only on an explicit `bd init` (pass `--skip-agents`) or `bd setup <recipe>`; upgrades, `bd prime` and the hooks never touch AGENTS.md. If a block reappears, delete it. `bd setup codex` may also overwrite the repo-owned Codex adapters, so review its diff before accepting it.
- **Codex hook activation.** `.codex/config.toml` enables hooks, but new or changed definitions need trust via `/hooks` in the Codex CLI before they execute; restart an already-running session after configuration changes.
  - Commands resolve scripts from the git root, so subdirectory sessions work.
  - Codex shell hooks use `Bash` and `tool_input.command`. Their post-tool output is a string without exit status, so the verifier flags attribution as unknown before suggesting edits.
  - These are command guards, not coverage for every MCP or file tool.
- `.beads/hooks/` is wired through `core.hooksPath`, so it OVERRIDES `.git/hooks` for this clone. Anything that installs git hooks later (husky et al.) must chain into it rather than replace it. Hook cost is ~130ms per commit.
- `bd init` stages whole tool directories (`.beads/`, `.claude/`, `.codex/`, `.agents/`) and commits them itself. That is why `.codex/worktrees/` is gitignored: without it, re-running init would commit full worktree checkouts.
- `agent.profile` is set to `team-maintainer` so `bd prime` stops telling agents to wait for commit approval.
