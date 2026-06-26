---
name: areview
description: Launch N parallel adversarial review agents that try to break the work done so far in this session, each from a different inferred perspective. Use when the user wants a multi-angle critique of the current session's changes (code or design/docs) before committing/shipping — e.g. "/areview 4". The number argument sets how many agents (and how many distinct perspectives) to run; default 2. A `codex` method lens (e.g. "/areview codex 4") makes every agent review by mechanical, ground-truth verification.
---

# Adversarial review of the current session

Fan out several review agents **in parallel**, each told to break the work done in **this session** from a different angle, then synthesize their findings. Each agent's job is to find real problems, not to praise.

## Argument

`$ARGUMENTS` = number of agents **N** (default **2**), one perspective per agent. Trailing words are focus hints (e.g. `4 watch the sync path`). By default the skill implements the agreed improvements after presenting findings; add `--no-fix` to stop at the report. Add `loop` (e.g. `/areview loop` or `/areview loop 4`) to repeat the review→fix cycle until it converges.

Add a **method lens** — a reserved keyword (like `loop`/`--no-fix`, parsed out before the rest becomes focus hints) that makes *every* agent review with a specific method, orthogonal to its per-agent perspective: `codex` — e.g. `/areview codex 4`, `/areview loop codex`. See **Method lenses** below.

## Method lenses

Recognize a known method-lens keyword in the arguments. The N perspectives are *risk-domain* lenses — *what* to scrutinize (data-loss, races, failure-paths, ungrounded claims), one per agent, non-overlapping. A **method lens** is orthogonal — *how* to scrutinize — and applies to ALL agents at once. Compose them: `/areview codex 4` = 4 agents on 4 distinct surfaces, each reviewing with the codex method.

- **`codex`** (mechanical / empirical / ground-truth). Instruct every agent: verify per-statement and trace each branch with concrete values; ground **every** claim against the actual artifact — read the dependency source in `node_modules`, run the code, execute the SQL — never assert from memory; follow cross-references literally (does the cited section/symbol exist and say what the citing text claims?); for any tests, mutation-test them (would this test fail if the bug were reintroduced?); hunt edge values (empty / 0-byte / boundary / preexisting-state / unordered). Prefer "I ran it and observed X" over "this should…". This catches the implementation/contract bugs (pagination order, error-shape, idempotency, off-by-one, redaction) that thematic "is the abstraction sound?" review glosses over.

## What matters

- **Pack a self-contained brief** — the agents have zero memory of this conversation. Scope comes from *this conversation* — what we actually worked on; git is just the artifact to hand over. Gather the matching diff (uncommitted `git diff` plus the commits you made this session — use `git log` to find them; if the base is unclear, the changes under discussion are the source of truth, not git), or the drafted artifact if it isn't in git yet. Include what we were trying to do and why, plus the invariants in play, and note anything you left out rather than truncating silently. If nothing was actually changed, say so and stop.
- **Pick N non-overlapping perspectives that fit what changed** — match the lens to where this work is most likely *wrong* (e.g. data loss for a migration, races for sync code, unhandled failure paths / ungrounded claims for a design doc), and include one aimed at its highest-stakes risk. Don't pad to hit N; if there are only K real angles, run K and say so.
- **Use the Agent tool, parallel, read-only** — all N calls in one message; agents review only, never edit. Tell each to be adversarial: cite file:line, give the concrete failure scenario + severity + fix, confirm against the code before claiming a bug, and say plainly when a lens turns up nothing rather than inventing nits.
- **Synthesize** — dedup (cross-agent agreement is a strong signal), drop false positives that don't hold against the code, rank by severity (blocker > major > minor > nit), surface real disagreements, end with a bottom line.
- **Fix by default** — after presenting the report, go straight to implementing the findings you stand behind, worst first: blocker, then major, then minor; nits are optional. Skip the ones you overruled as false positives, and note anything you deliberately left for the user. Then verify (`yarn run check`). With `--no-fix`, stop at the report instead and let the user act on it.
- **`loop` mode** — re-review the fixed state and fix again, repeating until a round surfaces nothing above a nit (no blocker/major/minor left). Each round reviews the *current* state, not the original diff. Stop when converged, and also stop (reporting why) if you hit ~4 rounds, if findings stop making progress (the same issues recur or a fix spawns new ones), or if `yarn run check` fails and you can't resolve it — don't loop forever. `loop` always fixes; it ignores `--no-fix`.
