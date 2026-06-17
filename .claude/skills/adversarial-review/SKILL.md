---
name: adversarial-review
description: Launch N parallel adversarial review agents that try to break the work done so far in this session, each from a different inferred perspective. Use when the user wants a multi-angle critique of the current session's changes (code or design/docs) before committing/shipping — e.g. "/adversarial-review 4". The number argument sets how many agents (and how many distinct perspectives) to run.
---

# Adversarial review of the current session

Spin up several review agents **in parallel**, each instructed to find real problems with the work done in **this session** from a distinct perspective, then synthesize their findings into one report. The point is breadth + adversarial intent: each agent's job is to break the work, not to praise it.

## Argument

`$ARGUMENTS` is the number of agents **N** to launch (default **3** if omitted). N also sets how many distinct perspectives to use — one per agent. Any words after the number are optional extra focus hints from the user (e.g. `5 watch the sync path`) — fold them into perspective selection.

## Step 1 — Assemble a self-contained brief

The review agents start with **zero** memory of this conversation. Everything they need must go in their prompt. Gather:

- **The diff.** Capture what changed in this session: `git diff` (uncommitted) plus any commits you made during this session (`git log`/`git diff <session-base>..HEAD`). If the work isn't in git yet (pure design/discussion, or docs you drafted but didn't write), assemble the concrete artifact text instead.
- **Intent & decisions.** A tight summary (you have this from the session): what we set out to do, the key decisions and *why*, alternatives rejected, and any constraints we committed to. Include relevant project invariants you know are in play (e.g. data-integrity / sync / no-data-loss rules) so reviewers can check against them.
- **Scope.** Name the files/areas in scope so agents don't wander into unrelated code.

If the diff is large, don't truncate silently — tell the agents what you included and what you left out.

## Step 2 — Infer N distinct perspectives from the work

Choose **N** perspectives that actually fit what changed — don't reach for a fixed checklist. Match the lens to the artifact:

- **Implementation code** → correctness & edge cases; data integrity / migration safety; concurrency & sync ordering; security & auth; API / abstraction-boundary design; performance & scale; test adequacy (does the test actually exercise the risk?); simplicity / YAGNI.
- **Design docs / plans** → unhandled failure paths; invariant contradictions; ungrounded claims & stale symbol references; operational/rollout risk; "what's the simplest thing this over-engineers?". (See the project's design self-review checklist for grounding.)
- **Mixed / other** → pick the lenses where this work is most likely to be *wrong*, not where review is easiest.

Rules of thumb:
- Make the perspectives **non-overlapping** — each agent owns a different failure mode, so coverage is wide.
- Scale granularity to N: small N → broad lenses; large N → narrower, more specialized ones. Never duplicate a lens just to hit the count — if the work genuinely only has K meaningful angles and N > K, say so and run K.
- Always include at least one lens aimed at the **highest-stakes risk** of this specific change (e.g. data loss for a migration, race conditions for sync code, factual accuracy for a doc).

## Step 3 — Launch the agents in parallel

Use the **Agent tool** (not Workflow — this is a plain parallel fan-out). Send all N `Agent` calls **in a single message** so they run concurrently. Use a read-only-minded agent type (e.g. `general-purpose` / `Explore`) and tell each agent explicitly: **review only, do not modify any files.**

Give every agent the same brief from Step 1 plus its own perspective. Make the stance adversarial and demand evidence over vibes:

> You are reviewing the following change from the **<perspective>** perspective. Your job is to find real, concrete problems — be skeptical and adversarial; do not summarize or praise. For each issue: cite the exact file:line (or doc passage), state the concrete failure scenario, explain why it's a real problem (not style), rate severity (blocker / major / minor), and suggest a fix. If you find nothing real from this lens, say so plainly rather than inventing nits. Read the surrounding code/context to confirm before claiming a bug — flag unverified hunches as such.

Ask each agent to return a short structured list (severity · location · issue · why it bites · suggested fix).

## Step 4 — Synthesize

Collect the agents' findings and produce one consolidated report:

- **De-duplicate** overlapping findings; note where multiple perspectives independently flagged the same thing (that's a strong signal).
- **Filter false positives** — drop or downgrade findings that don't hold up against the actual code/context. Be willing to overrule an agent.
- **Rank by severity**, grouped blocker → major → minor, each tagged with the perspective(s) that raised it.
- Surface genuine **disagreements** between agents rather than averaging them away.
- End with a clear bottom line: is the work sound, and what (if anything) must change before it ships.

Do **not** auto-apply fixes — this skill produces a critique. The user decides what to act on (they can follow up with `/code-review --fix`, `/simplify`, or a direct ask).
