import type { DataModelTopic } from '@knowledge-medium/agent-cli/protocol'

const GUIDE_INTRO = `# Knowledge Medium — data model (for agents)

Mental model: this is broadly **Roam-like** — an outliner of blocks, where
pages, daily notes, and "linked references" (backlinks) work about how you'd
expect from Roam. That analogy is just a head start; the specifics below are
what's actually true here.
`

interface GuideSection {
  topic: DataModelTopic
  text: string
}

/** The guide's sections in reading order, each tagged with the topic id an
 *  agent passes to read it alone. */
const GUIDE_SECTIONS: GuideSection[] = [
  {
    topic: 'blocks',
    text: `## Everything is a block

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
`,
  },
  {
    topic: 'pages',
    text: `## Pages, aliases, and finding them by name

- A **page** is a block with type \`page\` (usually \`parent_id IS NULL\`); its
  title is its \`content\`.
- Pages can have **multiple names**: the \`alias\` property is a string array,
  and any alias resolves to the page. \`[[Some Name]]\` in text links to
  whichever block claims that alias.
- Commands that take a block (\`get-block\`, \`subtree\`, \`backlinks\`,
  \`grouped-backlinks\`, \`search --under\`) accept a **block ref**: a full id, a unique id prefix as
  printed (\`^3f2a9c1d\`), a page name (or \`[[Page name]]\`), or a date for its
  daily note — so \`subtree "Project Alpha"\` and \`subtree today\` need no lookup.
- To find a page by name use \`pnpm agent page <name>\` (exact alias hit +
  substring candidates) — don't scan \`content\`. Pages + aliases are the most
  common things in the graph.
`,
  },
  {
    topic: 'daily-notes',
    text: `## Daily notes & dates

A **daily note** is a page with types \`daily-note, page\`, nested under a
\`Journal\` page. Its title/\`content\` is the human date ("June 17th, 2026") and
it carries a \`daily-note:date\` property for date-comparison queries.
(Divergence from Roam: no separate calendar entity — a daily note is just a
typed page. Daily-note block ids are deterministic from workspace + ISO date.)

- \`pnpm agent daily-note <date>\` resolves \`today\` | \`yesterday\` | an ISO date |
  the literal title | natural language ("next monday") to the daily-note
  block (and tells you whether it exists yet).
`,
  },
  {
    topic: 'references',
    text: `## References, \`source_field\`, and backlinks

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

- \`pnpm agent backlinks <ref>\` → a page of backlinks (\`--limit\`, \`--offset\`),
  each with its breadcrumb, the property it links through when not body text,
  and — for a block that is only a link — its parent's text and first child.
  \`--raw\` returns every backlink hydrated (id, content, types, \`sourceFields\`,
  deep-link).
`,
  },
  {
    topic: 'grouped-backlinks',
    text: `## Grouped backlinks (the grouped-references view)

The grouped view takes a **target**, finds its backlinks, then groups each
backlink by the references of the backlink itself **and every ancestor up its
chain** — plus the containing root page, \`groupWith\` expansion, and \`types\`
enrichment. ("What context is each reference in?")

- \`pnpm agent grouped-backlinks <ref>\` → the same groups the panel shows
  (label, size, first few members; \`--offset\` pages groups) plus an \`Other\`
  fallback. \`--raw\` returns every group with every member hydrated.
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
`,
  },
  {
    topic: 'block-kinds',
    text: `## Other block kinds you'll meet

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
`,
  },
  {
    topic: 'properties',
    text: `## Types & properties

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
`,
  },
  {
    topic: 'queries',
    text: `## Finding things — the named queries you can call

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
`,
  },
  {
    topic: 'writing',
    text: `## Writing

Write the way you would edit files, and let the app do the outline:

- \`append-markdown <target> <markdown>\` (MCP \`append_markdown\`) — markdown is
  split into blocks exactly as the app's "paste as markdown" splits it (bullets
  and headings nest; a fenced code block, table or quote stays one block) and
  inserted in ONE transaction. Default position: after the target's last child.
- A **target** is a block id or unique id prefix (\`^3f2a9c1b\`), a
  \`[[Page name]]\` (created when missing, exactly as typing the wikilink
  would — a date-literal name is that daily note), or a date expression
  (\`today\`, \`2026-10-15\`, \`next monday\` → that day's daily note, created
  when missing). A bare name only finds an EXISTING page; creating one takes
  the explicit \`[[…]]\`. \`create-page <name> | --date <expr>\` creates without
  writing content.
- \`edit-block <id> <old> <new>\` — replace the one occurrence of \`old\`,
  applied against the content current at write time; refused when \`old\` is
  missing or ambiguous. Prefer it to rewriting a whole block.
- \`update-block\` replaces the whole content (properties merge). Pass
  \`expectedContent\` — what you read — and it is refused if the user changed
  the block since.
- **Todos** compose the built-in \`todo\` type: create a block with properties
  \`{"types": ["todo"], "status": "open"}\`; complete it with
  \`update-block {id, properties: {"status": "done"}}\`.
- \`recent-changes\` lists what agent writes changed (\`--all\` adds the user's
  own edits); \`block-history <id>\` shows one block's changes with full prior
  content, to review or restore. Every bridge write is recorded as a
  transaction described \`agent runtime <verb>\`.
`,
  },
  {
    topic: 'sql',
    text: `## Lower-level access

- \`pnpm agent get-block <ref>\` — one block: content (cut past \`--max-chars\`,
  continued with \`--content-offset\`), breadcrumb, types, decoded properties,
  child and backlink counts. \`--raw\` for the stored row.
- \`pnpm agent subtree <ref>\` — a bounded markdown outline, one line per block:
  \`- content  key:: value  ^shortid\`. \`--depth\` / \`--limit\` bound it
  (shallower levels fill first); \`(+N children)\` marks what was not expanded,
  \`…[+N chars]\` what was cut, and a long child list ends with the
  \`--offset\` to continue. \`--json\` for the same view structured; \`--raw\`
  for the whole stored subtree as a flat array (each row carries its \`depth\`).
  Every form is a **pre-order** traversal with siblings in \`(order_key, id)\`
  order — already sorted; read it top-to-bottom, don't re-sort (see "Sibling
  order").
- \`pnpm agent sql <all|get|optional|execute> <sql> [paramsJson]\` — raw SQL.
- \`pnpm agent move-block <json>\` — structural move via the \`core.move\` mutator;
  body is \`{id, parentId:string|null, position:{kind:"first"|"last"|"before"|"after", siblingId?}}\`.
- \`pnpm agent delete-block <id>\` — soft-delete a block and its descendants
  via the \`core.delete\` mutator.
- \`pnpm agent restore-block <id>\` — restore one tombstoned block via the
  \`core.restore\` mutator; descendants stay deleted unless restored separately.
- \`pnpm agent eval <code>\` — run JS in the app; the named queries above are
  callable directly. The dedicated commands wrap them with config
  resolution + hydration, so prefer them unless you need something custom.
`,
  },
]

/** Agent-facing orientation to Knowledge Medium's data model, surfaced
 *  through the bridge CLI so a fresh agent can learn the model without
 *  reverse-engineering it from source. Reachable three ways:
 *    - `pnpm agent data-model`   (an index; `--topic <id>` reads a section,
 *                                 `--topic all` prints this verbatim)
 *    - `pnpm agent describe-runtime --guide data-model`  (this, verbatim)
 *    - pointed at from `pnpm agent runtime-summary`
 *
 *  Keep this in sync with the real schema/queries if they change — it is
 *  the canonical agent-facing description of the model. Plain markdown, so
 *  it prints as it is. */
export const DATA_MODEL_GUIDE = [GUIDE_INTRO, ...GUIDE_SECTIONS.map(section => section.text)].join('\n')

const GUIDE_TOPIC_ALL = 'all'

const headingOf = (section: GuideSection): string =>
  section.text.slice(3, section.text.indexOf('\n')).replace(/`/g, '').trim()

/** Lowercased words with a plural ending dropped, so `page` meets `pages`
 *  and `query` meets `queries`. */
const wordsOf = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(word => word.replace(/ies$/, 'y').replace(/s$/, ''))

const fits = (haystack: string, guess: string[]): boolean => {
  const words = new Set(wordsOf(haystack))
  return guess.every(word => words.has(word))
}

const only = <T>(matches: T[]): T | undefined => matches.length === 1 ? matches[0] : undefined

/** The one section a guessed topic means: its id, else the only section
 *  whose id and heading hold every word of the guess, else the only one
 *  whose text does. */
const guessSection = (guess: string): GuideSection | undefined => {
  const words = wordsOf(guess)
  return only(GUIDE_SECTIONS.filter(section => fits(`${section.topic} ${headingOf(section)}`, words)))
    ?? only(GUIDE_SECTIONS.filter(section => fits(section.text, words)))
}

const guideIndex = (): string => {
  const index = GUIDE_SECTIONS.map(section => `- \`${section.topic}\` — ${headingOf(section)}`)
  return `${GUIDE_INTRO.trim()}\n\nTopics (read one with topic: <id>, or "${GUIDE_TOPIC_ALL}" for the whole guide):\n${index.join('\n')}\n`
}

/** The guide as an agent reads it: with no topic, the opening and an index
 *  of its sections, so the whole of it is never the first thing read; a
 *  topic reads that section, and `all` the whole guide. A guess that is no
 *  id reads the section it plainly means, or the index — never an error,
 *  since the index is the answer to a topic that does not exist. */
export const dataModelGuide = (topic?: string): string => {
  const wanted = topic?.trim().toLowerCase()
  if (!wanted) return guideIndex()
  if (wanted === GUIDE_TOPIC_ALL) return DATA_MODEL_GUIDE
  const exact = GUIDE_SECTIONS.find(section => section.topic === wanted)
  if (exact) return exact.text
  const guessed = guessSection(wanted)
  if (guessed) return `(No topic "${topic}"; reading \`${guessed.topic}\`.)\n\n${guessed.text}`
  return `No topic "${topic}".\n\n${guideIndex()}`
}
