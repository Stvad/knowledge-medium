/** Agent-facing orientation to Knowledge Medium's data model, surfaced
 *  through the bridge CLI so a fresh agent can learn the model without
 *  reverse-engineering it from source. Reachable three ways:
 *    - `yarn agent data-model`            (prints this, rendered)
 *    - `yarn agent describe-runtime --guide data-model`
 *    - pointed at from `yarn agent runtime-summary`
 *
 *  Keep this in sync with the real schema/queries if they change — it is
 *  the canonical agent-facing description of the model. Plain markdown so
 *  the dedicated verb can print it verbatim. */
export const DATA_MODEL_GUIDE = `# Knowledge Medium — data model (for agents)

Mental model: this is broadly **Roam-like** — an outliner of blocks, where
pages, daily notes, and "linked references" (backlinks) all work about how
you'd expect from Roam. That analogy is just a head start; the specifics
below are what's actually true here.

## Everything is a block

There is one node type. \`blocks\` is the universal table:

| column            | meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| \`id\`              | UUID, primary key                                                       |
| \`workspace_id\`    | which workspace (graph) the block lives in                              |
| \`parent_id\`       | parent block id; \`NULL\` for a top-level block (e.g. a page)            |
| \`order_key\`       | fractional-index sort key among siblings (lexicographic order)          |
| \`content\`         | the block's text. **A page's title is its \`content\`.**                 |
| \`properties_json\` | JSON map of typed properties (see below)                                |
| \`references_json\` | JSON of outgoing references (the projected source of \`block_references\`)|
| \`created_at\` / \`updated_at\` / \`user_updated_at\` | timestamps (server/local/edit-time)        |
| \`deleted\`         | soft-delete flag (\`0\`/\`1\`); filter \`deleted = 0\` in raw SQL          |

Two derived/index tables sit alongside it:

- **\`block_references(source_id, target_id, workspace_id, alias, source_field)\`**
  — the link index. One row per outgoing reference. This is what backlinks
  are computed from.
- **\`block_types(block_id, workspace_id, type)\`** — type tags. A block can
  have several types (one row each).

## Pages vs daily notes

- A **page** is a block with type \`page\` (and usually \`parent_id IS NULL\`).
  Its title is its \`content\`.
- A **daily note** is a page with types \`daily-note, page\`. Daily notes are
  nested under a \`Journal\` page and their title/\`content\` is the human date,
  e.g. "June 17th, 2026". They also carry a \`daily-note:date\` property for
  date-comparison queries. (Divergence from Roam: there is no separate
  calendar entity — a daily note is just a typed page.)

## References, \`source_field\`, and backlinks

When block S references block T, you get a \`block_references\` row with
\`source_id = S\`, \`target_id = T\`. The **\`source_field\`** says *how*:

- \`source_field = ''\` → a plain text wikilink \`[[T]]\` in S's body.
- \`source_field = '<propName>'\` → a **projected property reference**: S has a
  ref-typed property (e.g. \`groupWith\`, \`next-review-date\`, \`roam:nextDueDate\`)
  whose value points at T. These are derived from \`properties_json\`, not from
  body text.

**Backlinks of T** = \`block_references\` rows where \`target_id = T\` (minus T's
self-reference). Do **not** approximate backlinks by "blocks located on T's
page", and do **not** filter them by \`created_at\` — that gives the wrong set.

- First-class command: \`yarn agent backlinks <blockId>\` →
  \`backlinks.forBlock\`. Returns hydrated backlinks (id, content, types,
  \`sourceFields\`, deep-link).

## Grouped backlinks (the grouped-references view)

The grouped view takes a **target** block, finds its backlinks, then groups
each backlink by the references of the backlink itself **and every ancestor
up its chain** — plus the containing root page, \`groupWith\` expansion, and
\`types\` enrichment. (Roam-like: "what context is each reference in?")

- First-class command: \`yarn agent grouped-backlinks <blockId>\` →
  \`groupedBacklinks.forBlock\`. Returns the same groups the panel shows:
  each group has a label, an optional deep-link (when the group is a page),
  and hydrated members, plus an \`Other\` fallback bucket.
- To answer "which of page T's backlinks group under page P", run
  \`grouped-backlinks <T>\` and find the group whose label/id is P.

### Filters and grouping config are yours to pick

Both commands let you choose how much of the user's live config to apply:

- \`--filter none\` (default) — no filter; every backlink.
- \`--filter stored\` — the target block's own saved filter.
- \`--filter effective\` — what the UI actually applies (for a daily note,
  this folds in the daily-note default filter).
- \`--filter '<json>'\` — an explicit \`{include?, exclude?}\` BacklinksFilter.

\`grouped-backlinks\` additionally takes:

- \`--grouping user\` (default) — the user's real grouping config (prefs
  defaults merged with per-block overrides). Matches the in-app view.
- \`--grouping none\` — empty config. Note: with no config the generic
  \`Page\`/field groups dominate and the result is misleading — prefer
  \`user\` unless you specifically want the raw grouping.
- \`--grouping '<json>'\` — an explicit (partial) grouping config.

## "Done" / todo status

There is **no** \`DONE\` block type. Completion lives in \`properties_json\`:

- \`status = 'done'\` (KM-native todos; the open value is \`'open'\`), or
- \`roam:todo-state = 'DONE'\` (imported Roam todos; open value \`'TODO'\`).

When triaging todos, check both.

## Deep-link URLs

The app's hash route is \`#<workspaceId>/<blockId>\`; panels can stack, so
multiple slots may follow. A single-block link is just
\`#<workspaceId>/<blockId>\`. The hydrated command output includes ready-made
\`deepLink\` fields.

## Lower-level access

- \`yarn agent get-block <id>\` / \`yarn agent subtree <rootId>\` — fetch a
  block or its subtree.
- \`yarn agent sql <all|get|optional|execute> <sql> [paramsJson]\` — raw SQL
  over the tables above.
- \`yarn agent eval <code>\` — run JS in the app. Inside, the named queries
  are callable directly, e.g.
  \`return await repo.query['groupedBacklinks.forBlock']({workspaceId, id}).load()\`.
  The dedicated commands above wrap exactly these queries and add config
  resolution + hydration, so prefer them unless you need something custom.
`
