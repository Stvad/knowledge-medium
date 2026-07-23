/** Agent-facing orientation to Knowledge Medium's data model, surfaced
 *  through the bridge CLI so a fresh agent can learn the model without
 *  reverse-engineering it from source. Reachable three ways:
 *    - `pnpm agent data-model`            (prints this, rendered)
 *    - `pnpm agent describe-runtime --guide data-model`
 *    - pointed at from `pnpm agent runtime-summary`
 *
 *  Keep this in sync with the real schema/queries if they change — it is
 *  the canonical agent-facing description of the model. Plain markdown so
 *  the dedicated verb can print it verbatim. */
export const DATA_MODEL_GUIDE = `# Knowledge Medium — data model (for agents)

Mental model: this is broadly **Roam-like** — an outliner of blocks, where
pages, daily notes, and "linked references" (backlinks) work about how you'd
expect from Roam. That analogy is just a head start; the specifics below are
what's actually true here.

## Everything is a block

There is one node type. \`blocks\` is the universal table:

| column            | meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| \`id\`              | UUID, primary key                                                       |
| \`workspace_id\`    | which workspace (graph) the block lives in                              |
| \`parent_id\`       | parent block id; \`NULL\` for a top-level block (e.g. a page)            |
| \`order_key\`       | fractional-index sort key among siblings — compare with plain \`<\` (codepoint), never \`localeCompare\`/numeric (see "Sibling order") |
| \`content\`         | the block's text. **A page's title is its \`content\`.**                 |
| \`properties_json\` | JSON map of typed properties (see "Types & properties")                 |
| \`references_json\` | JSON of outgoing references (the projected source of \`block_references\`)|
| \`created_at\` / \`updated_at\` / \`user_updated_at\` | timestamps (server/local/edit-time)        |
| \`deleted\`         | soft-delete flag (\`0\`/\`1\`); filter \`deleted = 0\` in raw SQL          |

Two derived/index tables sit alongside it (trigger-maintained — you read
them, you don't write them):

- **\`block_references(source_id, target_id, workspace_id, alias, source_field)\`**
  — the link index; backlinks are computed from it.
- **\`block_types(block_id, workspace_id, type)\`** — type tags, one row per type.
- (also \`block_aliases\` for name→block lookup and \`blocks_fts\` for content
  search — both fed by the named queries below, rarely queried directly.)

A real graph is large (hundreds of thousands of blocks). Prefer the named
queries and commands below over hand-rolled \`SELECT … LIKE\` scans.

**Sibling order (\`order_key\`).** \`order_key\` is a *fractional-index* string
ordered by **plain codepoint comparison** (JS \`<\`, SQLite default collation) —
uppercase sorts before lowercase, so e.g. \`"Zy6AX" < "a00zE"\`. Do **NOT**
re-order siblings with \`localeCompare\` (case-folds → inverts the order) or by
numeric coercion (it is not a number). And you rarely need to: \`subtree\`,
\`children\`, and the children-ordered queries already return rows in correct
\`(order_key, id)\` order — **preserve the order you're given; don't re-sort.**

## Pages, aliases, and finding them by name

- A **page** is a block with type \`page\` (usually \`parent_id IS NULL\`); its
  title is its \`content\`.
- Pages can have **multiple names**: the \`alias\` property is a string array,
  and any alias resolves to the page. \`[[Some Name]]\` in text links to
  whichever block claims that alias.
- To find a page by name use \`pnpm agent page <name>\` (exact alias hit +
  substring candidates) — don't scan \`content\`. Pages + aliases are the most
  common things in the graph.

## Daily notes & dates

A **daily note** is a page with types \`daily-note, page\`, nested under a
\`Journal\` page. Its title/\`content\` is the human date ("June 17th, 2026") and
it carries a \`daily-note:date\` property for date-comparison queries.
(Divergence from Roam: no separate calendar entity — a daily note is just a
typed page. Daily-note block ids are deterministic from workspace + ISO date.)

- \`pnpm agent daily-note <date>\` resolves \`today\` | \`yesterday\` | an ISO date |
  the literal title | natural language ("next monday") to the daily-note
  block (and tells you whether it exists yet).

## References, \`source_field\`, and backlinks

When block S references block T, you get a \`block_references\` row with
\`source_id = S\`, \`target_id = T\`. The **\`source_field\`** says *how*:

- \`source_field = ''\` → a plain text wikilink \`[[T]]\` (or \`#tag\`) in S's body.
- \`source_field = '<propName>'\` → a **projected property reference**: S has a
  ref-typed property whose value points at T. Common ones in real data:
  \`roam:author\`, \`next-review-date\`, \`roam:isa\`, \`location\`, \`groupWith\`.
  These are derived from \`properties_json\`, not body text.

**Backlinks of T** = \`block_references\` rows where \`target_id = T\` (minus T's
self-reference). Do **not** approximate backlinks by "blocks on T's page", and
do **not** filter them by \`created_at\` — that gives the wrong set.

- \`pnpm agent backlinks <blockId>\` → hydrated backlinks (id, content, types,
  \`sourceFields\`, deep-link).

## Grouped backlinks (the grouped-references view)

The grouped view takes a **target**, finds its backlinks, then groups each
backlink by the references of the backlink itself **and every ancestor up its
chain** — plus the containing root page, \`groupWith\` expansion, and \`types\`
enrichment. ("What context is each reference in?")

- \`pnpm agent grouped-backlinks <blockId>\` → the same groups the panel shows
  (label, optional page deep-link, hydrated members) plus an \`Other\` fallback.
- "Which of page T's backlinks group under page P?" → run
  \`grouped-backlinks <T>\` and find the group whose label/id is P.

### Filters and grouping are yours to pick (both backlink commands)

- \`--filter none\` (default) — no filter; every backlink.
- \`--filter stored\` — the target block's own saved filter.
- \`--filter effective\` — what the UI applies (folds in daily-note defaults).
- \`--filter '<json>'\` — an explicit \`{include?, exclude?}\` BacklinksFilter.

\`grouped-backlinks\` also takes \`--grouping user\` (default; the user's real
config, matches the UI) | \`none\` (empty — generic groups dominate, can
mislead) | \`'<json>'\`.

## Other block kinds you'll meet

The graph is more than pages. The common typed blocks (by frequency):

- **todo** — a task. Completion lives in \`properties_json\`, not a type:
  \`status = 'done'\` (KM-native; open = \`'open'\`) or \`roam:todo-state = 'DONE'\`
  (imported Roam; open = \`'TODO'\`). Check both when triaging.
- **srs-sm2.5** — a spaced-repetition card. Scheduling lives in properties:
  \`next-review-date\` (a ref to a daily note), \`interval\`, \`factor\`,
  \`review-count\`, \`grade\`. Imported Roam SRS uses \`roam:nextDueDate\`,
  \`roam:eFactor\`, \`roam:interval\`, \`roam:repetitions\`. "What's due" = cards
  whose \`next-review-date\` is today or earlier.
- **place** — a geo location (the geo plugin); \`location\`-field refs point at
  places. **matrix-message**, **readwise-highlight/-document/-note** — imported
  from those sources. **map**, **panel**/**panel-stack** (saved layouts).
- **archived** is a property (\`archived: true\`), not a type — archived blocks
  still exist and are returned by queries unless you filter them out.

## Types & properties

- **Types are multi-valued** (\`block_types\`, the \`types\` property). A block can
  be \`daily-note, page\` at once.
- **User-defined types are UUIDs.** Built-in types are readable strings
  (\`page\`, \`todo\`). User-created types store the *type block's id* in \`types\`,
  so a raw type can be a UUID you must dereference to a label (the type's own
  block; \`block-type\` / \`property-schema\` blocks define them). Backlinks/
  grouped output already resolves type labels for you.
- **Properties are typed.** Each property name has a schema (codec +
  changeScope). Reading raw \`properties_json\` gives encoded values; the
  block APIs (\`block.get(schema)\`, \`peekProperty\`) decode them.
- **Imported-source convention:** \`roam:*\` and \`readwise:*\` property names are
  origin-tagged data from a Roam/Readwise import (e.g. \`roam:author\`,
  \`roam:URL\`, \`roam:create/user\`, \`readwise:author\`). Treat them as the source
  of truth they were imported from; don't delete them when migrating.
- \`system:*\` (e.g. \`system:collapsed\`) is UI/system state, not user content.
- To inspect code-declared and block-projected property definitions:
  \`pnpm agent describe-runtime --facets data.definition-seeds --facets data.projected-property-definitions\`.
  Inspect types the same way: \`pnpm agent describe-runtime --facets data.type-seeds --facets data.projected-type-definitions\`
  (\`data.types\` holds only kernel/plugin CODE types — user-created \`block-type\`
  blocks project into \`data.projected-type-definitions\`, so \`data.types\` alone
  will not show them).

## Finding things — the named queries you can call

These are reachable in \`pnpm agent eval\` via \`repo.query.<name>(args).load()\`.
The convenience commands above wrap the starred ones (★) and add hydration.

- ★ \`aliasLookup({workspaceId, alias})\` → page by exact name (\`page\` verb).
- ★ \`aliasMatches({workspaceId, filter, limit?})\` → name substring candidates.
- ★ \`searchByContent({workspaceId, query, limit?})\` → content FTS (\`search\` verb).
- ★ \`backlinks.forBlock({workspaceId, id, filter?, rawSources?})\` → backlink source ids (default hides property-machinery value rows; \`rawSources: true\` for the raw index).
- ★ \`groupedBacklinks.forBlock({workspaceId, id, filter?, groupingConfig?})\`.
- \`byType({workspaceId, type})\` → all blocks of a type (e.g. \`todo\`, \`srs-sm2.5\`).
- \`recentBlocks({workspaceId, limit?})\` → recently-touched blocks.
- \`children({id})\` / \`childIds({id})\` / \`subtree({id})\` / \`ancestors({id})\`
  / \`manyAncestors({ids})\` → outline structure.
- \`typedBlockIds({workspaceId, match?, exclude?, referencedBy?, order?})\` → the
  unified predicate engine backing backlinks/filters.
- \`aliasesInWorkspace({workspaceId, filter?})\` → all alias strings.

(Daily-note ids are derived, not queried: \`daily-note <date>\` resolves them.)

## Lower-level access

- \`pnpm agent get-block <id>\` — fetch one block.
- \`pnpm agent subtree <rootId>\` — fetch a subtree (root included). Prints a
  depth-indented \`- [id] content\` outline (one line per block, id first);
  add \`--json\` for the raw flat array (each row also carries its \`depth\`
  from the root — 0 at the root).
  Either way it's a **pre-order** traversal with siblings in \`(order_key, id)\`
  order — already sorted; read it top-to-bottom, don't re-sort (see "Sibling
  order").
- \`pnpm agent sql <all|get|optional|execute> <sql> [paramsJson]\` — raw SQL.
- \`pnpm agent move-block <json>\` — structural move via \`repo.mutate.move\`;
  body is \`{id, parentId:string|null, position:{kind:"first"|"last"|"before"|"after", siblingId?}}\`.
- \`pnpm agent delete-block <id>\` — soft-delete a block and its descendants
  via \`repo.mutate.delete\`.
- \`pnpm agent restore-block <id>\` — restore one tombstoned block via
  \`repo.mutate.restore\`; descendants stay deleted unless restored separately.
- \`pnpm agent eval <code>\` — run JS in the app; the named queries above are
  callable directly. The dedicated commands wrap them with config
  resolution + hydration, so prefer them unless you need something custom.
`
