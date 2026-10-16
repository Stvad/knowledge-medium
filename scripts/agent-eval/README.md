# Agent ergonomics eval

Measures how much work an agent spends getting common jobs done on a Knowledge
Medium graph through the `km` MCP tools, so a change to that surface is judged
by numbers rather than by feel. Tracked by #1233 (epic #1237).

It has two halves:

| half | what | where it runs |
|---|---|---|
| **deterministic** | size of representative tool outputs on the fixture, with a budget each; every task's checker proven against the graph | `pnpm run check` (node, no browser, ~20s) — `fixtureGraph.test.ts` |
| **model** | `claude -p` does 12 tasks with only the km tools; per task: pass/fail, tool calls, characters returned, tokens, time | on demand, `pnpm agent-eval run` — costs subscription usage |

Sizes are characters (string length) throughout: the unit Claude Code's MCP output
cap counts, and the only one its over-the-cap notice reports.

## The fixture

`fixture.ts` generates a deterministic Roam export of a fictional team's notebook
(5.8k blocks: eight months of daily notes, a 2,000-entry reading log, a 100 KB pasted
source block, vendor pages with `key:: value` attributes, a project page with nested
todos, ~600 bare `[[Meeting]]` and ~170 bare `[[Standup]]` references). It is loaded
with the real Roam importer, so blocks carry the same `roam:*` importer metadata a real
imported graph does. The same generator also produces the ground truth that the
tasks are checked against. All names and content are invented.

## Tasks

`tasks.ts`. There are eight read tasks: a topic in a date window, summarize a page,
references with context through bare backlinks, open todos under a page, a needle on a
2,000-child page, a property query, counting meetings with a person (each a bare
`with [[Person]]` line), and filtering the 2,000-child page. They are scored on the reply's final
`ANSWER: {json}` line. There are four write tasks: append a structured note to today's
daily note, edit one phrase in a block, create a page and link it, and complete a todo.
They are scored on graph state read back through raw wire commands and SQL, never
through the MCP tools under test. A run passes only if the task's check passes, `claude`
exits cleanly, and the agent changed nothing it wasn't asked to. Each write task
declares which fields of which fixture blocks it may edit (the rollout block's content;
the todo's status). Its check names the blocks it accepted as the ones it asked for,
and the properties each may carry. Any other change fails the run: another property,
a move, a deletion, or one more block beside the requested ones. A read task may change
nothing.

Every task starts from the same graph. The runner snapshots every block row once,
after each task's `reset` has cleared anything an interrupted earlier run left behind.
The snapshot leaves out the app's own per-user state, which changes by itself: the
state roots the app derives under each user page (ui-state, preferences) and what is
under them. The user page itself is an ordinary page, so a note written on it is
compared like any other block. Which rows are app state is fixed when the snapshot is
taken, so a fixture block is compared wherever it ends up. After each task, the runner:

1. waits until the graph is quiet, so late processor writes land first, and aborts if
   it is still being written to after 20s;
2. diffs the whole table against the snapshot by id, every column (derived ones
   included) and deleted rows too, and never by timestamp, because some rows are
   minted at `updated_at = 0`;
3. undoes every difference: content, properties, deletions and moves, and purges the
   rows the task created, so the agent's raw SQL finds no leftovers;
4. waits until the graph is quiet again, so the processors the undo's own writes
   started have landed;
5. diffs again to prove the result, and aborts rather than score the next task on a
   different graph;
6. puts back the recency timestamps of every row whose timestamps moved, whoever
   moved them, so recency ordering is unchanged.

The run's snapshot is also journaled to `tmp/agent-eval/journal/`, so a run killed
mid-task is undone by the next run, before it even reads which fixture the tab holds. What the resets themselves add (today's daily note,
when it is missing) is recorded there too, and removed when the run ends, or by the next
run when this one stopped early. Runs on later days therefore don't leave the graph a
note longer each time. `seed` and `run` hold a lock per workspace there,
so two of them never write one graph at once; a lock left by a process that died is
taken over.

Before the first task, `run` also checks that the tab holds the fixture as this
checkout's code imports it, which is what the gate's checks are proven on. Every block
the export defines, every daily page holding one, and every block that sits under
either is read from the tab and from a fresh in-process import, in a form that does not
depend on the workspace (`fixtureState.ts`). The two must be equal. This check runs
before the resets write anything, so a refused run leaves nothing behind.
A tab seeded by older code, or holding a change made by hand, is refused before
anything is spent, and so is a run whose in-process import fails. The run also aborts if the checkout changed
while a task ran, since both halves of the tools run from it: the dev tab hot-reloads
the app from it, and the MCP server is built from it.

A task's definition is part of the measurement. A report stores a hash of each task's
prompt, check, reset and allowed changes, plus the values the checks close over (the
truth, its patterns, the target blocks). `--compare` shows deltas only for tasks whose
hash matches, and aggregates cover those tasks only. Output-size probes carry a hash
of their call the same way. When you change a helper the checks share
(`normalizeText`, `compareSets`, `strayChanges`), bump `SHARED_SCORING_VERSION` in
`tasks.ts`. Prefer adding a task to rewording one. A new task needs a reference solution
and wrong ones in `fixtureGraph.test.ts`.

So is what a run holds fixed, recorded together as the report's `conditions`: the
fixture, the fixture as this checkout stores it (a digest of `fixtureState`, which moves
when the importer or the data layer does), the resolved model, the effort, the MCP
output cap and the per-task timeout.
A baseline that differs in any of them gets no deltas at all, since they
would measure that difference rather than the tools. That includes a run whose model
never resolved because no task got far enough. `run` refuses such a `--compare` before
it starts, and stops after the first task when the resolved model differs, since the
model is known only once a task has run. A run also stops if a later task resolves to
another model than the first. Claude Code's version is shown, not required
to match.

## One-time setup

1. Start a dev server on its own origin, so it has its own local database:

   ```bash
   pnpm dev --port 5291 --strictPort
   ```

   (In the desktop app, use the `agent-eval-dev` launch config.)
2. Open `http://localhost:5291/` in a browser profile that is NOT your main account.
   Choose local-only / enter any name. Nothing syncs from this origin.
3. Pair a dedicated CLI profile with that tab, then seed it:

   ```bash
   AGENT_RUNTIME_APP_URL=http://localhost:5291/ pnpm agent connect --profile km-eval
   pnpm agent-eval seed
   ```

`seed` and `run` refuse a tab that has ever synced (connected PowerSync, or holds any
downloaded row), because both write thousands of blocks. `seed` also refuses a workspace
that holds a different fixture version. Re-seeding the same fixture puts fixture blocks'
content, position and deletion back, but not properties a run changed. The run's own
undo handles those, so a re-seed is only a repair step.

## Running

```bash
pnpm agent reload --profile km-eval # the tab runs the working tree's src/
pnpm agent-eval run --repeat 3 --compare scripts/agent-eval/results/baseline-2026-10-16-sonnet.json
```

`run` builds `packages/agent-cli` first (incremental), because the runs launch its
`dist/mcp.js` and a stale build would measure old code. It refuses a `--label` that
already has a report or transcripts; the default label is the date and time, the commit
and the model. The run directory is created first, as the label's reservation.

Options: `--model` (default `sonnet`), `--effort`, `--repeat`, `--tasks id,id`,
`--label`, `--timeout-min`, `--profile` (default `km-eval`), and `--mcp-output-tokens`
(default 25000). The last one is passed to every run as `MAX_MCP_OUTPUT_TOKENS` and
recorded in the report, because it decides which tool results Claude Code caps.
`pnpm agent-eval report <report.json> --compare <other.json>` re-renders a saved
report. `pnpm agent-eval sizes` prints the deterministic output sizes only.

Each `claude -p` run gets the km MCP server (`--strict-mcp-config`) and only its tools
(`--allowedTools` from `KM_MCP_ALLOWED_TOOLS`, plus `--tools ""`, so there are no
built-ins). It also gets no user or project settings (`--setting-sources ""`, an empty
working directory, so no CLAUDE.md and no hooks). Billing is the CLI's subscription
login. Credential env vars are scrubbed the way agent-dispatch does it
(`BILLING_ENV_DENYLIST`). A key stored by the CLI's own login or an `apiKeyHelper` is
outside the env and can't be scrubbed, so check your login if unsure.

Reports go to `results/<label>.{json,md}`; a report written by a runner with another
`schemaVersion` is refused, so record it again. Transcripts go to
`tmp/agent-eval/runs/<label>/` (gitignored). A result over the MCP output cap appears there only as
Claude Code's notice, never as the full output; the report counts such calls as "capped" and records
the size the tool returned.
Per-task figures are medians across repetitions. Time is wall-clock, measured by the
runner, so a run that timed out counts in full. "List $" is n/a for a task when any of
its runs ended without reporting a cost. "Context tokens" is input plus
cache-creation plus cache-read tokens, summed over the run's API calls. "Peak context"
is the largest single call. Model runs are noisy, so compare medians of `--repeat 3`
or more, and read the per-task table rather than a single total.

## After the read / write slices land (#1236, #1235)

1. Reload the tab, as above, then `pnpm agent-eval run --repeat 3 --compare <baseline>.json` (the run rebuilds the packages itself).
2. Lower the budgets in `outputBudgets.ts` to the new sizes (`pnpm agent-eval sizes`).
   The budgets are a ratchet. They stop a tool's output from growing back.
3. If a tool's inputs changed, update its probe in `outputBudgets.ts` and the MCP
   reference solutions in `fixtureGraph.test.ts`. Don't delete the probe.
4. A new tool is picked up automatically: runs allow everything in `KM_MCP_ALLOWED_TOOLS`.

## Resetting the dev origin

A changed fixture (its hash is on the `Agent Eval Fixture` page) needs a fresh
database. Clear the site data for `localhost:5291` (DevTools → Application → Clear
site data), log in local-only again, re-pair `km-eval`, and seed.
