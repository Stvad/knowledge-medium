# Portable property and type keys

> **Status:** proposal, nothing built. Decisions in §9 are open.
> **Last verified against code:** 2026-11-21, master `fd7abbb9a51`. Row counts measured the
> same day on the largest live workspace through the agent bridge's read verbs.

Tracking issue: #1795. Independent of the sharing design (PR #1790), which is where the
question came from.

Every claim below is marked by how it was established: **read** (in the code or a document,
this session), **measured** (a read-only query against a live client), or **reasoned** (inferred,
not run). Nothing here was prototyped.

## 1. Recommendation

The question was whether a property, and a user-defined type, should be identified in stored
content by a frozen workspace-independent key (`::[[prop/<key>]]`, a `type/<key>` token) instead
of by its definition block's id.

**Do the key, do not change the stored form.** Concretely:

1. **A property already has the portable key: its name.** `properties_json` is keyed by it, and
   for built-ins the seed ledger already freezes it. What is not portable is only the *pointer*
   in the field row. So the key is not a new identity to mint; it is the existing name, made
   frozen for user-defined properties too, with a separate mutable display label. A rename then
   writes one row instead of re-keying every consumer.
2. **Every definition claims a reserved alias**, `prop/<key>` or `type/<key>`. That makes
   `[[prop/status]]` and `[[type/page]]` real references, makes `::[[prop/status]]` a field row
   that binds in any workspace holding that key, and does it in a namespace that cannot collide
   with a page name.
3. **Field rows stay `::((fieldId))` at rest.** The key form is what leaves the workspace
   (copy, markdown export, a cross-workspace move) and what arrives; a row that arrives and
   resolves is written in the id form, a row that does not resolve stays in the key form,
   readable and unbound.
4. **User-defined type membership tokens stay block ids at rest**, with the same border
   translation. Here the id form is not just cheaper, it is safer (§4.6).

Rewriting every stored field row to the key form (about 385k rows in the largest graph) is
**not** recommended now. It buys two things the border form does not: a readable row for a share
guest who lacks the definition, and no translators to forget. It costs the property the id form
was chosen for, textual derivation, on the hottest path of the data layer, plus a per-row
metadata leak on encrypted workspaces (§4.7). Steps 1–2 above are prerequisites of that migration
anyway, so the decision can be reopened later with nothing wasted; §4.5 sizes it and gives its
recovery path.

Where the original framing overreached, in my reading:

- "One identity for the cell and the rows" does not follow from a key form. The cell is keyed by
  name today and the row by id; freezing the name removes the *reconciliation* between them
  (nothing ever has to be re-keyed), which is the actual cost. Changing the row's spelling adds
  nothing to that.
- "Merging duplicate definitions rewrites no usages" is true of a key form, but the cheaper way
  to not have duplicates is to give user-created definitions a derived id (§7 step 6), which the
  synthesized definitions already have.
- "Stop a type's label competing with a page name" I would not do. A type block *is* its page;
  `[[Person]]` resolving to the type is the model, not an accident. The reserved alias is added
  beside the label, not instead of it.

## 2. What exists today

All **read** unless marked.

| Thing | Identity | Same in every workspace? |
|---|---|---|
| Built-in property, in the cell | its `name` (`alias`, `system:collapsed`) | yes; frozen by `src/data/seedIdentityLedger.ts` |
| Built-in property, in a field row | definition block id = `uuidv5(workspaceId:seedKey)` (`propertyDefinitionBlockId`, `src/data/definitionSeeds.ts`) | no |
| User-defined property, in the cell | its `name`, mutable | by coincidence of spelling |
| User-defined property, in a field row | a random block id (`addSchema`, `src/data/userSchemasService.ts`) | no |
| Synthesized definition (from a cell key no definition held) | id derived from workspace and key, under a namespace that is key-derived on encrypted workspaces (`src/data/internals/propertyDefinitionSynthesis.ts`) | no |
| Built-in type membership token | a frozen string (`page`), written verbatim into `types` | yes |
| User-defined type membership token | the definition block's id (`typeMembershipTokenFor`, `src/data/typeDefinitionMetadata.ts`) | no |

- A field row's content is `::((fieldId))` (`propertyFieldContent`, `src/data/propertyChildren.ts`).
  `reference_target_id` and `is_field_form` are local, never synced, and derived from content;
  for the id-carrying forms the derivation is textual, with no lookup
  (`deriveReferenceColumns`, `src/data/internals/referenceTargetProcessor.ts`).
- Recognition is `is_field_form = 1` and a non-null parent and "the target resolves a
  definition in the registry" (`isPropertyFieldInstance`; SQL twins in
  `src/data/internals/treeQueries.ts`). The first two are facts of the row; the third is a fact
  of the workspace.
- The grammar already accepts `::[[alias]]` as a field form (`parseReferenceSpan`,
  `src/data/referenceBlock.ts`), resolved through the generic alias lookup with late binding
  when the alias is claimed later (`src/data/internals/aliasClaimRederiveProcessor.ts`). It is
  dormant: no property definition claims an alias. The open question on what a definition should
  claim is #1407.
- A rename of a user-defined property re-keys the cell of every consuming block inside the
  renaming transaction (`core.migratePropertyDefinition`,
  `src/data/internals/propertyDefinitionChangeProcessor.ts`). Its header lists the residuals: a
  device offline across the rename is one.
- `types` is a `string-list`, deliberately not a reference list, because a built-in token must
  resolve with no backing block (`typesProp`, `src/data/properties.ts`). So a user-defined type's
  membership is stored as the text of a uuid, and a tagged block has no reference edge to its
  type (`src/data/internals/mergeTypeMembershipProcessor.ts`).
- A user-authored type block claims its label as a plain alias
  (`src/data/internals/blockTypeTypeifyProcessor.ts`). Seeded type and property definition rows
  claim none.

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

Of the 399 non-seeded property names: 390 contain a colon (they are mostly keys written by
importers and extensions, later given synthesized definitions), 160 contain whitespace, 120 an
uppercase letter, 8 a slash, 4 a square bracket, 1 a parenthesis, the longest is 71 characters,
and 7 collide with another name when case is ignored. All three workspaces on that device are at
`properties_migration = 'children'`.

## 3. Why the rows name ids: the argument in the properties-as-blocks design

`docs/properties-as-blocks-migration.html` §7 is the home of this decision (its banner says the
document is planning prose with dated corrections; the points below were each checked against
the code named in §2).

The history is the relevant part. The spike stored `[[Schema Name]]` and resolved it through a
schema-name tier ahead of the generic alias lookup. The implementation went back to ids, and a
later decision added the `::` marker. The document lists what the id form *deleted*:

1. the two-tier lookup and the obligation that every device resolve a name to the same winner;
2. a deferral of derive-at-arrival until the schema tier was ready;
3. the re-derive and reclaim when a definition arrives after rows that name it;
4. the pass that retitled field rows on rename, and the lock-step between content and name;
5. name validity as an identity concern ("names are hygiene now, not identity").

And it records what the id form defers: readable markdown and cross-workspace transfer, to a
named follow-up pair, "copy resolves references" on the way out and definitions claiming their
name on the way in. Neither was built.

Beyond rename stability, then, the id form buys:

- **Textual derivation.** A row's binding is a function of its own text. It is correct before
  any index exists, on sync arrival in any order, on a tombstone, and in a repair pass that
  rebuilds the columns from content. Read: the comment on `isIdCarryingReference`.
- **Identity that cannot be ambiguous.** Two definitions with one name is a registry problem
  (which one answers to the name); the rows of each still bind to their own definition, and a
  shadowed definition keeps classifying its rows.
- **Usages are already backlinks.** Measured above: every field row has a reference edge to its
  definition, so merge retargeting and "what uses this property" work through the ordinary
  reference machinery.
- **Constant length.** Every field row's content is 42 characters. On an encrypted workspace
  that matters (§4.7).
- **Ids that are not uuids.** The whole-block `((…))` grammar accepts caller-supplied ids.

## 4. The seven questions

### 4.1 What a frozen key keeps and gives up

| Property of the id form | Under a frozen key in the stored form |
|---|---|
| rename stability | kept, *if* the key is frozen and the label is separate (§4.2) |
| name validity is not identity | given up in principle, recovered by controlling the key grammar at mint |
| usages are backlinks | kept; an alias reference produces the same edge |
| textual derivation | **given up.** `::[[prop/k]]` binds through the alias index, a fact about the workspace. Items 2 and 3 of the list in §3 come back, for every field row |
| unambiguous under duplicates | given up; softened because a shadowed definition still classifies its rows and both definitions share the cell key |
| constant length | given up |

What it gains is real: one spelling that binds in any workspace, a row that reads as a name
when the definition is absent, and duplicate definitions of one key that need no retargeting.

### 4.2 Rename: frozen key, mutable label

Two candidates:

- **Frozen key, mutable label** (the built-in type model: id `page`, label "Page"). A rename
  edits the label on the definition row and nothing else.
- **Rename moves the key and keeps the old one as an extra alias.** Old exports and offline
  devices still bind through the old alias.

The second keeps today's cell re-key on every rename and adds to it: keys accumulate, a released
key can never be safely reused, and a workspace that only ever saw the new key cannot bind an
old export. The first has no usage to rewrite anywhere, including on devices and in workspaces
the renamer cannot see, because nothing that is stored mentions the label.

**Pick: frozen key, mutable label.** Its cost is that key and label drift apart: a property
created as `priority` and relabelled "Urgency" is `prop/priority` in exports and
`properties.priority` in extension code forever. That is also a benefit: today a rename breaks
every extension and saved query that reads the old name.

The existing re-key machinery does not go away. It becomes an explicit, rare operation
("change the stored key"), which is also the way out of a collision with a later built-in (§4.3).

### 4.3 Minting, collisions with built-ins, and one key with two codecs

**Minting.** For existing definitions there is nothing to mint: the key is the current
`property-schema:name`, which is already what the cell is keyed by. No cell changes. For a new
definition the key is the name the user types at creation, validated as names are today
(`assertWritableLabel`, `src/data/referenceBlock.ts`), then frozen. The measured names (spaces,
capitals, colons) are all legal inside `[[prop/…]]`; the 4 with a square bracket need checking
against the wikilink round trip and, if they fail it, simply do not claim an alias: they keep
working by id and are not portable until re-keyed.

The alternative, a random short id (`prop/k7f3q9`), is the fork in §9.

**Staying clear of built-in keys.** Present built-ins: refused at mint, as `addSchema` already
refuses a name a seed declares (read: `assertNameAvailable`). Future built-ins: this is today's
problem with today's rule, and a frozen key neither fixes nor worsens it. A seed that later
declares a name a user definition holds takes the name, and the user's row is shadowed (from the
definition-identity notes dated 2026-08-21; not re-read this session). Two things make that
tolerable. Most non-seeded names are namespaced keys an extension wrote without declaring them
(390 of 399 measured), where a later seed adopting the stored values is the intended outcome.
And for a genuine clash the explicit re-key moves the user's property out of the way with its
values. I would add one cheap guard: the ledger test refuses a *new* un-namespaced seed name
(no `owner:` prefix) unless it is added to a short allow-list, so a release cannot take a plain
word like `priority` without someone deciding to.

**One key, two codecs, across workspaces.** This can only happen at a boundary, and every
boundary is a gesture with a user present:

- *Text paste or markdown import* carries rows, not definitions. The row binds to the
  destination's definition of that key and its values are read under the destination's codec. A
  value that does not decode stays as its authored text in the value row, visible and unprojected
  (the existing rule for an undecodable child, read in the properties-as-blocks notes; a child is
  authored truth). Nothing is coerced, nothing is dropped.
- *A structured move or copy* carries the definition. Same key and same preset: bind. Same key,
  different preset: refuse the gesture and name both definitions. Absent key: copy the
  definition in.

Sharing inside one workspace (the recommended shape in PR #1790) has no second definition, so
the mismatch cannot arise there.

### 4.4 Recognition and derived columns

Under the recommendation nothing about recognition changes: `reference_target_id` is still the
definition's block id, whichever form produced it, and the SQL child views keep binding
`block_types.block_id = reference_target_id`.

For a key-form row the target derives through the alias lookup. That path exists and late-binds
on claim. Two additions are needed:

- **No seat for a reserved alias.** Today a `[[name]]` miss mints a page seat (read:
  §7 of the properties-as-blocks design). A pasted `::[[prop/unknown]]` would mint a page called
  `prop/unknown` that then squats the alias the definition needs. Aliases under the reserved
  prefixes are lookup-only: nothing but a definition may hold one, so there is nothing to seat.
  An earlier seat suppression keyed on the *marked form* was reverted because the seat was the
  binding mechanism for a miss; this one is keyed on the alias, and the bind happens on the
  definition's claim through the existing late-binding (reasoned from the processor's header,
  not tested).
- **The reserved prefixes are claimable only by definitions.** `prop/<k>` only by a
  `property-schema` block whose name is `k`, `type/<k>` only by a type definition whose key is
  `k`. Local writes can enforce this; a sync arrival cannot be refused, which is why the registry,
  not the alias, stays the authority for "is this a definition".

**Can the prefix make "this is a property row" a fact of the text alone?** It can, and I would
not. Text-only recognition classifies a row whose key no definition holds: a typo or a foreign
key would be treated as machinery with no codec to project it, and in the outline's hidden tier
it would vanish. Today such a row is an inert, visible, field-looking row with a "create
property?" affordance, which is the right behaviour for data nobody can interpret. What the
prefix does make textual is *intent and label*: an unbound `::[[prop/status]]` can say
"status, not defined here" and prefill the affordance. No third derived column is needed.

One risk is new and worth naming. The alias index would become a fifth place that answers "who
holds this name", beside the four the definition layer already reconciles (resolver, registry
name index, `blocks`, seed declarations). The mitigation is that the claim is not independent
state: it is a pure function of the definition row's own name, written by one owner, and pinned
by a consistency check (the alias winner for `prop/<name>` is the registry winner for `name`,
for every definition). Resolving the reserved prefixes virtually through the registry, with no
stored alias, removes the fifth authority but takes the definitions out of everything that reads
the alias index (link autocomplete, navigation, backlinks); see §6.

### 4.5 Stored form versus border form, sized

**Option two, border form (recommended).** Field rows rewritten: 0.

| Write | Largest graph | Kind |
|---|---|---|
| alias claim on non-seeded property definitions | 399 rows | data migration, once per graph |
| alias claim on seeded definitions | 243 properties + 71 types, per workspace | the seed materializer, deterministic content at deterministic ids |
| key and alias on user-defined types | 5 rows | same data migration |
| field rows, cells, type memberships | 0 | — |

On a child-backed workspace each alias claim is also a field row and a value row under the
definition, so the totals are roughly three times the row counts above: about two thousand rows.
New code: the label property and the rename change; the claim processor; the reserved-prefix
rules; the export span rewrite; the paste-side bind; the type token map.

**Option one, key form as the stored form.** Everything in option two, then:

| | Largest graph |
|---|---|
| live field rows rewritten and uploaded | 384,706 |
| tombstoned field rows | 3,514, left in the id form (it stays valid) |
| rows every other device downloads and re-derives | the same 384,706 |
| value rows, cells | 0 |

For scale, the cell-to-children pass created about twice that many rows in this graph. The
rewrite is content updates rather than creates; I would expect tens of minutes of upload, not
measured.

It is a **data migration**: it rewrites source-of-truth rows and uploads them. So, per the
repository's rules for one: once per graph, operator-triggered on one caught-up device, recorded
by the synced claim block, the workspace undo stack cleared with a notice, and the safety check
inside each writing transaction.

- *Precondition.* Every targeted definition claims its key, and an audit shows key and
  definition are one-to-one: no contested name, none of the case-insensitive collisions (7
  measured; the alias uniqueness trigger compares exact case, and I did not verify the case rule
  of the exact lookup), no name that fails the wikilink round trip. A definition that fails the
  audit is skipped whole and its rows stay in the id form.
- *Per row, inside the transaction.* Re-read the row. Require content to be exactly the
  canonical id form. Write the key form. Require the derived `reference_target_id` to be
  unchanged, and refuse the transaction if it is not. This last check is the one that matters:
  a field row that stops binding inside the transaction stops being a field row, and the
  projection would then remove its key from the owner's cell.
- *Not touched.* Value rows, so no stored value can be dropped, mangled or re-typed by this
  pass. Tombstones. `user_updated_at`.
- *Recovery.* The rewrite is reversible by construction: the inverse pass resolves each key to
  its definition and writes the id back. Before the run, take the local mirror with a
  `quick_check`, as the flip run did. Run it while the cell is still synced, and compare
  `pnpm agent audit-properties` coverage before and after: cells and field rows must agree both
  times. A stale device is harmless in one direction (an id-form row it writes later is still
  valid), which also means the two forms coexist indefinitely; "one form everywhere" is not
  actually reachable without a guard on every writer.

What option one buys over option two: a guest without the definition sees `status` instead of
an id, and no boundary can forget to translate. What it costs, beyond the run: derivation of
every field row through the alias index (on write, on arrival, in every column rebuild, which
must now order itself after the alias index), the per-row length leak in §4.7, and the loss of
the "correct from text alone" property that several repair paths lean on.

### 4.6 User-defined types

The same border answer, with more conviction. A user-defined type's token is its block id, and
that id is what makes it impossible for a later built-in or plugin type to capture the user's
members. If a user type's token were the readable key `person` and a plugin later shipped a type
with id `person`, every block the user tagged would silently become the plugin's type. For
properties the equivalent capture already exists and is usually wanted (§4.3); for types it
would be new, and wrong. Tokens are also stored in more places than membership (a `ref`
property's `targetTypes` config, saved queries), so a token migration has an unbounded audit.

So: tokens stay as they are. A type definition gets a frozen key (`block-type:key`; the seeded
`id` for built-ins, the label at creation for user types) and claims `type/<key>`. At a border a
block-id token is written as `type/<key>` and mapped back to the destination's token on the way
in; a token that maps to nothing is kept verbatim in the list, inert and re-mappable, never
dropped. 1,384 memberships in the largest graph are unaffected.

### 4.7 Encrypted workspaces

Sealed columns are `content`, `properties_json` and `references_json` (read: `SEALED_COLUMNS`,
`src/sync/transform.ts`); ids and tree shape are not.

- **The key and the alias.** Both live in a definition row's properties and, on a child-backed
  workspace, in its property rows' content. All sealed. The alias index is local.
- **Ids.** Nothing in the recommendation derives an id from a key. User-created definitions keep
  random ids. If step 6 is taken (derived ids so concurrent creation converges), the namespace
  must be the key-derived one (`deriveWorkspaceIdNamespace`, as synthesis uses), never a public
  constant, and it must refuse rather than fall back when the key material is missing.
- **Seats.** No seat is minted for a reserved alias (§4.4), so no id is derived from a key by
  that route either.
- **Type tokens.** In the sealed cell and sealed value rows; no server column carries a type.

Nothing name-derived reaches the server in clear under the recommendation. Confirmed by reading
the upload path's sealed-column list; to be pinned by a test in step 3.

**The stored key form does leak, by length.** The envelope does not pad (from the encryption
notes dated 2026-10-22 and the conversion design's list of visible metadata; not re-read this
session), so ciphertext length follows plaintext length. Today every field row's content is the
same 42 characters: the server can tell a field row from prose, but not which property. With
`::[[prop/<key>]]` at rest, a field row's length is the key's length plus a constant. Built-in
keys are public, so length sorts each block's field rows into a small set of candidate
properties, per row, for the whole workspace. That is a regression the id form does not have,
and one more reason not to take option one for encrypted workspaces without padding field-row
content. Under the border form only the unbound minority of rows have key-length content.

## 5. The recommended design, in one place

- **Key.** A property's key is its stored name, immutable after creation. A type's key is its
  seeded id, or for a user type the label at creation, stored in `block-type:key`.
- **Label.** `property-schema:label`, optional; absent means the label is the name. The rename
  gesture writes it. Types already separate label from token.
- **Claim.** A definition's alias list contains `prop/<key>` or `type/<key>`. One same-tx owner
  ensures it for user and synthesized definitions (the shape of the type label-claim in
  `blockTypeTypeifyProcessor.ts`); the seed materializer writes it for seeded rows. A user type
  keeps its label alias as well.
- **Reserved prefixes.** Claimable only by the matching definition; never seated; refused as a
  page name or user alias elsewhere.
- **Stored form.** Writers keep minting `::((fieldId))`. A key-form row at rest means "arrived
  and did not resolve" or "typed by hand", and binds when its key is claimed.
- **Out.** Copy and markdown export render a field row's span as `::[[prop/<key>]]`, keeping the
  marker, and a block-id type token as `type/<key>`. A definition with no claim exports as it
  does today.
- **In.** A pasted `::[[prop/<key>]]` whose key resolves is written as `::((localFieldId))`.
  One that does not resolve is stored as pasted. No definition is ever created by a paste.

Three calls I made that are not forks but are worth an objection if you have one:

1. *Writing the id form on paste when the key resolves* narrows an earlier ruling that a pasted
   `::[[name]]` is never rewritten. That ruling protected follow-the-name semantics; a frozen
   key has none, the two spellings mean the same thing, and the paste is already a write of that
   row. It keeps one stored form for bound rows. Dropping it costs no correctness, only mixed
   forms at rest.
2. *A type keeps its plain label alias.* See §1.
3. *This breaks an extension-visible meaning.* `schema.name` stops being the display label once
   a property is relabelled; an extension that renders it shows the key. Nothing throws. The
   schema object gains `label`.

## 6. Rejected alternatives

- **Key form as the stored form, now.** §4.5 and §4.7. Deferred, not foreclosed; revisit when
  region sharing has guests looking at unnamed rows, or if border translators are missed in
  practice.
- **Rename keeps the old key as an alias.** §4.2.
- **Random short keys for user properties.** §9, fork 2.
- **Resolve `prop/…` virtually through the registry, with no stored alias.** One fewer name
  authority, but the definitions then exist for field rows only: not for link autocomplete, not
  for navigation, not for backlinks, each of which reads the alias index and would need a second
  path. It is also the schema-name tier the id form deleted, brought back. Keep as the fallback
  if the consistency check in §4.4 proves expensive to hold.
- **An id-carrying key, `::((prop/status))`.** The whole-block grammar would parse it and derive
  it textually. But the target is then not a block: every consumer of `reference_target_id`
  that joins it to `blocks` or `block_types`, and the reference edge itself, would need a key
  branch. It moves the lookup rather than removing it.
- **One spelling for both, `::[prop/status](((fieldId)))`.** The aliased form carries the id and
  a label that could spell the key: exact at home, portable abroad. But a derive that falls back
  from an unresolved id to the label is no longer textual, and the label is author-owned text
  that nothing keeps equal to the key.
- **Text-only recognition by prefix.** §4.4.
- **Make user type tokens keys.** §4.6.
- **Drop the type's label alias in favour of `type/<key>`.** §1.
- **Claim the bare name (`[[status]]`) for property definitions.** The open question in #1407.
  A reserved prefix answers it without a collision policy: measured, no existing alias uses
  either prefix, where bare property names like `status` or `type` are exactly the words pages
  are called.

## 7. Build order, with the verification each step needs

Each step ships alone and leaves the system consistent. None touches a stored field row.

1. **Reserved prefixes.** Constants for the two prefixes; the alias-claim check refuses them for
   non-definitions; the references pass seats none.
   *Verify:* the real references plugin, with `[[prop/nope]]` in prose and `::[[prop/nope]]` as a
   row: no seat is minted, and both bind when a definition later claims the key (assert the
   stamped target id, not a count). Delete each new clause in turn and name the test that fails.
   Before enabling on a workspace, count existing aliases under either prefix (0 measured in the
   largest graph); a non-zero count is reported, not rewritten.

2. **Frozen key, mutable label, for properties.** The `property-schema:label` seed (a new ledger
   line); the rename gesture writes the label; the registry and schema expose `label`; the
   re-key stays reachable as its own operation.
   *Verify:* a relabel writes exactly one row and the consuming cells keep their key (assert on
   the tx's written rows). The existing rename suites, including
   `propertyDefinitionRename.fuzz.test.ts`, keep passing against the explicit re-key. Name the
   `schema.name` break in the PR.

3. **Definitions claim their key.** The same-tx claim for user and synthesized definitions; the
   seed materializer for seeded rows; one operator-triggered, once-per-graph pass for the
   definitions that already exist (399 in the largest graph).
   *Recovery for that pass:* it only adds an alias entry; reversing it is removing the entry. It
   skips and reports any definition whose name is contested, collides ignoring case, or fails
   the wikilink round trip. It clears the undo stack and says so.
   *Verify:* set up pre-existing definitions with a raw write, so no processor has already
   claimed for them. A consistency test: for every definition, the alias winner for
   `prop/<name>` is the registry's winner for `name`, under duplicates and under a seed that
   shadows a user row. On an encrypted workspace, assert the uploaded envelopes for definition
   rows contain no clear key and that no id was derived from one. `pnpm check:db` is not needed;
   nothing server-side changes.

4. **Out and in.** The export span rewrite and the paste-side bind.
   *Verify:* with two workspaces in one test database and the real plugins, copy a block with a
   built-in property, a user property present in both, and a user property present only in the
   source. Assert the destination cell *values* for the first two, that the third is a visible
   unbound row with its value rows intact, and that no definition was created. A same-workspace
   round trip leaves only id-form rows. A value that does not decode under the destination's
   codec stays as text.

5. **Types.** `block-type:key`, the `type/<key>` claim, and the token map at the border.
   *Verify:* as step 4, for a built-in type, a user type in both workspaces, and one only in the
   source; the unmapped token is still in the list afterwards.

6. **Optional: derived ids for user-created definitions**, so two devices creating one key
   offline produce one row. Needs the frozen key from step 2.
   *Verify:* a two-client test. On an encrypted workspace the namespace is the key-derived one
   and creation refuses when it cannot be derived.

7. **Deferred, and only on a decision: the stored-form migration** of §4.5, with field-row
   padding settled first for encrypted workspaces.

## 8. What this does not solve

- **A share guest without a user-defined definition still sees an unnamed row.** Under region
  sharing the rows are the owner's, at rest, in the id form. The sharing design's definition
  stand-ins are still the answer; a stand-in can now be matched to its original by key instead
  of by id, which is simpler than reading a copy "under the original definition id". The stored
  key form would give a readable name with no stand-in, but not a codec.
- **Moving a page to another workspace** still has to move or map definitions, type tokens,
  media, and every id the app re-derives. This removes one line of that list (re-pointing
  property rows becomes a lookup by key) and leaves the rest.
- **A later built-in taking a key a user holds.** Unchanged, with one new guard (§4.3).

## 9. Decisions for Vlad

**Fork 1: where the key form lives.**

- *(a) Border only (my pick).* A page with `status` and `priority` is stored exactly as today,
  two rows `::((…))`. Copy it and the clipboard says `::[[prop/status]]`, `::[[prop/priority]]`;
  paste it into another workspace that has both and it binds; into one that lacks `priority` and
  you get a visible row reading "priority, not defined here" with its value intact. Cost: about
  two thousand definition-row writes per graph, no field row touched, and each new export path
  must remember the translation.
- *(b) Stored everywhere.* The same page is stored as `::[[prop/status]]`. A guest lacking the
  definition reads `status` with no stand-in, and export is the stored text. Cost: a one-time
  rewrite of 384,706 rows in the largest graph, every field row bound through the alias index
  from then on, and on an encrypted workspace the server can sort field rows by property-name
  length.

I would take (a) and revisit (b) only if guests seeing unnamed rows turns out to matter after
stand-ins exist.

**Fork 2: what a user-defined key looks like.**

- *(a) The name at creation, frozen (my pick).* You create `priority`, later relabel it
  "Urgency". It is `[[prop/priority]]` everywhere, `properties.priority` in extension code, and
  shows as "Urgency". Two workspaces that each made a `priority` share the key, so a paste binds
  by meaning, and may meet a different codec (§4.3). No migration: the key is the name the cell
  already uses. A later built-in named `priority` would shadow it, as today.
- *(b) A random short id.* The same property is `[[prop/k7f3q9]]`. It can never collide with a
  built-in or with another workspace's unrelated property, and a move carries the definition
  with it unambiguously. But it is unreadable in exactly the places the key was meant to be
  read, two workspaces that each made a `priority` no longer match, and either the cell is
  re-keyed to it (about 168k cell entries in the largest graph) or the cell keeps the name and
  the property has three identities instead of two.

I would take (a). Readable keys are the point of the request, and the collision cases are ones
the system already has and already reports.
