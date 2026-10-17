# Agent ergonomics eval

Measures how much work an agent spends getting common jobs done on a Knowledge
Medium graph, through the agent CLI from a shell or through the `km` MCP tools, so a
change to either surface is judged by numbers rather than by feel. Tracked by #1233
and #1251 (epic #1237).

It has two halves:

| half | what | where it runs |
|---|---|---|
| **deterministic** | size of representative tool outputs on the fixture, with a budget each; every task's checker proven against the graph | `pnpm run check` (node, ~15s) — `fixtureGraph.test.ts` |
| **model** | `claude -p` does 12 tasks with only one surface's tools; per task: pass/fail, tool calls, characters returned, tokens, time | on demand, `pnpm agent-eval run` — costs subscription usage |

Sizes are characters (string length) throughout: the unit Claude Code's MCP output
cap counts, and the only one its over-the-cap notice reports.

No browser, dev server or pairing is involved. A run imports the fixture into a node
copy of the app's data layer once, then gives every task a fresh copy of that database,
served to the agent through the real bridge, CLI and MCP server.

## How a run works

1. `run` builds `packages/agent-cli` (incremental): the agent runs its built `kmagent`
   and `dist/mcp.js`, and a stale build would measure old code.
2. It starts a private bridge server on a free port with a fresh secret and its own
   state directory, so nothing reaches your bridge, profiles or tabs (`hosting.ts`).
3. It seeds the **template**: a host process (`host.ts`) imports the fixture with the
   real Roam importer into a fresh node database, the way `fixtureGraph.test.ts` does,
   and creates today's daily note. The runner reads the template's rows, its fixture
   state and the output-size probes through the bridge, then stops the host.
4. Each task becomes a job, and `--workers` jobs run at once. A job starts a host on a
   copy of the template, under a token minted for it, then runs `claude -p` against it
   from an empty scratch directory. The agent's CLI and MCP server get the private
   bridge's URL, that token, and a config directory with no profiles
   (`AGENT_RUNTIME_URL`, `AGENT_RUNTIME_TOKEN`, `AGENT_RUNTIME_CONFIG_DIR`).
5. Once the agent exits, the job scores the task, diffs the copy against the template
   (`taskChanges.ts`), and stops the host, which deletes the copy.

A host serves its graph through the same bridge loop a tab runs
(`src/plugins/agent-runtime/bridgeLoop.ts`) and the app's own `executeCommand`, over
`@powersync/node` with the production schema, the app's data extensions and the app's
id generators. What it does not have:

- **No DOM.** `eval` code runs data code only, and `describe-runtime` lists no
  importmap modules. `reload` and `navigate` have nothing to act on.
- **No app pages beyond the fixture.** The tab's onboarding and system pages are
  missing, so a raw SQL scan sees fewer rows than it would in a tab.
- **Another SQLite build** (3.53.2 against the browser's 3.53.0) with other optional
  functions on each side. None of the 300 `sql_query` calls in the first tab-hosted
  baseline used one.

On the MCP surface, the probe output sizes and the stored fixture state measured the
same in node as in the dev tab the first baseline ran on.

## Surfaces

`--surface` picks how the agent reaches the graph (`surfaces.ts`):

| surface | Claude Code tools | the prompt says |
|---|---|---|
| `mcp` (default) | the km MCP server's tools only (`KM_MCP_ALLOWED_TOOLS`), no built-ins | "through the km tools" |
| `cli` | `Bash`, allowed only for `kmagent` and the filters `head`, `tail`, `grep`, `jq`, `wc`, `sort` | "through the `kmagent` command-line tool; `kmagent --help` lists its commands" |

Any other tool or command is refused without a prompt. A `kmagent` shim on `PATH` runs
the checkout's build. The report's tool-use table counts a shell call once for each CLI
verb it ran (`kmagent sql`, `kmagent page`), so it reads like the MCP one; the tool
calls column counts shell calls. A shell result over Claude Code's cap is saved to a file, and the model gets a
preview with the path. The report counts it as capped, the preview as seen and the
saved size as returned. The agent may read the saved file through the filters, as it
would in a normal session. Claude Code keeps these files under `~/.claude/projects/`,
one directory per job's scratch path.

Every run gets no user or project settings (`--setting-sources ""`, an empty working
directory, so no CLAUDE.md and no hooks), and no session is persisted. Billing is the
CLI's subscription login. Credential env vars are scrubbed the way agent-dispatch does
it (`BILLING_ENV_DENYLIST`), and so is every `AGENT_RUNTIME_*` variable your shell
exports. A key stored by the CLI's own login or an `apiKeyHelper` is outside the env and
can't be scrubbed, so check your login if unsure.

## What it guards against

It holds these, and a gap in any of them is a bug:

- **Isolation.** A task's writes, raw SQL included, land on its own copy and reach no
  other task, the template, or any graph outside the run.
- **Scoring.** A correct answer passes and plausible wrong ones fail. A write task
  passes only when it made the requested change and nothing else.
- **Comparability.** A delta is shown only between runs that held the same
  conditions (below), and only for tasks whose definitions match.
- **The code under test.** The run stops if the checkout or the built CLI changes
  while a task runs, since hosts load the checkout as they start and every task
  launches the build.

It does not try to hold these, and a finding about them is declined:

- An answer built to fool a check. The read checks reject plausible mistakes, not text
  written to satisfy two predicates at once. On the `cli` surface the filters can read
  files, and an agent that went looking could find the generator, which holds the
  answers. Every command it ran is in its transcript.
- An agent that sets out to leave its sandbox. On the `cli` surface `kmagent eval` runs
  code in the node host with your user's privileges, not in a browser, so the Bash
  allowlist bounds the shell, not what the agent can reach. A host inherits only `PATH`,
  `HOME`, `TMPDIR` and `LANG`, so the shell's secrets are not in its environment. Run
  the eval where you would run an agent with shell access.
- A run that crosses local midnight, which moves the daily-note task to another day.

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
through the tools under test. A run passes only if the task's check passes, `claude`
exits cleanly, and the agent changed nothing it wasn't asked to.

Each write task declares which fields of which fixture blocks it may edit (the rollout
block's content; the todo's status). Its check names the blocks it accepted as the ones
it asked for, and the properties each may carry. Any other change fails the run:
another property, a move, a deletion, or one more block beside the requested ones. A
read task may change nothing. The changes are the copy's block rows diffed against the
template's, by id, every column (derived ones included) and deleted rows too, never by
timestamp, because some rows are minted at `updated_at = 0`. The diff waits until the
graph is quiet first, so the processors the agent's writes started have landed.

A task's definition is part of the measurement. A report stores a hash of each task's
prompt, check and allowed changes, plus the values the checks close over (the truth,
its patterns, the target blocks). `--compare` shows deltas only for tasks whose hash
matches, and aggregates cover those tasks only. Output-size probes carry a hash of
their call the same way. When you change a helper the checks share (`normalizeText`,
`compareSets`, `strayChanges`), bump `SHARED_HELPERS_VERSION` in `tasks.ts`. Prefer
adding a task to rewording one. A new task needs a reference solution and wrong ones in
`fixtureGraph.test.ts`.

So is what a run holds fixed, recorded together as the report's `conditions`: the
fixture, the fixture as this checkout stores it (a digest of `fixtureState`, which moves
when the importer or the data layer does), the surface and a digest of its tool set and
preamble, the resolved model, the effort, the MCP and shell output caps, the per-task
timeout, and the number of workers, which share the machine and the account's rate
limit. The km MCP server's own tool list is recorded beside them rather than among
them, so a slice that adds a tool stays comparable with the run before it. A baseline
that differs in any condition gets no deltas at all, since they would measure that
difference rather than the tools. That includes a run whose model never resolved
because no task got far enough. `run` refuses such a `--compare` before it starts any
agent, and stops when the first task resolves another model than the baseline's, or a
later task another model than the first. Claude Code's version is shown, not required
to match.

## Running

```bash
pnpm agent-eval run --surface cli --repeat 3 --compare scripts/agent-eval/results/baseline-2026-10-16-sonnet-cli.json
pnpm agent-eval run --surface mcp --repeat 3 --compare scripts/agent-eval/results/baseline-2026-10-16-sonnet-mcp.json
```

Options: `--surface` (`mcp` or `cli`, default `mcp`), `--workers` (default 4),
`--model` (default `sonnet`), `--effort`, `--repeat`, `--tasks id,id`, `--label`,
`--timeout-min`, `--mcp-output-tokens` (default 25000) and `--bash-output-chars`
(default 30000). The last two are passed to every run as `MAX_MCP_OUTPUT_TOKENS` and
`BASH_MAX_OUTPUT_LENGTH` and recorded in the report, because they decide which results
Claude Code cuts short. `run` refuses a `--label` that already has a report or
transcripts; the default label is the date and time, the commit, the model and the
surface. The run directory is created first, as the label's reservation. The first
failure (a changed checkout, a model mismatch) stops the run: no new job starts, and
the agents already running are killed.

`pnpm agent-eval report <report.json> --compare <other.json>` re-renders a saved
report. `pnpm agent-eval sizes` seeds a template and prints its output sizes only.

Reports go to `results/<label>.{json,md}`; a report written by a runner with another
`schemaVersion` is refused, so record it again. Transcripts and each host's log go to
`tmp/agent-eval/runs/<label>/` (gitignored). Per-task figures are medians across
repetitions. Time is wall-clock per agent, measured by the runner, so a run that timed
out counts in full; with several workers it includes contention. "List $" is n/a for a
task when any of its runs ended without reporting a cost. "Context tokens" is input
plus cache-creation plus cache-read tokens, summed over the run's API calls. "Peak
context" is the largest single call. Model runs are noisy, so compare medians of
`--repeat 3` or more, and read the per-task table rather than a single total.

## After the read / write slices land (#1236, #1235)

1. Run both surfaces with `--repeat 3 --compare` against their baselines (the run
   rebuilds the packages itself).
2. Lower the budgets in `outputBudgets.ts` to the new sizes (`pnpm agent-eval sizes`).
   The budgets are a ratchet. They stop a tool's output from growing back.
3. If a tool's inputs changed, update its probe in `outputBudgets.ts` and the MCP
   reference solutions in `fixtureGraph.test.ts`. Don't delete the probe.
4. A new MCP tool is picked up automatically: runs allow everything in
   `KM_MCP_ALLOWED_TOOLS`. A new CLI verb needs nothing either.
