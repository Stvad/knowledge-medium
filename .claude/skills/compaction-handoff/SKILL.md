---
name: compaction-handoff
description: Write the one handoff file a compaction would otherwise lose, and pick up from it afterwards. Use when Vlad says "prepare for compaction", "pls prep", "going to compact", "compacting now, pls prepare", "anything to do before?", or asks you to save state before a /compact, a reboot or a long pause. Also use right after a compaction whose context starts with "# Compaction handoff".
---

# Compaction handoff

When Vlad asks you to prepare for a compaction, write ONE file: `handoff.md` in your session scratchpad (the directory your system prompt names). Right after the compaction, a SessionStart hook (`scripts/compaction-handoff.mjs`, matcher `compact` in `.claude/settings.json`) injects it under `# Compaction handoff`. It then renames it to `handoff.consumed.md`, so a later compaction you did not prepare for can't replay it. If he asks again before compacting, overwrite the same file.

## Write only what the summary drops

The summary keeps the request, every user message word for word, the files touched, errors, PR numbers and the step in progress. Claude Code also re-attaches the last few files you read or wrote, the skills you invoked, CLAUDE.md and any background Bash task still running. Don't restate any of that.

What it drops is the handoff's whole job:
- **ids:** background agent ids, session-proposal `task_…` ids, side-session `local_…` ids;
- **the task list:** the summary paraphrases it at best;
- **which of Vlad's decisions still hold**, as opposed to the ones a later message replaced;
- **verified vs. reasoned:** what a test, gate or live check showed, and what is still unchecked;
- **exact resume points:** log paths, ports, profile names, the command to re-run.

## Template

Under ~60 lines and 4K characters. Leave out any line with nothing in it.

```markdown
# Handoff: <goal in one line> (<date> <time>)
Decisions in force: "<Vlad's words>" (one line each, latest first)
Done, verified: <item> (how: test file, gate log, live check)
Done, unverified: <item> (what would check it)
Next: 1. … 2. …   (becomes the task list again)
Live: agent <id> <what> · bg task <id> <log> · session local_<id> <state> · PR #N head <sha>, open threads <ids>
Re-propose: <title>: <one-line brief> (was task_<id>)
Resume from: <files> · `<commands>`
```

## Steps

1. Settle what can be settled now: commit (a wip commit is fine), push the PR branch, and note the log path of any gate still running. Don't start new background work.
2. Write the file with the Write tool at `<scratchpad>/handoff.md`.
3. Tell Vlad it's ready in two lines: the path, and anything still in flight. Don't paste the file.

## After compaction

The context starts with `# Compaction handoff` and the file. Before anything else:
- re-post **Next** as the task list (`update_plan`);
- re-propose each **Re-propose** item the "Linked sessions now" note does not show as started (`start_session`, "own_initiative"), then dismiss its old `task_…` id. Cards from before the compaction sit far up in history;
- check that each **Live** agent is still alive before waiting on it (AGENTS.md, "waiting on background subagents");
- leave the consumed file alone; it has done its job (`bd recall feedback_handoff_docs_are_consumables`).

## Not a compaction

- **A usage-limit stop, then "please continue":** the context is intact, but background agents died with the turn. Check and resume each one; no handoff is needed.
- **A reboot:** the conversation survives it, but `/tmp` (your scratchpad included) and every process do not. Commit and push as in step 1, and say in your reply what to restart: dev servers and their ports, `pnpm agent` pairings, background runs.
