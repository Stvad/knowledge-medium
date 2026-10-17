# Agent ergonomics eval — baseline-2026-10-16-sonnet-mcp

- commit `31dc7f9534` on `claude/agent-eval-node-host`
- model `claude-sonnet-5-5`, Claude Code 2.1.285
- surface `mcp`, tools allowed: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query`, `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block`; output caps 25000 tokens (MCP), 30000 characters (shell); 4 task(s) at a time
- sizes are characters; "capped": results over their cap, which Claude Code cut short or replaced with a notice; "seen" is what reached the model, "returned" what the tools produced, n/a where that is unknown
- fixture `9d499d1fadc8` (stored as `b7fdfa24fe35`), 3 repetition(s) per task, 10 min timeout each; per-task figures are medians; lower is better except pass
- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number; n/a where a run ended without reporting it

| task | kind | pass | tool calls | capped | chars seen | max seen | chars returned | context tokens | peak context | output tokens | list $ | time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kestrel-june | read | 2/3 | 8 | 2 | 6.4k | 1.5k | 254k | 60k | 11k | 2.3k | $0.067 | 22s |
| summarize-design | read | 3/3 | 2 | 0 | 4.4k | 3.8k | 4.4k | 19k | 7.7k | 0.7k | $0.029 | 7s |
| standup-blockers | read | 3/3 | 6 | 1 | 16k | 13k | 138k | 61k | 14k | 1.1k | $0.064 | 13s |
| orchard-open-todos | read | 3/3 | 2 | 0 | 4.6k | 4.1k | 4.6k | 19k | 7.9k | 0.4k | $0.027 | 6s |
| reading-log-needle | read | 3/3 | 4 | 1 | 3.5k | 1.4k | 646k | 31k | 7.4k | 0.5k | $0.028 | 8s |
| renewal-vendors | read | 3/3 | 4 | 0 | 9.2k | 4.2k | 9.2k | 23k | 11k | 0.5k | $0.041 | 6s |
| meetings-with-person | read | 3/3 | 3 | 0 | 48k | 44k | 48k | 92k | 33k | 1.0k | $0.147 | 11s |
| reading-log-filter | read | 3/3 | 6 | 1 | 5.8k | 2.0k | 649k | 43k | 9.1k | 1.1k | $0.044 | 12s |
| daily-checkin | write | 3/3 | 5 | 0 | 2.5k | 0.6k | 2.5k | 24k | 7.2k | 0.6k | $0.028 | 8s |
| edit-rollout-phrase | write | 3/3 | 3 | 0 | 5.0k | 3.8k | 5.0k | 27k | 8.2k | 0.4k | $0.029 | 7s |
| create-linked-page | write | 3/3 | 8 | 0 | 7.1k | 4.1k | 7.1k | 59k | 10k | 1.1k | $0.051 | 13s |
| complete-todo | write | 3/3 | 3 | 0 | 5.3k | 4.1k | 5.3k | 27k | 8.4k | 0.4k | $0.030 | 7s |
| **all** | | 35/36 | 54 | 5 | 118k |  | 1773k | 483k |  | 9.9k | $0.584 | 120s |

## Failures

- kestrel-june #1: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]

## Graph commands

| task | wire commands the graph ran, by type (all repetitions) | tool errors |
|---|---|---|
| kestrel-june | sql ×13, search ×3, page ×3, daily-note ×1 | 0 |
| summarize-design | page ×3, get-subtree ×3 | 0 |
| standup-blockers | sql ×9, search ×3, get-subtree ×2, page ×2, backlinks ×1 | 0 |
| orchard-open-todos | page ×3, get-subtree ×3 | 0 |
| reading-log-needle | page ×3, get-subtree ×3, search ×3, get-block ×2 | 0 |
| renewal-vendors | page ×3, search ×3, sql ×3, backlinks ×3 | 0 |
| meetings-with-person | sql ×4, page ×3, backlinks ×3 | 0 |
| reading-log-filter | sql ×12, page ×3, get-subtree ×3 | 0 |
| daily-checkin | create-block ×12, daily-note ×3 | 0 |
| edit-rollout-phrase | page ×3, get-subtree ×3, update-block ×3 | 0 |
| create-linked-page | page ×8, create-block ×7, get-subtree ×4, sql ×3, move-block ×1 | 0 |
| complete-todo | page ×3, get-subtree ×3, update-block ×3 | 0 |

## Output sizes on the fixture, through the km MCP tools (deterministic)

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

