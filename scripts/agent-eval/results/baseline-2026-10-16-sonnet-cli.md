# Agent ergonomics eval — baseline-2026-10-16-sonnet-cli

- commit `c6266cd32b` on `claude/agent-eval-node-host`
- model `claude-sonnet-5-5`, Claude Code 2.1.285
- surface `cli`, tools allowed: `Bash(kmagent:*)`, `Bash(head:*)`, `Bash(tail:*)`, `Bash(grep:*)`, `Bash(jq:*)`, `Bash(wc:*)`, `Bash(sort:*)`; output caps 25000 tokens (MCP), 30000 characters (shell); 4 task(s) at a time
- sizes are characters; "capped": results over their cap, which Claude Code cut short or replaced with a notice; "seen" is what reached the model, "returned" what the tools produced, n/a where that is unknown
- fixture `9d499d1fadc8` (stored as `b7fdfa24fe35`), 3 repetition(s) per task, 10 min timeout each; per-task figures are medians; lower is better except pass
- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number; n/a where a run ended without reporting it

| task | kind | pass | tool calls | capped | chars seen | max seen | chars returned | context tokens | peak context | output tokens | list $ | time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kestrel-june | read | 0/3 | 6 | 1 | 24k | 15k | 152k | 82k | 15k | 1.4k | $0.080 | 18s |
| summarize-design | read | 3/3 | 3 | 0 | 18k | 15k | 18k | 35k | 11k | 0.5k | $0.048 | 7s |
| standup-blockers | read | 3/3 | 5 | 2 | 31k | 15k | 268k | 70k | 19k | 1.2k | $0.090 | 15s |
| orchard-open-todos | read | 3/3 | 3 | 0 | 34k | 15k | 34k | 47k | 19k | 0.6k | $0.079 | 9s |
| reading-log-needle | read | 3/3 | 3 | 0 | 16k | 15k | 16k | 35k | 11k | 0.4k | $0.045 | 7s |
| renewal-vendors | read | 3/3 | 4 | 0 | 32k | 15k | 32k | 62k | 18k | 0.8k | $0.081 | 11s |
| meetings-with-person | read | 3/3 | 4 | 1 | 30k | 15k | 84k | 61k | 17k | 1.1k | $0.082 | 14s |
| reading-log-filter | read | 3/3 | 5 | 1 | 20k | 15k | 246k | 60k | 13k | 1.4k | $0.068 | 15s |
| daily-checkin | write | 3/3 | 9 | 0 | 20k | 15k | 20k | 97k | 13k | 1.3k | $0.076 | 17s |
| edit-rollout-phrase | write | 3/3 | 4 | 0 | 32k | 16k | 32k | 60k | 18k | 0.5k | $0.079 | 8s |
| create-linked-page | write | 2/3 | 6 | 0 | 31k | 15k | 31k | 95k | 18k | 1.1k | $0.089 | 16s |
| complete-todo | write | 3/3 | 4 | 0 | 46k | 19k | 46k | 75k | 24k | 0.5k | $0.105 | 10s |
| **all** | | 32/36 | 56 | 5 | 333k |  | 977k | 780k |  | 11k | $0.921 | 147s |

## Failures

- kestrel-june #1: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- kestrel-june #2: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- kestrel-june #3: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- create-linked-page #3: first block is null; 0 link(s) under Vendors

## Graph commands

| task | wire commands the graph ran, by type (all repetitions) | tool errors |
|---|---|---|
| kestrel-june | sql ×9, data-model ×3, page ×3, backlinks ×2 | 1 |
| summarize-design | page ×3, get-subtree ×3 | 0 |
| standup-blockers | sql ×7, page ×3, search ×3, data-model ×1 | 1 |
| orchard-open-todos | data-model ×3, page ×3, get-subtree ×2, sql ×2 | 0 |
| reading-log-needle | search ×3, page ×2, get-block ×1, sql ×1 | 0 |
| renewal-vendors | sql ×6, backlinks ×5, data-model ×3, page ×3, search ×1 | 0 |
| meetings-with-person | sql ×7, data-model ×3, page ×3, backlinks ×1 | 1 |
| reading-log-filter | page ×3, get-subtree ×3 | 3 |
| daily-checkin | create-block ×15, get-subtree ×5, daily-note ×3 | 6 |
| edit-rollout-phrase | page ×3, get-subtree ×3, update-block ×3, get-block ×1 | 0 |
| create-linked-page | create-block ×7, page ×6, get-subtree ×5, get-block ×4, data-model ×3, eval ×1, backlinks ×1 | 4 |
| complete-todo | data-model ×3, page ×3, get-subtree ×3, update-block ×3, get-block ×3 | 0 |

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

