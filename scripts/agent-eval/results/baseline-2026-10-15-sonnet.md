# Agent ergonomics eval — baseline-2026-10-15-sonnet

- commit `c0f9efa50f` on `claude/nostalgic-golick-2428f5`
- model `claude-sonnet-5-5`, Claude Code 2.1.285
- km tools: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query`, `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block`
- fixture `9d499d1fadc8`, 3 repetition(s) per task; per-task figures are medians; lower is better except pass
- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number

| task | kind | pass | tool calls | result bytes (total / max) | context tokens | peak context | output tokens | list $ | time |
|---|---|---|---|---|---|---|---|---|---|
| kestrel-june | read | 1/3 | 7 | 9.3 KB / 2.2 KB | 78k | 13k | 2.0k | $0.084 | 26s |
| summarize-design | read | 3/3 | 2 | 4.3 KB / 3.7 KB | 19k | 7.7k | 0.7k | $0.030 | 8s |
| standup-blockers | read | 3/3 | 7 | 22 KB / 14 KB | 81k | 19k | 1.2k | $0.093 | 14s |
| orchard-open-todos | read | 3/3 | 2 | 4.5 KB / 4.0 KB | 19k | 8.0k | 0.4k | $0.027 | 7s |
| reading-log-needle | read | 3/3 | 4 | 3.4 KB / 1.3 KB | 31k | 7.4k | 0.4k | $0.029 | 8s |
| renewal-vendors | read | 3/3 | 4 | 8.0 KB / 3.8 KB | 22k | 11k | 0.5k | $0.039 | 8s |
| meetings-with-person | read | 2/3 | 3 | 81 KB / 43 KB | 99k | 56k | 0.9k | $0.231 | 15s |
| reading-log-filter | read | 3/3 | 6 | 17 KB / 12 KB | 61k | 16k | 1.0k | $0.079 | 12s |
| daily-checkin | write | 3/3 | 5 | 2.4 KB / 0.5 KB | 38k | 7.3k | 0.6k | $0.031 | 10s |
| edit-rollout-phrase | write | 3/3 | 3 | 4.9 KB / 3.7 KB | 27k | 8.2k | 0.4k | $0.030 | 8s |
| create-linked-page | write | 3/3 | 8 | 7.4 KB / 4.0 KB | 59k | 11k | 1.0k | $0.054 | 14s |
| complete-todo | write | 3/3 | 3 | 5.2 KB / 4.0 KB | 27k | 8.5k | 0.4k | $0.031 | 7s |
| **all** | | 33/36 | 54 | 170 KB | 560k | | 9.6k | $0.757 | 137s |

## Failures

- kestrel-june #1: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- meetings-with-person #2: count 9 (want 12); dates: all 9 matched
- kestrel-june #3: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]

## Tool use

| task | calls by tool (all repetitions) | errors |
|---|---|---|
| kestrel-june | sql_query ×15, search ×3, page ×3, daily_note ×1 | 0 |
| summarize-design | page ×3, subtree ×3 | 0 |
| standup-blockers | sql_query ×11, page ×3, search ×3, subtree ×3, get_block ×1 | 0 |
| orchard-open-todos | page ×3, subtree ×3 | 0 |
| reading-log-needle | page ×3, subtree ×3, search ×2, get_block ×2, sql_query ×1 | 0 |
| renewal-vendors | page ×3, search ×3, sql_query ×3, backlinks ×2 | 0 |
| meetings-with-person | sql_query ×4, page ×3, backlinks ×3 | 0 |
| reading-log-filter | sql_query ×10, subtree ×4, page ×3 | 0 |
| daily-checkin | create_block ×12, daily_note ×3, subtree ×1 | 0 |
| edit-rollout-phrase | page ×3, subtree ×3, update_block ×3 | 0 |
| create-linked-page | page ×8, create_block ×7, subtree ×4, get_block ×2, move_block ×1 | 0 |
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

