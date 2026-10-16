# Agent ergonomics eval — baseline-2026-10-16-sonnet

- commit `57ed7e2ed4` on `claude/nostalgic-golick-2428f5`
- model `claude-sonnet-5-5`, Claude Code 2.1.285
- km tools: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query`, `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block`; MCP output cap 25000 tokens
- sizes are characters; "capped": results over that cap, which Claude Code replaced with a short notice; "seen" is what reached the model, "returned" what the tools produced
- fixture `9d499d1fadc8` (stored as `7aad2b09df60`), 3 repetition(s) per task, 10 min timeout each; per-task figures are medians; lower is better except pass
- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number; n/a where a run ended without reporting it

| task | kind | pass | tool calls | capped | chars seen (total / max) | chars returned | context tokens | peak context | output tokens | list $ | time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| kestrel-june | read | 2/3 | 9 | 2 | 8.8k / 3.4k | 257k | 72k | 12k | 2.6k | $0.074 | 27s |
| summarize-design | read | 3/3 | 2 | 0 | 4.4k / 3.8k | 4.4k | 19k | 7.7k | 0.7k | $0.029 | 10s |
| standup-blockers | read | 3/3 | 5 | 0 | 45k / 42k | 51k | 107k | 33k | 1.1k | $0.148 | 17s |
| orchard-open-todos | read | 3/3 | 2 | 0 | 4.6k / 4.1k | 4.6k | 19k | 8.0k | 0.3k | $0.027 | 8s |
| reading-log-needle | read | 3/3 | 4 | 1 | 3.4k / 1.3k | 646k | 31k | 7.4k | 0.4k | $0.029 | 10s |
| renewal-vendors | read | 3/3 | 4 | 0 | 7.6k / 3.5k | 7.6k | 22k | 10k | 0.5k | $0.037 | 8s |
| meetings-with-person | read | 3/3 | 4 | 0 | 73k / 44k | 73k | 140k | 50k | 1.1k | $0.217 | 16s |
| reading-log-filter | read | 3/3 | 7 | 1 | 29k / 15k | 672k | 61k | 22k | 1.1k | $0.095 | 14s |
| daily-checkin | write | 3/3 | 5 | 0 | 2.5k / 0.6k | 2.5k | 38k | 7.3k | 0.7k | $0.032 | 12s |
| edit-rollout-phrase | write | 3/3 | 3 | 0 | 5.0k / 3.8k | 5.0k | 27k | 8.2k | 0.4k | $0.030 | 9s |
| create-linked-page | write | 3/3 | 8 | 0 | 6.8k / 4.1k | 6.8k | 57k | 10k | 1.0k | $0.052 | 17s |
| complete-todo | write | 3/3 | 3 | 0 | 5.3k / 4.1k | 5.3k | 27k | 8.5k | 0.4k | $0.031 | 9s |
| **all** | | 35/36 | 56 | 4 | 195k | 1734k | 619k | | 10k | $0.801 | 156s |

## Failures

- kestrel-june #1: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]

## Tool use

| task | calls by tool (all repetitions) | errors |
|---|---|---|
| kestrel-june | sql_query ×19, search ×3, page ×3, daily_note ×2 | 0 |
| summarize-design | page ×3, subtree ×3 | 0 |
| standup-blockers | sql_query ×7, backlinks ×4, page ×2, search ×1 | 0 |
| orchard-open-todos | page ×3, subtree ×3 | 0 |
| reading-log-needle | page ×3, subtree ×3, search ×3, get_block ×3 | 0 |
| renewal-vendors | page ×3, search ×3, sql_query ×3, backlinks ×2 | 0 |
| meetings-with-person | sql_query ×6, page ×3, backlinks ×3 | 0 |
| reading-log-filter | sql_query ×11, subtree ×4, page ×3 | 0 |
| daily-checkin | create_block ×12, daily_note ×3 | 0 |
| edit-rollout-phrase | page ×3, subtree ×3, update_block ×3 | 0 |
| create-linked-page | page ×8, create_block ×7, subtree ×4, sql_query ×2, move_block ×1 | 0 |
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

