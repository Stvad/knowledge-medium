# Agent ergonomics eval — baseline-2026-10-16-sonnet

- commit `da927954cc` on `claude/nostalgic-golick-2428f5`
- model `claude-sonnet-5-5`, Claude Code 2.1.285
- km tools: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query`, `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block`; MCP output cap 25000 tokens
- "capped": results over that cap, which Claude Code replaced with a short notice; "seen" is what reached the model, "returned" what the tools produced
- fixture `9d499d1fadc8`, 3 repetition(s) per task; per-task figures are medians; lower is better except pass
- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number

| task | kind | pass | tool calls | capped | bytes seen (total / max) | bytes returned | context tokens | peak context | output tokens | list $ | time |
|---|---|---|---|---|---|---|---|---|---|---|---|
| kestrel-june | read | 0/3 | 7 | 2 | 8.3 KB / 2.9 KB | 250 KB | 53k | 11k | 1.7k | $0.064 | 20s |
| summarize-design | read | 3/3 | 2 | 0 | 4.3 KB / 3.7 KB | 4.3 KB | 19k | 7.7k | 0.6k | $0.029 | 8s |
| standup-blockers | read | 3/3 | 5 | 1 | 42 KB / 41 KB | 131 KB | 74k | 32k | 1.1k | $0.135 | 12s |
| orchard-open-todos | read | 3/3 | 2 | 0 | 4.5 KB / 4.0 KB | 4.5 KB | 19k | 8.0k | 0.4k | $0.027 | 6s |
| reading-log-needle | read | 3/3 | 3 | 1 | 2.7 KB / 1.3 KB | 631 KB | 24k | 7.0k | 0.4k | $0.025 | 9s |
| renewal-vendors | read | 3/3 | 4 | 0 | 6.5 KB / 3.5 KB | 6.5 KB | 21k | 9.8k | 0.4k | $0.035 | 7s |
| meetings-with-person | read | 2/3 | 3 | 0 | 67 KB / 43 KB | 67 KB | 90k | 47k | 1.0k | $0.198 | 14s |
| reading-log-filter | read | 3/3 | 7 | 1 | 19 KB / 12 KB | 647 KB | 62k | 17k | 1.1k | $0.080 | 14s |
| daily-checkin | write | 3/3 | 5 | 0 | 2.4 KB / 0.5 KB | 2.4 KB | 24k | 7.3k | 0.6k | $0.029 | 8s |
| edit-rollout-phrase | write | 3/3 | 3 | 0 | 4.9 KB / 3.7 KB | 4.9 KB | 27k | 8.2k | 0.4k | $0.030 | 7s |
| create-linked-page | write | 3/3 | 7 | 0 | 6.5 KB / 4.0 KB | 6.5 KB | 47k | 10k | 1.0k | $0.047 | 15s |
| complete-todo | write | 3/3 | 3 | 0 | 5.2 KB / 4.0 KB | 5.2 KB | 27k | 8.5k | 0.4k | $0.031 | 8s |
| **all** | | 32/36 | 51 | 5 | 174 KB | 1760 KB | 487k | | 9.2k | $0.731 | 128s |

## Failures

- kestrel-june #1: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- kestrel-june #2: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- meetings-with-person #2: count 13 (want 12); dates: all 9 matched
- kestrel-june #3: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]

## Tool use

| task | calls by tool (all repetitions) | errors |
|---|---|---|
| kestrel-june | sql_query ×11, search ×3, page ×3, backlinks ×1 | 0 |
| summarize-design | page ×3, subtree ×3 | 0 |
| standup-blockers | sql_query ×6, backlinks ×3, search ×2, page ×2 | 0 |
| orchard-open-todos | page ×3, subtree ×3 | 0 |
| reading-log-needle | get_block ×3, search ×2, page ×2, subtree ×2, sql_query ×1 | 0 |
| renewal-vendors | page ×3, search ×3, sql_query ×3, backlinks ×2 | 0 |
| meetings-with-person | page ×3, backlinks ×3, sql_query ×3 | 0 |
| reading-log-filter | sql_query ×12, page ×3, subtree ×3 | 0 |
| daily-checkin | create_block ×12, daily_note ×3 | 0 |
| edit-rollout-phrase | page ×3, subtree ×3, update_block ×3 | 0 |
| create-linked-page | page ×8, create_block ×8, subtree ×3, sql_query ×2 | 1 |
| complete-todo | page ×3, subtree ×3, update_block ×3 | 0 |

## Output sizes on the fixture (deterministic)

| probe | bytes |
|---|---|
| search:pricing | 122,445 |
| search:kestrel | 2,437 |
| backlinks:Meeting | 143,764 |
| backlinks:Kestrel | 3,418 |
| subtree:Reading Log | 652,156 |
| subtree:pasted source | 127,729 |
| subtree:daily note | 2,830 |
| subtree:project page | 4,074 |
| subtree:design doc | 3,778 |
| page:Project Orchard | 571 |

