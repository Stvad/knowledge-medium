# Agent ergonomics eval — baseline-2026-10-16-sonnet-cli

- commit `41f754e7c1` on `claude/agent-eval-node-host`
- model `claude-sonnet-5-5`, Claude Code 2.1.285
- surface `cli`, tools allowed: `Bash(kmagent:*)`, `Bash(head:*)`, `Bash(tail:*)`, `Bash(grep:*)`, `Bash(jq:*)`, `Bash(wc:*)`, `Bash(sort:*)`; output caps 25000 tokens (MCP), 30000 characters (shell); 4 task(s) at a time
- sizes are characters; "capped": results over their cap, which Claude Code cut short or replaced with a notice; "seen" is what reached the model, "returned" what the tools produced, n/a where a call never returned
- fixture `9d499d1fadc8` (stored as `dda75dc2999a`), 3 repetition(s) per task, 10 min timeout each; per-task figures are medians; lower is better except pass
- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number; n/a where a run ended without reporting it

| task | kind | pass | tool calls | capped | chars seen | max seen | chars returned | context tokens | peak context | output tokens | list $ | time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kestrel-june | read | 0/3 | 6 | 1 | 27k | 15k | 155k | 86k | 17k | 1.8k | $0.090 | 20s |
| summarize-design | read | 3/3 | 3 | 0 | 18k | 15k | 18k | 36k | 11k | 0.7k | $0.051 | 11s |
| standup-blockers | read | 3/3 | 6 | 1 | 28k | 15k | 148k | 85k | 17k | 1.3k | $0.085 | 16s |
| orchard-open-todos | read | 3/3 | 3 | 0 | 32k | 15k | 32k | 47k | 18k | 0.6k | $0.077 | 10s |
| reading-log-needle | read | 3/3 | 2 | 0 | 15k | 15k | 15k | 25k | 10k | 0.4k | $0.040 | 7s |
| renewal-vendors | read | 3/3 | 4 | 0 | 31k | 15k | 31k | 62k | 17k | 0.6k | $0.075 | 11s |
| meetings-with-person | read | 3/3 | 6 | 1 | 33k | 15k | 90k | 101k | 20k | 1.8k | $0.106 | 21s |
| reading-log-filter | read | 3/3 | 4 | 1 | 19k | 15k | 253k | 48k | 13k | 1.1k | $0.061 | 13s |
| daily-checkin | write | 3/3 | 9 | 0 | 18k | 15k | 18k | 94k | 13k | 1.4k | $0.075 | 17s |
| edit-rollout-phrase | write | 3/3 | 4 | 0 | 19k | 15k | 19k | 48k | 12k | 0.5k | $0.054 | 10s |
| create-linked-page | write | 2/3 | 7 | 0 | 31k | 15k | 31k | 112k | 18k | 1.1k | $0.095 | 19s |
| complete-todo | write | 3/3 | 4 | 0 | 46k | 19k | 46k | 77k | 24k | 0.5k | $0.106 | 11s |
| **all** | | 32/36 | 58 | 4 | 318k |  | 856k | 821k |  | 12k | $0.914 | 165s |

## Failures

- kestrel-june #1: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- create-linked-page #1: first block is null; 0 link(s) under Vendors
- kestrel-june #2: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- kestrel-june #3: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]

## Tool use

| task | calls by tool (all repetitions) | errors |
|---|---|---|
| kestrel-june | kmagent sql ×12, kmagent --help ×3, kmagent page ×3, kmagent data-model ×2, kmagent backlinks ×2, kmagent daily-note ×1, kmagent search ×1 | 2 |
| summarize-design | kmagent --help ×3, kmagent page ×3, kmagent subtree ×3 | 0 |
| standup-blockers | kmagent sql ×11, kmagent --help ×3, kmagent page ×3, kmagent data-model ×2, kmagent backlinks ×2, kmagent subtree ×2, kmagent search ×2 | 2 |
| orchard-open-todos | kmagent --help ×3, kmagent data-model ×3, kmagent page ×3, kmagent subtree ×3, kmagent sql ×2 | 0 |
| reading-log-needle | kmagent --help ×3, kmagent search ×3, kmagent sql ×1 | 0 |
| renewal-vendors | kmagent backlinks ×4, kmagent sql ×4, kmagent --help ×3, kmagent data-model ×3, kmagent page ×3 | 0 |
| meetings-with-person | kmagent sql ×9, kmagent --help ×3, kmagent data-model ×3, kmagent page ×3, kmagent subtree ×1 | 3 |
| reading-log-filter | kmagent --help ×3, kmagent page ×3, kmagent subtree ×3, bash grep ×3 | 0 |
| daily-checkin | kmagent create-block ×21, kmagent subtree ×7, kmagent --help ×3, kmagent daily-note ×3 | 6 |
| edit-rollout-phrase | kmagent update-block ×6, kmagent --help ×3, kmagent page ×3, kmagent subtree ×3, kmagent get-block ×3 | 0 |
| create-linked-page | kmagent create-block ×15, kmagent page ×6, kmagent subtree ×6, kmagent get-block ×4, kmagent --help ×3, kmagent data-model ×3, kmagent eval ×1, kmagent backlinks ×1 | 5 |
| complete-todo | kmagent update-block ×6, kmagent --help ×3, kmagent data-model ×3, kmagent page ×3, kmagent subtree ×3, kmagent get-block ×3 | 0 |

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

