---
name: compaction-handoff
description: Write the one handoff file a compaction would otherwise lose, and pick up from it afterwards. Use when Vlad says "prepare for compaction", "pls prep", "going to compact", "gonna compact", "compacting now, pls prepare", "anything to do before?", or asks you to save state before a /compact, a reboot or a long pause. Also use right after a compaction that brought back a "# Compaction handoff" note.
---

# Compaction handoff

When Vlad asks you to prepare for a compaction, write ONE file: `handoff.md` in your session scratchpad (the directory your system prompt names). Right after the compaction, a SessionStart hook (`scripts/compaction-handoff.mjs`, matcher `compact` in `.claude/settings.json`) brings it back as a `# Compaction handoff` note after the summary, and renames it to `handoff.consumed.md`.
- If he asks again before compacting, overwrite the same file.
- If he gives you more work instead of compacting, delete the file; the next prep writes a fresh one.

## Write only what the summary drops

The summary keeps:
- the request;
- most of Vlad's messages (short steers are often paraphrased or dropped);
- the files touched, errors, PR numbers and the step in progress.

Claude Code also re-attaches up to 5 files you recently wrote (some by name only), the skills you invoked, CLAUDE.md, and any background Bash task still running.

What survives none of that is ids, the task list, which decisions still hold, and what was verified. That is the file:

```markdown
# Handoff: <goal in one line> (<date>)
Decisions in force: "<Vlad's words>" (each steer that changed the plan; drop superseded ones)
Done, verified: <item> (how: test file, gate log, live check)
Done, unverified: <item> (what would check it)
Next: 1. … 2. …
Live: agent <id> <what> · bg task <id> <log> · session local_<id> <state> · PR #N head <sha>, open threads <ids>
Re-propose: <title> (was task_<id>): <the task, its files, what done looks like>
Resume from: <files> · `<commands>`
```

Keep it under ~60 lines and 4K characters, and leave out any line with nothing in it.

## Steps

1. Commit finished work (a wip commit is fine), and note the log path of any gate still running. Don't start new background work. A compaction leaves the worktree alone, so push only what you would push anyway.
2. Write the file with the Write tool at `<scratchpad>/handoff.md`.
3. Tell Vlad it's ready in two lines: the path, and anything still in flight. Don't paste the file.

## After compaction

When the note arrives:
- **Re-propose** each item the "Linked sessions now" note does not show as started: `start_session`, "own_initiative", using the brief from the note. Then dismiss its old `task_…` id. Cards from before the compaction sit far up in history.
- **Live agents:** check that each is still alive before waiting on it (AGENTS.md, "waiting on background subagents").
- **The task list:** when you next work on the prepared task, seed `update_plan` from **Next**.

## Not a compaction

- **A usage-limit stop, then "please continue":** the context is intact, but background agents may have died with the turn. Check each one before waiting on it; no handoff is needed.
- **A reboot:** the conversation and the worktree survive it, but `/tmp` (your scratchpad included) and every process do not. Say in your reply what to restart: dev servers and their ports, `pnpm agent` pairings, background runs.
