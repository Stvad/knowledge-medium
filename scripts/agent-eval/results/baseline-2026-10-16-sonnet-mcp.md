# Agent ergonomics eval — baseline-2026-10-16-sonnet-mcp

- commit `3033a569fc` on `claude/agent-eval-node-host`
- model `claude-sonnet-5-5`, Claude Code 2.1.285
- surface `mcp`, tools allowed: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query`, `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block`; output caps 25000 tokens (MCP), 30000 characters (shell); 4 task(s) at a time
- sizes are characters; "capped": results over their cap, which Claude Code cut short or replaced with a notice; "seen" is what reached the model, "returned" what the tools produced, n/a where a call never returned
- fixture `9d499d1fadc8` (stored as `dda75dc2999a`), 3 repetition(s) per task, 10 min timeout each; per-task figures are medians; lower is better except pass
- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number; n/a where a run ended without reporting it

| task | kind | pass | tool calls | capped | chars seen | max seen | chars returned | context tokens | peak context | output tokens | list $ | time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kestrel-june | read | 2/3 | 9 | 1 | 9.1k | 2.3k | 134k | 79k | 13k | 2.4k | $0.085 | 28s |
| summarize-design | read | 3/3 | 2 | 0 | 4.4k | 3.8k | 4.4k | 19k | 8.0k | 0.6k | $0.030 | 9s |
| standup-blockers | read | 3/3 | 7 | 1 | 13k | 6.9k | 135k | 62k | 14k | 1.1k | $0.066 | 14s |
| orchard-open-todos | read | 3/3 | 2 | 0 | 4.6k | 4.1k | 4.6k | 19k | 8.2k | 0.4k | $0.028 | 7s |
| reading-log-needle | read | 3/3 | 3 | 0 | 2.1k | 0.9k | 2.1k | 19k | 6.9k | 0.4k | $0.022 | 7s |
| renewal-vendors | read | 3/3 | 4 | 0 | 9.3k | 4.3k | 9.3k | 23k | 11k | 0.5k | $0.041 | 8s |
| meetings-with-person | read | 3/3 | 4 | 0 | 83k | 44k | 83k | 136k | 56k | 1.2k | $0.231 | 15s |
| reading-log-filter | read | 3/3 | 8 | 1 | 20k | 12k | 663k | 79k | 18k | 1.1k | $0.084 | 14s |
| daily-checkin | write | 3/3 | 5 | 0 | 2.5k | 0.6k | 2.5k | 25k | 7.5k | 0.6k | $0.029 | 10s |
| edit-rollout-phrase | write | 3/3 | 3 | 0 | 5.0k | 3.8k | 5.0k | 28k | 8.4k | 0.4k | $0.030 | 8s |
| create-linked-page | write | 3/3 | 8 | 0 | 7.2k | 4.1k | 7.2k | 68k | 11k | 1.0k | $0.053 | 15s |
| complete-todo | write | 3/3 | 3 | 0 | 5.3k | 4.1k | 5.3k | 28k | 8.6k | 0.4k | $0.031 | 8s |
| **all** | | 35/36 | 58 | 3 | 166k |  | 1056k | 585k |  | 10k | $0.729 | 141s |

## Failures

- kestrel-june #3: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]

## Tool use

| task | calls by tool (all repetitions) | errors |
|---|---|---|
| kestrel-june | sql_query ×16, search ×3, page ×3, daily_note ×2 | 0 |
| summarize-design | page ×3, subtree ×3 | 0 |
| standup-blockers | sql_query ×9, search ×3, subtree ×2, page ×2, backlinks ×1, get_block ×1 | 0 |
| orchard-open-todos | page ×3, subtree ×3 | 0 |
| reading-log-needle | page ×3, search ×3, get_block ×2, subtree ×1 | 0 |
| renewal-vendors | page ×3, search ×3, sql_query ×3, backlinks ×2 | 0 |
| meetings-with-person | sql_query ×5, page ×3, backlinks ×3 | 0 |
| reading-log-filter | sql_query ×13, subtree ×6, page ×3 | 0 |
| daily-checkin | create_block ×12, daily_note ×3 | 0 |
| edit-rollout-phrase | page ×3, subtree ×3, update_block ×3 | 0 |
| create-linked-page | page ×9, create_block ×6, subtree ×5, sql_query ×3 | 0 |
| complete-todo | page ×3, subtree ×3, update_block ×3 | 0 |

## Output sizes on the fixture (deterministic)

| probe | characters |
|---|---|
| search:pricing | 122,443 |
| search:kestrel | 2,435 |
| backlinks:Meeting | 143,764 |
| backlinks:Kestrel | 3,416 |
| subtree:Reading Log | 644,156 |
| subtree:pasted source | 123,563 |
| subtree:daily note | 2,828 |
| subtree:project page | 4,064 |
| subtree:design doc | 3,776 |
| page:Project Orchard | 571 |

