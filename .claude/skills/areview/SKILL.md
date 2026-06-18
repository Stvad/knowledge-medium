---
name: areview
description: Launch N parallel adversarial review agents that try to break the work done so far in this session, each from a different inferred perspective. Use when the user wants a multi-angle critique of the current session's changes (code or design/docs) before committing/shipping — e.g. "/areview 4". The number argument sets how many agents (and how many distinct perspectives) to run; default 2.
---

# Adversarial review of the current session

Fan out several review agents **in parallel**, each told to break the work done in **this session** from a different angle, then synthesize their findings. Each agent's job is to find real problems, not to praise.

## Argument

`$ARGUMENTS` = number of agents **N** (default **2**), one perspective per agent. Trailing words are focus hints (e.g. `4 watch the sync path`). Add `--fix` to implement the agreed improvements right after presenting findings.

## What matters

- **Pack a self-contained brief** — the agents have zero memory of this conversation. Give each the session diff (`git diff` + commits you made this session; or the drafted artifact if not in git yet), what we were trying to do and why, and the invariants in play. Note anything you left out rather than truncating silently.
- **Pick N non-overlapping perspectives that fit what changed** — match the lens to where this work is most likely *wrong* (e.g. data loss for a migration, races for sync code, unhandled failure paths / ungrounded claims for a design doc), and include one aimed at its highest-stakes risk. Don't pad to hit N; if there are only K real angles, run K and say so.
- **Use the Agent tool, parallel, read-only** — all N calls in one message; agents review only, never edit. Tell each to be adversarial: cite file:line, give the concrete failure scenario + severity + fix, confirm against the code before claiming a bug, and say plainly when a lens turns up nothing rather than inventing nits.
- **Synthesize** — dedup (cross-agent agreement is a strong signal), drop false positives that don't hold against the code, rank by severity, surface real disagreements, end with a bottom line.
- **Fix only if asked** — without `--fix`, stop at the report; the user acts on it (`/code-review --fix`, `/simplify`, or a direct ask). With `--fix`, after presenting the report go straight to implementing the findings you stand behind — blockers and majors first, skip the ones you overruled as false positives, and note anything you deliberately left for the user. Then verify (`yarn run check`).
