# Portable property and type keys

> **Status:** proposal, nothing built. The two decisions in §8 are open.
> **Last verified against code:** 2026-11-21, master `fd7abbb9a51`. Row counts measured the
> same day on the largest live workspace through the agent bridge's read verbs.

Tracking issue: #1795. Independent of the sharing design (PR #1790), which is where the question
came from.

Claims are marked by how they were established: **read** (in the code, this session, by me or by
a review pass that cited the line), **measured** (a read-only query against a live client), or
**reasoned** (inferred, not run). Nothing here was prototyped.

## 1. Recommendation

The question: should a property, and a user-defined type, be identified in stored content by a
frozen workspace-independent key (`::[[prop/<key>]]`, a `type/<key>` token) instead of by its
definition block's id?

**Adopt the key. Do not store it in the rows.**

1. **The key is the property's name, frozen.** `properties_json` is already keyed by it and the
   seed ledger already freezes it for built-ins. What is not portable today is only the pointer
   in the field row. Freeze the name for user-defined properties too and add a separate display
   label; a rename then edits the definition and no consumer.
2. **`prop/<key>` and `type/<id>` are reserved names that resolve through the definition
   registries.** Nothing is stored for them: no alias on any definition row, no migration, no
   new synced data. `[[prop/status]]` in prose becomes a real reference to the definition, with
   a backlink.
3. **A field row that is bound is always `::((fieldId))`.** One kernel processor rewrites a
   locally written `::[[prop/<key>]]` row to the id form when the key resolves. A key that does
   not resolve leaves the row as written: visible, readable, its values intact, and not
   machinery.
4. **Copy and markdown export write the key form.** So a row leaves a workspace as
   `::[[prop/status]]` and, by item 3, binds wherever it lands.
5. **Types: only the reserved name.** `[[type/page]]` resolves. Membership tokens are untouched,
   and translating a user-defined type's token across workspaces is deferred (five such types
   exist in the largest graph).

What each piece buys, so it can be cut along the line:

| Piece | Buys | Without it |
|---|---|---|
| frozen name + label | keys that survive a rename, in other workspaces and in old exports | every rename strands exported and prose key references |
| reserved-name resolution | `[[prop/…]]` and `[[type/…]]` as references and backlinks | properties are portable but not referenceable in prose |
| bind-on-write processor | paste, import, move and agent writes all bind, through one owner | each inbound path binds for itself |
| export in key form | readable markdown; cross-workspace paste works | exported rows carry ids that mean nothing elsewhere |

Items 3 and 4 are the pair the properties-as-blocks design named as follow-ups and never built
("copy resolves references" out, definitions answering to their name in). What is new here: the
name is reserved and prefixed instead of bare, so it cannot collide with a page; it is frozen;
and it is resolved by the registry instead of claimed in the alias index, which removes the
collision policy #1407 asks for.

**Two decisions are yours** (§8 has the examples):

- *Where the key form lives.* Border only, as above (my pick), or as the stored form of every
  field row.
- *What a rename does.* Edits the label and leaves the key (my pick), or re-keys as today.

Where the original framing overreached, in my reading:

- "One identity for the cell and the rows" does not come from a key form. Freezing the name
  removes the *reconciliation* between cell and row, which is the actual cost; respelling the
  row adds nothing to that.
- "Merging duplicate definitions rewrites no usages" is true of a stored key form. But the
  existing merge already retargets field rows through their reference edges (measured: every
  field row has one), so this is a saving on a rare operation, not a missing capability.
- "Stop a type's label competing with a page name" I would not do. A user-defined type block
  *is* its page; `[[Person]]` resolving to the type is the model. `type/…` is additional.

## 2. What exists today

All **read** unless marked.

| Thing | Identity | Same in every workspace? |
|---|---|---|
| Built-in property, in the cell | its `name` (`alias`, `system:collapsed`) | yes; frozen by `src/data/seedIdentityLedger.ts` |
| Built-in property, in a field row | definition block id = `uuidv5(workspaceId:seedKey)` (`propertyDefinitionBlockId`, `src/data/definitionSeeds.ts`) | no |
| User-defined property, in the cell | its `name`, mutable | by coincidence of spelling |
| User-defined property, in a field row | a random block id (`addSchema`, `src/data/userSchemasService.ts`) | no |
| Synthesized definition (from a cell key no definition held) | id derived from workspace and key, under a namespace that is key-derived on encrypted workspaces (`src/data/internals/propertyDefinitionSynthesis.ts`) | no |
| Built-in type membership token | a frozen string (`page`), stored on the seeded row as `block-type:type-id` and written verbatim into `types` | yes |
| User-defined type membership token | the definition block's id (`typeMembershipTokenFor`, `src/data/typeDefinitionMetadata.ts`) | no |

- A field row's content is `::((fieldId))` (`propertyFieldContent`, `src/data/propertyChildren.ts`).
  `reference_target_id` and `is_field_form` are local, never synced, and derived from content;
  for the id-carrying forms the derivation is textual, with no lookup
  (`deriveReferenceColumns`, `src/data/internals/referenceTargetProcessor.ts`).
- Recognition is `is_field_form = 1`, a non-null parent, and "the target resolves a definition
  in the registry" (`isPropertyFieldInstance`; SQL twins in `src/data/internals/treeQueries.ts`).
  The first two are facts of the row. The third is a fact of the workspace.
- The grammar already reads `::[[alias]]` as a field form (`parseExactReferenceBlockContent`,
  `src/data/referenceBlock.ts`), resolved through the generic alias lookup. It is dormant: no
  property definition is in the alias index.
- The exact alias lookup is case-sensitive and returns the oldest live claimant
  (`liveAliasLookupSql`, `src/data/internals/kernelQueries.ts`). The registry's rule for a name
  is different: a current seed always wins it, however old a competing user row is
  (`src/data/propertyDefinitionRegistry.ts`, "code-owned seeds are unshadowable").
- A rename of a user-defined property is a write of `property-schema:name`
  (`PropertySchemaBlockRenderer.tsx`), and it re-keys the cell of every consuming block inside
  that transaction (`core.migratePropertyDefinition`,
  `src/data/internals/propertyDefinitionChangeProcessor.ts`). Editing a definition block's
  *content* is not a rename; nothing mirrors content into the name.
- `types` is a `string-list`, deliberately not a reference list, because a built-in token must
  resolve with no backing block (`typesProp`, `src/data/properties.ts`). A tagged block has no
  reference edge to its type.
- A user-authored type block claims its label as a plain alias
  (`src/data/internals/blockTypeTypeifyProcessor.ts`). Seeded definition rows claim none, and
  for type seeds that is a recorded decision: an alias there "risks `alias.collision` on real
  type labels" (`src/data/definitionSeeds.ts`).
- The seed materializer creates and restores rows and never repairs a live one (same file). It
  cannot add anything to the seeded definitions an existing workspace already has.

### Measured (largest live workspace, 2026-11-21)

| | |
|---|---|
| live blocks | 1,139,228 |
| live field rows | 384,706, on 112,960 owner blocks |
| field rows in the canonical `::((uuid))` form | 384,706 (all); name form 0; aliased form 0 |
| tombstoned field rows | 3,514 |
| field rows naming a seeded definition | 217,069 over 196 definitions |
| field rows naming a non-seeded definition | 167,637 over 399 definitions |
| property definitions | 642 (243 seeded, 399 not) |
| type definitions | 76 (71 seeded, 5 not) |
| type memberships | 68,634 over 70 tokens; 1,384 of them under 4 block-id tokens |
| reference edges from a field row to its definition | 384,706 (every field row) |
| existing aliases starting `prop/` or `type/` | 0 of 31,437 |

Of the 399 non-seeded property names: 390 contain a colon (mostly keys written by importers and
extensions, later given synthesized definitions), 160 contain whitespace, 120 an uppercase
letter, 8 a slash, 4 a square bracket, the longest is 71 characters. All three workspaces on that
device are at `properties_migration = 'children'`.

## 3. Why the rows name ids: the argument in the properties-as-blocks design

`docs/properties-as-blocks-migration.html` §7 is the home of this decision. Its banner says the
document is planning prose with dated corrections; the points below were checked against the
code named in §2.

The spike stored `[[Schema Name]]` and resolved it through a schema-name tier ahead of the
generic alias lookup. The implementation went back to ids, and a later decision added the `::`
marker. The document lists what the id form *deleted*:

1. the two-tier lookup, and the obligation that every device resolve a name to the same winner;
2. a deferral of derive-at-arrival until the schema tier was ready;
3. the re-derive and reclaim when a definition arrives after rows that name it;
4. the pass that retitled field rows on rename;
5. name validity as an identity concern.

It also says the reclaim in item 3 would have to be rebuilt together with any scheme in which
definitions answer to a name, and that seeded rows have no path out of their bare state.

Beyond rename stability, then, the id form buys:

- **Textual derivation.** A row's binding is a function of its own text. It is correct before
  any index exists, on sync arrival in any order, on a tombstone, and in a repair pass that
  rebuilds the columns from content.
- **The same answer on every device.** There is no winner to agree on.
- **Usages are already backlinks.** Every field row has a reference edge to its definition, so
  merge retargeting and "what uses this property" run through the ordinary reference machinery.
- **Constant length.** With uuid ids every field row's content is 42 characters, which matters
  on an encrypted workspace (§4.7).

## 4. The seven questions

### 4.1 What a frozen key keeps and gives up, if it were the stored form

| Property of the id form | Under `::[[prop/<key>]]` at rest |
|---|---|
| rename stability | kept, *if* the key is frozen and the label is separate (§4.2) |
| name validity is not identity | given up; recoverable by validating the key at mint |
| usages are backlinks | kept only for rows written while the key resolved. Late binding stamps the local column and writes no reference edge (§4.4) |
| textual derivation | **given up.** Items 1 to 3 of the list in §3 come back, for every field row |
| the same answer on every device | given up; two definitions of one key need a winner, and a row bound to the loser is recognized but left out of the cell (read: shadowed definitions are excluded from the projection) |
| constant length | given up |

What it gains: one spelling that binds in any workspace, a row that reads as a name when its
definition is absent, and duplicate definitions of one key that need no retargeting.

The recommendation takes the first of those gains at the border and keeps every row of the
left-hand column.

### 4.2 Rename: frozen key, mutable label

- **Frozen key, mutable label** (the built-in type model: id `page`, label "Page"). A rename
  writes `property-schema:label` on the definition. No consumer is written, on this device or
  any other.
- **Rename moves the key and keeps the old one as an extra name.** Old exports and offline
  devices still bind through the old name.

The second keeps today's cell re-key on every rename and adds to it: names accumulate, a
released one can never be safely reused, and a workspace that only ever saw the new key cannot
bind an old export. **Pick: frozen key.** Its cost is that key and label drift apart: a property
created as `priority` and relabelled "Urgency" stays `prop/priority` in exports and
`properties.priority` in extension code. That is also a benefit; today a rename breaks every
extension and saved query that reads the old name.

The re-key machinery stays, as an explicit operation ("change the stored key") instead of what
every rename does. It has to rewrite prose `[[prop/old]]` references too, which it can find
through their edges.

### 4.3 Minting, collisions with built-ins, and one key with two codecs

**Minting.** Nothing is minted for an existing definition: the key is the current
`property-schema:name`. No cell changes. A new definition's key is the name typed at creation,
validated exactly as today (`propertySchemaNameRejection` in `userSchemasService.ts`), then
frozen. Synthesized definitions are admitted under a weaker rule that tolerates names the
wikilink grammar cannot spell (padding, `]]`). Those keep working by id and are simply exported
in the id form: the export asks `isRoundTrippableReferenceLabel('prop/' + name)` and falls back
when it says no.

A random short id (`prop/k7f3q9`) instead of the name is rejected in §5.

**Staying clear of built-in keys.** `addSchema` refuses a name a seed declares
(`assertNameAvailable`). A seed that later declares a name a user definition holds takes the
name; the user row stays resolvable by id and its values are read under the seed's codec (read,
`propertyDefinitionRegistry.ts`). For the 390 namespaced names that is the intended adoption of
keys an extension wrote before declaring them. Because `prop/<key>` resolves through that same
registry rule, this design neither fixes nor worsens the case; a stored alias claim would have
worsened it (§5).

**One key, two codecs, across workspaces.** A text paste or markdown import carries rows, not
definitions. The row binds to the destination's definition and its values are read under the
destination's codec. A value that does not decode stays as its authored text in the value row,
unprojected (read: `childContentsToEncodedPropertyValue` and the projection's skip). Nothing is
coerced and no row is dropped. One caveat is not about codecs: a reference-typed value pasted
from another workspace decodes to an id that names no local block, so the bound property holds a
dangling reference, as a pasted `((id))` in prose already does (§7).

Sharing inside one workspace (the shape PR #1790 recommends) has one definition per key, so no
mismatch arises there.

### 4.4 Recognition and derived columns

**Nothing about recognition changes.** `reference_target_id` remains an id read out of the row's
own text, and the SQL child views keep binding `block_types.block_id = reference_target_id`.

The key form is handled at three places, each with one owner:

- **Bind on write.** A kernel same-tx processor ahead of `core.deriveReferenceTarget`: when a
  locally written row's whole content is `::[[prop/<key>]]` and the registry resolves `<key>`,
  it rewrites the content to `::((fieldId))`. It covers paste, import, a structured move, the
  agent bridge and MCP writes, because it sits under all of them. It never runs on sync arrival
  (no same-tx processor does), so what arrives is already in the form the writer stored and
  every device derives the same columns from it.
- **Derive never resolves a reserved name.** A `::[[prop/<key>]]` row that is still in that form
  did not resolve when it was written. It keeps `is_field_form = 1` and a null target, which is
  the existing "unbound field intent" state, and it is never machinery. This is the clause that
  option (b) in §8 would flip.
- **Reserved-name resolution for references.** The exact alias lookup's two entry points
  (`tx.aliasLookup` and the `core.aliasLookup` query) answer a `prop/…` or `type/…` name from
  the registry: the property registry's winner for the name, or the type registry's block for
  the id (`blockIdByTypeId`, `src/data/typeDefinitionRegistry.ts`). So the references plugin
  writes an edge for `[[prop/status]]` in prose with no change of its own.

And one rule: **a reserved name is never seated.** A `[[name]]` miss mints a page seat today
(`ensureAliasTarget`, `src/data/targets.ts`, three callers, plus the Roam importer's twin). For
a reserved name it mints nothing.

What this deliberately does not do:

- **No late binding.** A row or prose link written before its definition exists is not revisited
  when the definition appears. It binds the next time it is written, or when the definition is
  created by `addSchema`, which can bind the unbound rows for its own key in the same
  transaction (a user gesture fanning out in its own tx). The existing late-binding drain would
  be the wrong tool: it stamps the local column and writes no reference edge, so a row bound
  that way is invisible to a later re-key or merge (read, `repo.ts` and
  `referencesProcessor.ts`).
- **No text-only recognition.** A reserved prefix *could* make "this is a property row" a fact
  of the text. It would classify a row whose key no definition holds, with no codec to project
  it, and in the outline's hidden tier it would vanish. Leaving it an ordinary visible block is
  the right behaviour for data nobody can interpret. What the prefix makes textual is intent and
  a label: such a row can be offered a "bind" or "create this property" action later. No such
  affordance exists today; it would be new UI and is not in the build order.
- **No new authority for names.** A stored alias would have been a fifth place answering "who
  holds this name", with a different winner rule from the registry's (§2). Resolving through the
  registry adds none.

A page that already carries an alias under a reserved prefix would stop being reachable by that
alias, since the registry answers first. None exists in the largest graph; count per workspace
before enabling.

### 4.5 Stored form versus border form, sized

**Option two, border form (recommended).**

| Write to synced data | Largest graph |
|---|---|
| field rows, cells, definitions, type memberships | 0 |

There is no migration and no once-per-graph pass. `property-schema:label` is a new seeded
property; it is written the first time a user relabels something. New code: the label and the
rename change; the bind-on-write processor; the reserved-name branch in the alias lookup; the
no-seat rule; the export rewrite in the one clipboard serializer (`serializeBlock`,
`src/utils/copy.ts`).

**Option one, key form as the stored form.**

| | Largest graph |
|---|---|
| live field rows rewritten and uploaded | 384,706 |
| second synced column per row | 384,706: the row's `references` entry changes with its content (reasoned) |
| tombstoned field rows | 3,514, left in the id form, which stays valid |
| rows every other device downloads and re-derives | the same 384,706 |
| value rows, cells | 0 |

For scale, the cell-to-children pass created about twice that many rows in this graph. I would
expect tens of minutes of upload; not measured.

It is a **data migration**: it rewrites source-of-truth rows and uploads them. So: once per
graph, operator-triggered on one caught-up device, recorded by the synced claim block, the
workspace undo stack cleared with a notice, and the safety check inside each writing
transaction.

- *Before it can run at all.* Derive must resolve reserved names (the clause above, flipped),
  on arrival as well as locally, which brings back the wait for the registry to be ready.
  Late binding must write the reference edge, and re-point rows when a key's winner changes.
  Field-row content needs padding on encrypted workspaces (§4.7).
- *Precondition per definition.* It is the registry's winner for its name, and the name
  round-trips the wikilink grammar. A definition that fails either is skipped whole; its rows
  stay in the id form.
- *Per row.* Re-read the row inside the transaction and require its content to be exactly the
  canonical id form. Then **check before writing** that the key resolves, in this transaction,
  to this row's own definition. A check after the write is worthless: the derive runs after the
  migration's function returns, and if the new text did not resolve, the derive clears the
  target and the projection deletes that key from the owner's cell, which uploads (read: the
  processor order and the projection's `full` mode). Value rows survive that; the cell entry
  does not. The pinning test is the one where the pre-check is deleted and a cell key
  disappears.
- *Not touched.* Value rows, so no stored value can be dropped, mangled or re-typed.
  Tombstones. `user_updated_at`.
- *Recovery.* Write the key → definition-id map (about 650 entries) into the claim block before
  the first row, so the inverse does not depend on what the names resolve to later. The inverse
  is a second full upload of the same rows. Compare `pnpm agent audit-properties` coverage
  before and after; cells and field rows must agree both times. A local mirror helps diagnose
  but does not undo uploaded rows.
- *Unconfirmed hazard.* Name resolution reads each definition's cell. A device whose definition
  cell lags its child rows could leave that definition's field rows unbound for a while, and a
  property write in that window would mint a second field row. Not traced to the end.

What option one buys over option two: a guest without the definition reads `status` instead of
an id, and no export path can forget to translate (there is one clipboard serializer today; I
did not enumerate other exports).

### 4.6 User-defined types

A user-defined type's token is its block id, and that is what makes it impossible for a later
built-in or plugin type to capture the user's members. With a readable token `person`, a plugin
shipping a type with id `person` would silently adopt every block the user tagged. For
properties the equivalent adoption exists and is usually wanted (§4.3); for types it would be
new, and wrong. Tokens are also stored outside membership (a `ref` property's `targetTypes`
config), so a token migration has an open-ended audit.

So tokens stay as they are, and the only type change here is the reserved name: `[[type/page]]`
resolves to the seeded definition through the type registry, with nothing stored. For a
user-defined type the registry's id is the block id, so the reserved spelling is no more
readable than a block reference; its readable name is its label, `[[Person]]`, as today.

Carrying a user-defined type's membership across workspaces needs a portable key for the type
and a token map at the border. It is deferred: 5 such types and 1,384 memberships in the largest
graph, and a pasted block arrives with an inert token, as it does today. If it is built, the
border spelling must not be a string a type seed could later declare as its id.

### 4.7 Encrypted workspaces

Sealed columns are `content`, `properties_json` and `references_json` (`SEALED_COLUMNS`,
`src/sync/transform.ts`); ids and tree shape are not. The envelope is AES-GCM over the UTF-8
plaintext with no padding (`src/sync/crypto/aead.ts`), so ciphertext length follows plaintext
length.

Under the recommendation:

- Nothing is stored or synced for the reserved names. They are answered from local registries.
- No id is derived from a key. User-created definitions keep random ids, and no seat is minted
  for a reserved name.
- The label lives in the definition row's sealed columns.
- Bound field rows keep their constant-length content. Only rows that did not resolve carry
  key-length content.

Nothing name-derived reaches the server in clear. To be pinned by a test in step 3: on an
encrypted workspace, a key-form paste uploads envelopes only.

**The stored key form leaks by length.** Today the server can tell a field row from prose but
not which property it is. With `::[[prop/<key>]]` at rest, a field row's ciphertext length is
the key's length plus a constant, in `content` and (reasoned) in `references_json` too.
Built-in keys are public, so length
sorts each block's field rows into small sets of candidate properties, for the whole workspace.

## 5. Rejected alternatives

| Alternative | Why not |
|---|---|
| Key form as the stored form, now | §4.5, §4.7. Deferred, not foreclosed; it is fork 1 |
| Definitions store `prop/<key>` in their alias list (my first draft) | The materializer cannot write existing seeded rows. A seed whose key a user row already claims would abort its whole creation batch on the uniqueness trigger. Two same-key definitions arriving by sync would each refuse every later property write. The alias winner (oldest) differs from the registry winner (the seed). The alias plugin starts syncing content into any block that has an alias, and the first alias is used as a display name. All read |
| Derive the alias in the index trigger from the row's own name | Fixes the storage problems, keeps the winner disagreement |
| Rename keeps the old key as an extra name | §4.2 |
| Random short keys for user properties | Unreadable where the key is meant to be read; two workspaces that each made `priority` stop matching; and the cell must either be re-keyed (about 168k entries) or keep the name as a third identity. Its one advantage, never meeting a built-in, is an adoption that is usually wanted |
| An id-carrying key, `::((prop/status))` | Parses and derives textually, but the target is then not a block; every consumer that joins `reference_target_id` to `blocks` or `block_types` needs a key branch |
| Export `::[status](((fieldId)))` and bind by label on paste | Works for portability alone with no reserved names at all. Loses prose references, hand-written rows, and a readable row when the key is absent. Once the registry answers reserved names it saves little; it is the fallback if that branch proves awkward |
| Late-bind key-form rows when a definition appears | §4.4: no reference edge, and device-dependent recognition |
| Text-only recognition by prefix | §4.4 |
| Readable tokens for user-defined types | §4.6 |
| Drop the type's label alias in favour of `type/<key>` | §1 |
| Property definitions claim the bare name `[[status]]` | The open question in #1407. Bare property names are exactly the words pages are called; a reserved name needs no collision policy |
| Derived ids for user-created definitions, so concurrent creation converges | A separate problem (duplicates), unsized, with its own obligations on encrypted workspaces. Not needed for portability |

## 6. Build order, with the verification each step needs

Each step ships alone. None writes a stored field row, a cell, or a definition that exists.

1. **Frozen name, mutable label.** The `property-schema:label` seed (a new ledger line); the
   rename gesture writes it; the registry and schema expose `label`; the re-key stays reachable
   as its own operation.
   *Verify:* after a relabel, no block other than the definition and its own property rows was
   written, and consuming cells keep their key. The existing rename suites, including
   `propertyDefinitionRename.fuzz.test.ts`, pass against the explicit re-key.
   *Break to name in the PR:* `schema.name` stops being the display label once a property is
   relabelled; an extension rendering it shows the key. Nothing throws.

2. **Reserved names.** The registry branch at the two alias-lookup entry points; no seat in
   `ensureAliasTarget` and the importer's twin; derive returns no target for a reserved name.
   *Verify, with the real references plugin:* `[[prop/status]]` in prose yields an edge to the
   definition the registry names, including when an older user row holds the same name as a
   seed. `[[prop/nope]]` and `::[[prop/nope]]` mint no block. A `::[[prop/status]]` row written
   with the bind processor absent keeps a null target and is listed as an ordinary child.

3. **Bind on write.** The same-tx processor.
   *Verify:* writing `::[[prop/status]]` through `repo.tx`, through a paste, and through the
   agent bridge each stores `::((fieldId))` and projects the value into the cell (assert the
   value). An unresolved key is stored as written with its value rows intact, and creates no
   definition. A row applied as a sync arrival is not rewritten. On an encrypted workspace the
   upload contains envelopes only.

4. **Export.** The span rewrite in `serializeBlock`, guarded by "this row's definition is the
   registry winner for its name" and the round-trip predicate.
   *Verify, two workspaces in one test database:* copy a block carrying a built-in property, a
   user property defined in both, and one defined only in the source. Assert the destination
   cell values for the first two; the third is a visible unbound row with its values. A
   same-workspace round trip leaves only id-form rows. A value that does not decode under the
   destination's codec stays as text.

5. **Optional: `addSchema` binds the unbound rows for its key** in its own transaction.

6. **Deferred, on a decision:** the stored-form migration (§4.5), and portable user-defined
   types (§4.6).

## 7. What this does not solve

- **A share guest without a user-defined definition still sees an unnamed row.** Under region
  sharing the rows are the owner's, at rest, in the id form. The sharing design's definition
  stand-ins remain the answer; a stand-in can be matched to its original by key. The stored key
  form would give a readable name with no stand-in, though not a codec.
- **Moving a page to another workspace** still has to move or map definitions, type tokens,
  media, and every id the app re-derives. Re-pointing property rows becomes a lookup by key; the
  rest of that list is unchanged.
- **References inside values.** A reference-typed value, like any `((id))`, names a block of
  the source workspace. Rendering those as names on the way out is the general half of "copy
  resolves references" and is not part of this.
- **A definition that appears after its rows** by sync or by installing an extension. Those rows
  stay unbound until written again; step 5 covers only definitions created by hand.
- **Duplicate definitions of one key** created on two offline devices. Unchanged.

## 8. Decisions for Vlad

**Fork 1: where the key form lives.**

- *(a) Border only (my pick).* A page with `status` and `priority` is stored exactly as today,
  two rows `::((…))`. Copy it and the clipboard says `::[[prop/status]]`,
  `::[[prop/priority]]`. Paste it into a workspace that has both and the rows are stored as that
  workspace's `::((…))`. Paste it where `priority` does not exist and you get an ordinary
  visible block reading `::[[prop/priority]]` with its value under it. Cost: no stored data
  changes; four small pieces of code.
- *(b) Stored everywhere.* The same page is stored as `::[[prop/status]]`. A guest lacking the
  definition reads `status` with no stand-in, and export is the stored text. Cost: a rewrite of
  384,706 rows in the largest graph, uploaded twice over (content and references); every field
  row bound through the registry from then on, with late binding and winner changes to build;
  and on an encrypted workspace the server can sort field rows by property-name length.

I would take (a), and revisit (b) only if guests seeing unnamed rows still matters once
stand-ins exist. Everything in (a) is needed by (b).

**Fork 2: what a rename does.**

- *(a) It edits the label (my pick).* You create `priority` and later rename it "Urgency". The
  UI says Urgency. The key is still `priority`: `[[prop/priority]]` in prose and in old exports
  still resolves, extension code reading `properties.priority` still works, and no other block
  was written. To actually change the stored key you run a separate, explicit operation.
- *(b) It re-keys, as today.* After the rename the key is `urgency`. Every consuming cell is
  rewritten in the rename's transaction (as now), `[[prop/priority]]` in prose is rewritten
  where this device can see it, and an export made last week no longer binds; its rows arrive as
  unbound `::[[prop/priority]]`. Key and label never differ.

I would take (a). A key that moves when relabelled is not a portable key, and (b) is the reason
exports and other workspaces could not rely on it.

**Calls I made that are not forks, but are worth an objection if you have one:**

1. *Bind-on-write rewrites what was written.* An earlier ruling says a pasted `::[[name]]` is
   never rewritten. That protected follow-the-name semantics; a frozen reserved key has none,
   the two spellings mean the same thing, and without the rewrite every same-workspace copy and
   paste would deposit key-form rows and drift into option (b) undecided.
2. *A user-defined type keeps its plain label alias*, and `type/…` is additional (§1).
3. *No late binding* (§4.4). The cost is a row that stays unbound until touched; the alternative
   is recognition that differs by device.
