# Agent ergonomics eval — baseline-2026-10-15-sonnet

- commit `5a91a0a2af` on `claude/nostalgic-golick-2428f5`
- model `claude-sonnet-5-5`, Claude Code 2.1.285
- km tools: `get_block`, `subtree`, `backlinks`, `page`, `daily_note`, `search`, `sql_query`, `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block`
- fixture `9d499d1fadc8`, 3 repetition(s) per task; per-task figures are medians; lower is better except pass
- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number

| task | kind | pass | tool calls | result bytes (total / max) | context tokens | peak context | output tokens | list $ | time |
|---|---|---|---|---|---|---|---|---|---|
| kestrel-june | read | 3/3 | 7 | 7.9 KB / 2.8 KB | 49k | 11k | 1.4k | $0.053 | 15s |
| summarize-design | read | 3/3 | 2 | 4.3 KB / 3.7 KB | 19k | 7.7k | 0.7k | $0.030 | 8s |
| standup-blockers | read | 3/3 | 4 | 43 KB / 41 KB | 76k | 33k | 1.1k | $0.139 | 13s |
| orchard-open-todos | read | 3/3 | 2 | 4.6 KB / 4.1 KB | 19k | 8.0k | 0.5k | $0.029 | 7s |
| reading-log-needle | read | 3/3 | 4 | 2.7 KB / 1.3 KB | 31k | 7.2k | 0.5k | $0.028 | 10s |
| renewal-vendors | read | 3/3 | 3 | 7.4 KB / 3.9 KB | 22k | 10k | 0.4k | $0.039 | 7s |
| meetings-with-person | read | 2/3 | 4 | 82 KB / 43 KB | 114k | 56k | 1.0k | $0.230 | 12s |
| reading-log-filter | read | 3/3 | 6 | 19 KB / 12 KB | 61k | 17k | 1.1k | $0.085 | 14s |
| daily-checkin | write | 3/3 | 5 | 2.4 KB / 0.5 KB | 24k | 7.3k | 0.6k | $0.029 | 9s |
| edit-rollout-phrase | write | 3/3 | 3 | 4.9 KB / 3.7 KB | 27k | 8.2k | 0.4k | $0.030 | 7s |
| create-linked-page | write | 3/3 | 8 | 8.0 KB / 4.1 KB | 50k | 11k | 0.9k | $0.050 | 12s |
| complete-todo | write | 3/3 | 3 | 5.2 KB / 4.1 KB | 27k | 8.5k | 0.4k | $0.031 | 7s |
| **all** | | 35/36 | 51 | 192 KB | 520k | | 8.9k | $0.771 | 120s |

## Failures

- meetings-with-person #1: count 11 (want 12); dates: all 9 matched

## Tool use

| task | calls by tool (all repetitions) | errors |
|---|---|---|
| kestrel-june | sql_query ×11, search ×3, page ×3, subtree ×2, daily_note ×2 | 0 |
| summarize-design | page ×3, subtree ×3 | 0 |
| standup-blockers | sql_query ×5, page ×3, backlinks ×3, search ×2, subtree ×1, get_block ×1 | 0 |
| orchard-open-todos | page ×3, subtree ×3 | 0 |
| reading-log-needle | page ×3, subtree ×3, sql_query ×2, search ×2, get_block ×1 | 0 |
| renewal-vendors | page ×3, search ×3, sql_query ×3, backlinks ×1 | 0 |
| meetings-with-person | sql_query ×4, page ×3, backlinks ×3, subtree ×3 | 0 |
| reading-log-filter | sql_query ×12, page ×3, subtree ×3 | 0 |
| daily-checkin | create_block ×12, daily_note ×3 | 0 |
| edit-rollout-phrase | page ×3, subtree ×3, update_block ×3 | 0 |
| create-linked-page | page ×10, create_block ×8, subtree ×3, get_block ×2, move_block ×1, sql_query ×1 | 1 |
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

