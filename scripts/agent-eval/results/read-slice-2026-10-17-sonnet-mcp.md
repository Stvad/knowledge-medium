# Agent ergonomics eval — read-slice-2026-10-17-sonnet-mcp

- commit `5192535b83` on `claude/agent-eval-read-slice-results`
- model `claude-sonnet-5-5`, Claude Code 2.1.285
- surface `mcp`, tools allowed: `get_block`, `subtree`, `backlinks`, `grouped_backlinks`, `page`, `daily_note`, `search`, `guide`, `sql_query`, `create_block`, `update_block`, `move_block`, `delete_block`, `restore_block`; output caps 25000 tokens (MCP), 30000 characters (shell); 4 task(s) at a time
- sizes are characters; "capped": results over their cap, which Claude Code cut short or replaced with a notice; "seen" is what reached the model, "returned" what the tools produced, n/a where that is unknown
- fixture `9d499d1fadc8` (stored as `b7fdfa24fe35`), 3 repetition(s) per task, 10 min timeout each; per-task figures are medians; lower is better except pass
- list $ is the API list-price equivalent the CLI reports (a subscription run is not charged it); it weights input, cache and output tokens in one number; n/a where a run ended without reporting it
- compared with **baseline-2026-10-16-sonnet-mcp** (commit `69f595276e`); deltas in parentheses, for the 12 of 12 tasks whose definition is unchanged

| task | kind | pass | tool calls | capped | chars seen | max seen | chars returned | context tokens | peak context | output tokens | list $ | time |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| kestrel-june | read | 0/3 (was 0/3) | 7 (−22%) | 0 (−100%) | 3.3k (−70%) | 1.4k (−60%) | 3.3k (−99%) | 30k (−49%) | 11k (−12%) | 0.9k (−54%) | $0.036 (−47%) | 9s (−49%) |
| summarize-design | read | 3/3 (was 3/3) | 1 (−50%) | 0 | 2.9k (−33%) | 2.9k (−23%) | 2.9k (−33%) | 19k (+2%) | 10k (+32%) | 0.6k (−14%) | $0.026 (−9%) | 6s (−18%) |
| standup-blockers | read | 3/3 (was 3/3) | 3 (−40%) | 0 (−100%) | 19k (+34%) | 18k (+59%) | 19k (−86%) | 63k (+18%) | 19k (+29%) | 0.9k (−30%) | $0.074 (+10%) | 10s (−26%) |
| orchard-open-todos | read | 3/3 (was 3/3) | 1 (−50%) | 0 | 3.1k (−34%) | 3.1k (−24%) | 3.1k (−34%) | 19k (+2%) | 10k (+31%) | 0.4k (+3%) | $0.025 (−5%) | 7s (+14%) |
| reading-log-needle | read | 3/3 (was 3/3) | 1 (−75%) | 0 (−100%) | 0.3k (−92%) | 0.3k (−80%) | 0.3k (−100%) | 18k (−44%) | 8.9k (+21%) | 0.3k (−42%) | $0.018 (−36%) | 6s (−26%) |
| renewal-vendors | read | 3/3 (was 3/3) | 3 (−25%) | 0 | 6.8k (−27%) | 3.5k (−36%) | 6.8k (−27%) | 32k (+40%) | 13k (+15%) | 0.5k (+11%) | $0.038 (−6%) | 6s (+4%) |
| meetings-with-person | read | 3/3 (was 3/3) | 2 (−50%) | 0 | 13k (−81%) | 8.9k (−80%) | 13k (−81%) | 39k (−71%) | 17k (−65%) | 0.7k (−35%) | $0.056 (−73%) | 8s (−38%) |
| reading-log-filter | read | 3/3 (was 3/3) | 3 (−50%) | 1 (±0%) | 25k (+87%) | 21k (+126%) | 110k (−83%) | 77k (+40%) | 23k (+69%) | 1.0k (−13%) | $0.093 (+47%) | 12s (−3%) |
| daily-checkin | write | 3/3 (was 3/3) | 5 (±0%) | 0 | 2.5k (±0%) | 0.6k (±0%) | 2.5k (±0%) | 38k (+58%) | 11k (+48%) | 0.7k (+4%) | $0.033 (+18%) | 8s (+4%) |
| edit-rollout-phrase | write | 3/3 (was 3/3) | 4 (+33%) | 0 | 3.3k (−35%) | 1.9k (−50%) | 3.3k (−35%) | 49k (+84%) | 11k (+31%) | 0.5k (+33%) | $0.034 (+15%) | 7s (+13%) |
| create-linked-page | write | 3/3 (was 3/3) | 10 (+67%) | 0 | 6.8k (+8%) | 1.7k (−58%) | 6.8k (+8%) | 98k (+112%) | 13k (+41%) | 1.2k (+43%) | $0.061 (+43%) | 15s (+17%) |
| complete-todo | write | 3/3 (was 3/3) | 4 (+33%) | 0 | 4.6k (−14%) | 3.1k (−24%) | 4.6k (−14%) | 52k (+92%) | 12k (+37%) | 0.5k (+38%) | $0.037 (+23%) | 8s (+18%) |
| **all** | | 33/36 | 44 (−17%) | 1 (−80%) | 90k (−39%) |  | 176k (−90%) | 534k (+3%) |  | 8.1k (−16%) | $0.531 (−19%) | 101s (−13%) |

## Failures

- kestrel-june #1: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- kestrel-june #2: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]
- kestrel-june #3: dates: all 5 matched; wrong or missing summary for [2026-06-04, 2026-06-18]

## Graph commands

| task | wire commands the graph ran, by type (all repetitions) | tool errors |
|---|---|---|
| kestrel-june | view-outline ×10, view-search ×3, view-backlinks ×3, view-block ×1, sql ×1 | 0 |
| summarize-design | view-outline ×3 | 0 |
| standup-blockers | sql ×6, view-backlinks ×3 | 0 |
| orchard-open-todos | view-outline ×3 | 0 |
| reading-log-needle | view-search ×3 | 0 |
| renewal-vendors | data-model ×3, view-backlinks ×3, sql ×3, view-outline ×2 | 0 |
| meetings-with-person | view-backlinks ×3, sql ×2, view-outline ×2 | 0 |
| reading-log-filter | sql ×7, view-outline ×3 | 0 |
| daily-checkin | create-block ×12, daily-note ×3 | 0 |
| edit-rollout-phrase | update-block ×5, view-outline ×3, view-block ×3 | 2 |
| create-linked-page | create-block ×10, data-model ×6, page ×5, view-block ×5, view-outline ×3, view-backlinks ×1, sql ×1, delete-block ×1 | 2 |
| complete-todo | update-block ×5, view-outline ×3, view-block ×3, data-model ×1 | 2 |

## Output sizes on the fixture, through the km MCP tools (deterministic)

| probe | characters |
|---|---|
| search:pricing | 571 (−100%) |
| search:kestrel | 1,230 (−49%) |
| backlinks:Meeting | 2,647 |
| backlinks:Kestrel | 1,361 |
| subtree:Reading Log | 9,559 |
| subtree:pasted source | 471 |
| subtree:daily note | 1,212 |
| subtree:project page | 1,690 |
| subtree:design doc | 1,872 |
| page:Project Orchard | 571 (±0%) |

