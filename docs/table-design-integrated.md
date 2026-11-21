# Tables: integrated design

> **Status:** proposed design, no implementation. Supersedes `docs/table-views-design.html` where the two differ (§1 lists how).
> **Last verified against code:** 2026-11-20, master @ `a6cc683289c`, by reading only. The focus model (§7) and the core write functions (§4) are unmeasured; see §12.

Rev 2, 2026-11-21. Merges the Table Views design (`docs/table-views-design.html`, PR #363, rev 3) with a grid-library spike and research done outside the repo. Rev 2 folds in one review round (three reviewers reading master); §13 says what changed.

Claims are tagged where it matters:

- **measured**: seen in the grid spike (dev build, Chromium and the iOS Simulator, invented content, mostly one run). The spike is not in the repo.
- **read**: read in master at `a6cc683289c`, with nothing run.
- **reasoned**: neither.

## 1. Summary

A table is an ordinary block that carries the table type. Its rows are real blocks, its columns are property definitions, and **each cell is the property's real value block**, edited with the native block editor.

From #363 this keeps: rows from a text query or from the block's own children, columns keyed by definition id, views as child blocks, new-row back-fill, embedding the table as a block, and deferring windowed virtualization.

From the grid research it keeps: our own grid on CSS grid, range copy/paste/fill, the swipe gate, and editing on phones.

It changes four things in #363:

1. Cells mount value blocks. They are not property-panel editors over the projection (§4).
2. The row source is an ids-only query sorted in SQL, with no JS tail in the first version (§5).
3. Columns are blocks, one per column (§3).
4. No tweak layer (§6).

The query keeps #363's code fence, but the fence is the content of a property's value block on the host, not the host's own content (§11).

## 2. Scope

**Protects against:** losing or hiding stored values; a table gesture restructuring the outline behind the user's back; blocks under the table becoming invisible.

**Does not handle, on purpose:** editing in a `cell` workspace (read-only there); several people changing one view at once (last write wins); A1 formulas; merged cells; charts; `.xlsx`.

**Known platform gap this inherits.** When two of one user's devices edit different cells of one row offline, the value blocks converge, so the cells show the right values. But each device uploaded the row's whole `properties_json`, and nothing re-projects on sync arrival (read: `syncObserver/materialize.ts`). SQL sort and filter can then read a stale value for one of the two properties until that property is next written locally. A table makes this visible as a row sorted or filtered by a value its cell doesn't show. It is not a table defect and no data is lost. Size it with the existing divergence check before deciding whether to fix it (§11).

**Workspace state.** Editing needs a child-backed workspace; the gate is the workspace state, checked inside the core write helpers, never "do value rows exist" (a backfilled, unflipped workspace has value rows that must not be edited in place: read, `propertyDisplayMode.ts`). In a `cell` workspace the table renders read-only from `properties_json` with a one-line notice. New workspaces start child-backed (read), and most existing workspaces are reported flipped.

**Depends on** the `property-rows` plugin, which supplies the inline value controls, value autocomplete and the ref type warning (read).

## 3. Data model

```
Reading list             <- host block, table type; content is a free title
  ::((query definition)) <- field row (optional)
    ```query             <- value block: the query text, in a code fence
    #book status=open
    ```
  Default                <- view block; content is the view name
    Title                <- column block for the row's own content
    Author               <- column block; field -> definition of `author`
    Rating
  Dune                   <- a row when there is no query: rows are the host's children
    ::((author))
      Frank Herbert      <- the cell: an ordinary block
```

- **Host.** Any block with the table type. "Turn into table" adds the type and, if the block has no view yet, one view with its columns, in one transaction. Nothing moves, because properties are already child blocks. A view is never created on render. If two views exist (two devices converted offline), the first in sibling order is used and both are visible in the outline view.
- **Everything under the host is drawn.** View blocks excepted, a child of the host is either a row or, when a query is set and it doesn't match, listed as ordinary outline below the grid. Nothing under a table is invisible.
- **Show as outline.** One per-block toggle renders the host with the default layout, so views, columns and rows are all ordinary visible blocks.
- **View.** A child of the host; content is its name. v1 uses one view. Sort is two properties on the view: a ref to one of its column blocks, and a direction. One sort column cannot be violated in this shape; multi-column sort later is a ref list.
- **Column.** A child of the view. Sibling order is column order, so reordering is one block move (measured: one row event).
  - Field: `optional-ref` to a property definition (`targetTypes: ['property-schema']`; legal, with precedents: read). No field row at all means "the row's own content". A field row that doesn't resolve is an **error column** with read-only cells; it never falls back to row content.
  - Width: a number, written when a drag ends.
  - Content: an optional header label. Empty shows the definition's name.
- **Row sources never return table machinery.** Field and value rows are excluded by the engine option in §5; view and column blocks by their types, in every row source (this needs a `types` term on predicates, so `exclude` can name them: §8), so another table's configuration never shows up as data rows or counts toward the cap.

**Seeds.** v1 declares only what it uses: three types (table, view, column) and five properties (query, column field, column width, view sort column, view sort direction). Ids must be namespaced and **freeze when shipped**; naming is #363's open question (a markdown pipe table is already called a table in the UI). Hidden columns, multi-sort and an active-view pointer are not declared until a phase needs them. View and column blocks are created with `createTypedChild`.

### Why columns are blocks

#363 left the column list's encoding open. The record-grain rule answers it: a column has its own width and is reordered, deleted and undone on its own, so it is a block with a typed ref. The definition's backlinks then list the tables that show it.

### Why view blocks are visible children

#363 keeps view config in properties for "any node as a table" but uses child blocks for table blocks. This design uses child blocks in both cases. Considered and rejected: hanging the view under a property of the host. `unsetProperty` and list reconciliation delete value-row subtrees (read), so an unrelated property write could delete a view.

## 4. The cell

A cell is addressed by (row block R, property definition F).

### What it shows

One reactive lookup returns **every** field row for (R, F) in projection order, and every value row under them. Lists, because duplicates and peers are reachable: two devices materializing one cell offline mint two field rows that fold only on a later local write, and a scalar can hold divergent peer value rows (read).

| Stored | The cell shows |
|---|---|
| Value rows | Each one mounted as a real block, in order. A lone blank value row with nothing nested displays as empty |
| No value rows, but `properties_json` has a value | The projected value as plain text |
| Neither | Empty |

- Text that doesn't parse for the codec is just a value row: it shows with the existing ⚠ marker and is fixed in place. This replaces #363's "unreadable value" query and marker.
- Mounting a value row with `PropertyFieldRowContext` around it (exported from core) gives the inline control for single-valued boolean, date and enum, reference autocomplete, the type warning and the codec-aware editor, with no dependency on the field-row layout or the display mode (read). Number, string and url are plain text in the block editor. As native value editing improves, cells inherit it.
- Blocks nested under a value row stay out of the cell, behind a small marker; expanding the row shows them.
- The display states are for drawing only. **No write decides anything from them.**

### How it writes

Three core functions, each classifying **inside its transaction**. They live beside the property-children processor and are what the decided-but-unbuilt outline "ghost rows" need too, so the outline and the table share one behaviour.

| Function | Does |
|---|---|
| `openPropertyValue` (owner, field, first text?) → {value row id, created} | Field row exists: return its scalar value row, or append a member. No field row but a stored value: materialize the rows through the `setProperty` path (it creates them even when the value is unchanged: read). Neither: create both. Goes through `upsertFieldRow`, so duplicates collapse. Takes the typed first character, so the common way in writes the value in the same transaction and never projects a blank. Reports whether it opened an existing value or a new draft, so the grid knows whether typing replaces or fills |
| `writePropertyText` (owner, field, text) | Text that decodes goes through `setProperty`. Text that doesn't is written as the value row's content, so it stays visible with ⚠, unless the text would stop the row being a value at all. Empty text means clear. Replacing a list never deletes an annotated member: members that match keep their rows, and a write that would remove a member carrying nested blocks or properties is refused (resolve in the outline) |
| `clearPropertyValue` (owner, field) | Never calls unset. If any value row has something nested, the clear is refused (resolve in the outline): blanking and keeping it would still project `''`, or an empty list member, and leave the property set. Otherwise every value row is deleted, then each field row once it has no children and no properties of its own (a field row with its own properties is kept, so a list stays stored as `[]`), and the projection unsets the key |

Why not the existing calls:

- `setProperties({unset})` does nothing when the key is already unset, which is exactly the unparseable and blank cells a user wants to clear, and when the key is set it deletes every field row's whole subtree (read).
- The `::` path is not reusable as it stands. It converts an existing scaffold block and creates the value row in a second transaction (read). It also refuses the "stored value, no rows" state, which is correct for it and is why open-cell must classify in the transaction: creating an empty row there would make the projection delete the stored value.

Rules that follow:

- **Typing** uses the editor's own cadence: the value row's content is written on its debounce, and each flush is its own undo entry, as in the outline. Core re-projects R's `properties_json` in the same transaction (measured: one undo reverted both).
- **When a cell's edit ends**, a fourth function, `finishPropertyValueEdit` (owner, field, value row, final text), writes the editor's final text and decides blankness in the same transaction. Ordering against the editor's debounced flush is therefore not the caller's job: a separate cleanup call that ran before the flush deleted the draft, and the flush then wrote the typed text into the deleted row without error (measured in review of the first implementation). Finish removes only what open created, and only while it is still blank with nothing nested, so an explicitly empty stored value (`[]`, `''`) survives a click in and out. A blank string row would otherwise project `''` and count as set (read).
- **Refusals are typed** (a refusal error with a reason: read-only, resolve in the outline, would change the stored value), and the editability decision is exported, so the grid can render read-only columns before any interaction and a range write catches refusals without swallowing real failures. Every refusal is raised before its call's first write; tests catch it inside the transaction and commit, so the rollback cannot hide a partial write.
- **Paste, fill and clear are one transaction and one undo step each.** A column whose property is not block-scoped is read-only in the table, because a range write that includes it would throw (read).
- **State "value without rows" is not only a migration leftover.** The offline gap in §2 can produce it. Materializing can also refuse (an off-menu enum, a ref that cannot render); the cell then shows the error and stays read-only.

## 5. Rows

### One row source

One subscription returns **ordered row ids** from `core.typedBlockIds`, which does not hydrate rows and is not woken by content-only edits (read). Rows and cells are blocks and subscribe to themselves.

"My children" is the same query with a parent predicate and outline order, so there is one path, not two.

Engine additions on the typed query (read: none exists today):

1. A direct-parent predicate. Small.
2. `order`: outline order, or one property ascending or descending. A property order adds that property's channel as a dependency, and applies the same storage-shape test as `where` (read: `STORAGE_TEST` in `typedBlockQuery.ts`, which `where` already applies). A row whose stored value has the wrong shape for the codec, such as a string left in a property re-typed to number, sorts with the rows that lack the value, after the well-shaped ones in either direction, never compared against them.
3. `propertyChildren: 'none'`, reusing `NOT_PROPERTY_ROW_SQL`. Smallish: that SQL is private to the kernel queries and its parameters must be threaded through the compiler.
4. `limit` on the ids query.

**What sorts in v1.** Columns whose codec is comparable in SQL: string, number, boolean, date, enum (by value, not option order) and url. Text sorts case-insensitively (`COLLATE NOCASE`); accented letters still sort by code point, after `z`. Reference, list and row-content columns do not sort until the engine learns them.

v1 fetches every matching id up to a cap, with a visible "narrow the query" notice. At 5000 rows a SQL sort took 8 to 19 ms and a filter 4 to 6 ms with no index (measured, through plugin SQL, not through the engine).

### No JS tail in v1

#363 evaluates terms the engine lacks (or-groups, `created`/`updated`, contains on string lists) in JS over hydrated rows. Here such a term is a **visible term error** until the engine supports it.

- A tail needs every candidate hydrated and re-sorted in JS on each change.
- It needs a JS copy of the engine's storage-shape test, which #363 itself flags as a drift risk.
- It is a second row-source path every later feature must also work on.

Cost: #363's downstream corpus uses or-groups in 18 of 116 tables; those wait for `anyOf`. Sorting is limited as above.

### Extending the language (decided 2026-11-21)

Decided: extend `TypedBlockQuery` with what tables need, and add a seam so plugins can extend the language further. Someone who needs a term the language lacks writes a plugin that adds it, then writes the query in the same language. There is no JS tail.

What goes where (the shape below is my proposal, reasoned; I have not designed it against the compiler in detail):

- **Core, built in:** structure that a contribution cannot add. The parent predicate, `order`, `propertyChildren`, `limit` (the four above) and `anyOf`, the or-group across predicates.
- **The seam: queryable fields.** Today a `where` key must be a registered property (read). A contribution adds a **virtual field**: a name that is not a stored property but can appear in `where`, and later in `order`. It declares one SQL value expression over the candidate row, how an operand is encoded for binding, whether it bounds the ancestor walk, and its invalidation dependencies. The engine applies its own comparators, `between`, presence and `order` to that expression, so a field gets filtering and sorting from one declaration and cannot re-implement an operator. An operator beyond comparison (a substring match, say) is added to the contract when a field needs it. Its SQL is wrapped and its parameters are checked (count against placeholders); a fragment can still be written to escape its parentheses, which is accepted because a plugin can already register its own SQL (below).
- **First users of the seam, in place of hard-coding them:** `created` and `updated`. Then row content, as a filter and as a sort key, and sort by a reference's label. Building these through the seam is what proves its contract.
- **List contains** is a different axis: an operator a codec declares in its existing `where` capability, not a virtual field.
- **Dates are instants in the engine.** A date-only operand on `created`/`updated` is refused there; the query parser turns `created>2026-01-01` into instants bounding that day in the user's time zone (`eq` is the day's range, `lte` ends at the next midnight), because a user writing a date means the whole local day.
- **Text grammar.** No change needed for fields: `created>2026-01-01` is already the `field op value` shape, so a contributed field is usable in query text as soon as it is registered. The parser resolves names against properties and virtual fields alike.

Constraints on the seam:

- **Dependencies are part of the contract.** A field that under-declares them gives a table that silently fails to update. The engine should refuse a contribution with none.
- **A contribution can only add a predicate or sort key on the candidate row.** It cannot rewrite the query. A term the ancestor walk treats as bounding must say so explicitly; by default a contributed field is not bounding.
- **A query naming a field this device doesn't have** (plugin not installed here) is the same visible term error as an unknown name, never an empty table.
- **No new trust boundary.** A plugin can already register its own SQL through `queriesFacet`, so contributing a fragment grants nothing new.

### Query text

Kept from #363 §4.3: the term shapes, `name^fieldId` as the saved form, bare names for hand and agent authoring, an unresolvable name as a visible term error, `under=` needing a bounding term.

Scalar property terms, and ref terms whose target type registers a filter default, compile through `resolvePropertyFilter` in the backlinks plugin, which already owns which operators a codec admits and how operands parse (read). It hard-codes ancestor scope today; that becomes a parameter. A ref or ref-list term with no target default gets only presence operators from it (read: `presenceOnlyAffordance`), so the parser compiles ref equality itself: `assignee=[[Mary]]` becomes `referencedBy {id: Mary, sourceField: assignee}`, which the engine supports today (read). The parser also keeps quoted literals itself: the adapter's operand parsing serves a form, where empty input on `=` means "unset" (read: `buildScalarWhereValue`), so `label=""` compiles to equality with the empty string and never through that rule; absence keeps its own term shape from #363. The backlinks filter store stays a separate stored encoding; neither replaces the other.

### While editing

- While any editor inside the table is open (a cell, or a block in an expanded row's subtree), the id list is frozen, plus the rows created here. It settles when editing ends. This is one gate in place of #363's per-row pin; the cost is that a remote change shows a few seconds late.
- The placeholder row creates a block and back-fills what the query implies (type terms, `=` terms, parent terms), as in #363.
- A new row that doesn't match the query stays in the grid, marked as not matching, for as long as the table is mounted: the rows created here are a local list kept beside the query's ids, so a row created under a query's parent term (outside the host) stays reachable while its remaining cells are filled in. After a remount it follows the query; a non-matching row under the host is then still listed below the grid (§3), and one under another parent is where the query put it.

## 6. Views and columns

- **Sort.** A header click writes the view's sort column and direction. Undoable, synced.
- **No tweak layer.** #363 adds a second synced layer of unsaved tweaks plus "save view". For one user that is a second place for the same setting. Add it when two people share a view and ask.
- **Add column.** Creates a column block and puts the cursor in its field value. The native reference autocomplete, filtered to property definitions by `targetTypes`, is the picker (reasoned from the read autocomplete). Creating a new property goes through `adoptOrCreatePropertySchema`.
- **Initial columns.** For a type-backed query, the type's declared properties at creation. After that columns are explicit; #363's live "union of present fields" default is dropped.
- **Delete column.** Deletes the column block only. Row values stay (measured: 50 rows kept their values).
- **Embedding.** `!((host))` embeds the table. `((host))` is an inline reference and shows the title only (read).

## 7. The grid

- **Host layout.** A `blockLayoutFacet` contribution on the host, gated on the table type. That slot is single-winner, last wins (read), so the contribution's precedence is stated in the plugin.
- **A row is a block layout for R**, built on `BlockFrame`: R's content in the first column, cells after it. Rows are mounted the way backlink entries mount a block from elsewhere (`BlockEntry`), in a render scope of the table's own (`surfaceRenderScopeId`). Cells use that scope; an expanded row's subtree uses a different one, so a value row is never mounted twice in one scope.
- **Focus is always on the row block.** The cursor is (focused row, column), where the row comes from app focus and only the column is grid state. Arrows, Enter, Escape and Tab held the row and column across a 28-block fixture with no structural change (measured in the risk check, headless Chromium, dev build). Change the column synchronously: a deferred row `focus()` stole focus back from a just-activated inline control. A value block takes app focus only while it is being edited. Empty cells need no special case, because R always exists.
  - Row actions (toggle todo, open in panel, delete, reorder among children) work unchanged, because they target R.
  - Up and down step between rows, bound by the grid itself in row-focused mode through the same shortcut-surface activation as left and right. Excluding cells from the spatial walker is not enough: when a row has children the grid does not draw, or shows its field rows, the walker's model step lands on an occurrence that never mounts (measured with a probe in the spatial-navigation tests). Cells are still excluded from the walker by surface name, so nothing else lands focus on them.
  - After a reload the row is restored by the existing focus path; the column resets to the first.
- **Mounting.** Rows mount lazily through the existing `LazyViewportMount` and `FocusedRowLazyMount`, which already keep the focused row mounted and restore scroll (read). The panel is the vertical observer root; the horizontal scroll wrapper sets `overflow-y: hidden`, because a wrapper with unbounded vertical overflow makes every row mount at once (that explains the earlier 5000-row timeout: 5000 of 5000 mounted, against 39 with the fix) (measured in the risk check, headless Chromium, dev build). Mounting is sticky, so the cap starts at 300 rows: 47 rows mount at first, each further row costs about 15 ms, and query handles rose from 91 to 325 at 300×5 (measured in the risk check, headless Chromium, dev build). Windowed virtualization (`@tanstack/react-virtual`, measured at 5000×5 with 106 blocks mounted) is deferred until the cap hurts, and designed together with focus.
- **Layout.** CSS grid, sticky header, frozen first column, rows grow to fit wrapped text, the panel scrolls (measured, including iOS).
- **Row expansion.** An expanded row mounts R's real subtree under the row.

### Keys

Three modes, bound through the shortcut-surface activation seam that backlink entries use.

- **Row focused:** left and right move the column, Shift+arrow extends a range, Enter or typing opens the cell (typing passes its first character to open-cell, and the grid hands it to the mounted editor explicitly rather than relying on the key event), Delete clears. At 300 rows the first arrow after a click was sometimes lost; cause unknown, so the grid's acceptance test presses a key immediately after a click.
- **Editing a cell:** Enter commits and moves down, Tab commits and moves right, Escape leaves, arrows stay with the editor. The grid's Enter must win over block split.
- **Inline control focused** (checkbox, date, select): the control activates a modal context that shadows block bindings (read), so the grid handles Tab, Enter and Escape for it explicitly. Checkbox, date and select each took focus on Enter, operated by key, and returned to row focus on Escape, Tab and Enter (measured in the risk check, headless Chromium, dev build).

### Guards

- **Each cell's value block is its own scope root.** The structural edit policy already refuses indent, outdent and merge-up at a scope root, and vertical move never moves one (read). Backlink entries rely on the same policy. Indent, outdent, merge-up and vertical move were refused at a cell (measured in the risk check, headless Chromium, dev build). **Split is not covered:** Split block from the palette created a persisted child of the value row that the cell does not show. Split is refused for a table cell at action dispatch, so the palette and the keyboard share one rule. No wildcard action guard: it would block undo, the palette and every extension action while a cell is focused. If something still leaks, deny it by id.
- **Structural keys the policy does not cover** belong to the grid: Split is refused for cells at action dispatch (#1789); vim `o`/`O`, Backspace-delete inside a cell, and Up/Down in row mode are bound by the grid itself. Horizontal touch panning inside a `data-no-block-gestures` wrapper also needs that wrapper to be the scroll container.
- **Undo** stays per editor flush: two flushes of one cell edit are two undo steps, and `undoGroup` over `block(id).setContent` did not merge them (only `mutate.setContent` writes did) (measured in the risk check, headless Chromium, dev build). One undo per cell edit would need a grouped write path through the editor; not planned.
- **Typing the exact field-form text** `::((id))` into a value block turns it into a field row, as it does anywhere in the outline. Accepted: the block and its text are kept, and only the exact marked syntax does it.
- **Completions are not actions.** In an empty cell, `::` converts the value row itself into a field row (read: the `::` flow converts the block it is typed in), so the value disappears from a cell that cannot show a field row; `::` is switched off in cells. Everything else stays on. `#type` tags the value block, which is ordinary block behaviour: the row stays a value, and a reference value whose text gains a tag shows ⚠ like any other edit. `[[`, `((` and the value autocomplete (the enum and reference candidates a ref cell needs) stay on too. The seam is a per-surface flag that only the `::` source checks, not a switch for the whole completion engine, which would also remove the value candidates. The cell's Enter yields to an open completion. The grid sets the flag around cells only, not on the host, or the row's own editor and its expanded subtree inherit it.
- **Paste.** The grid owns every paste inside it, bound on the host's shell so it also fires when the row is focused. Editing a cell: always a single-block insert, and an armed cut is refused. Row focused: TSV into the range.
- **Shift-click** extends the grid range and never reaches block selection (measured).
- **Block gestures.** One owner in `continuousGestures.ts`, at recognizer resolution, for "no block gestures inside this element" (measured: without a gate, a horizontal drag opened the swipe menu instead of scrolling). The marker is rendered in JSX on the row or cell container, never set from an effect: lazily mounted rows read it at mount, and a child's effect runs before its parent's.

### Range operations

Select by mouse drag and Shift+arrow; copy and paste as TSV; fill; clear.

- Pasting writes through write-cell-text, targeting the scalar value row.
- A list cell copies as a JSON array of its members inside one quoted TSV cell, so a member containing a newline survives the round trip. A pasted cell that parses as a JSON array of strings is taken as members; any other text is one member per line.
- A paste larger than the table is clipped to existing rows and visible columns. It creates no rows.
- Measured in the spike only on string columns, through `setProperty`. The helpers here are new paths, and the spike's TSV parser does not handle quoted cells.

### Phones

Editable. In the Simulator: horizontal swipe scrolled the table, the frozen column held, tap opened the editor, the keyboard kept the row visible (measured, with the spike's focus model, not this one). Touch selects one cell; range by touch is undesigned.

## 8. Core changes this needs

| Change | Where | Size |
|---|---|---|
| `openPropertyValue`, `writePropertyText`, `clearPropertyValue`, `finishPropertyValueEdit`, plus `materializePropertyField` (fold duplicate field rows, write a stored value out as rows), in `propertyValueEdits.ts`, shared with the outline's `::` flow; refusals are `PropertyEditRefusedError`, editability `isPropertyValueEditable` | beside `propertyChildrenProcessor.ts` (they need `upsertFieldRow` and the private value-row mint) | medium; new code, not extraction |
| `core.propertyRows` (owner, definition) → all field rows and value rows, with a nested-content flag per value row | kernel queries | small |
| Parent predicate, `order`, `propertyChildren: 'none'`, `limit` on typed id queries | `typedBlockQuery.ts`, `kernelQueries.ts` | small to smallish each |
| `anyOf` across predicates | `typedBlockQuery.ts` | medium |
| A `types` term on predicates, so `exclude` can drop view and column blocks from every row source (today `types` exists only at the top level, as a positive filter) | `typedBlockQuery.ts` | small |
| Queryable-fields seam (virtual fields with operators, SQL and dependencies), with `created`/`updated` as its first users | `typedBlockQuery.ts`, `facets.ts` | medium; contract undesigned |
| The `::` field completion can be disabled per render surface | editor extensions | small |
| A context can name its surface for spatial-navigation exclusions | `spatial-navigation` | small |
| One owner for "no block gestures here" | `continuousGestures.ts` | small |
| Split refused inside a table cell, decided at action dispatch so the palette and keyboard share it (the scope-root structural policy does not cover split) | structural edit policy / action dispatch | small |

Everything else is in the tables plugin.

## 9. What is given up

- **From #363:** editing in `cell` workspaces; the JS tail, so or-groups and reference sort wait for the engine; the tweak layer; the automatic column default; TanStack Table's ready-made grouping state.
- **From the grid research:** windowed virtualization in v1, so tables are capped in the hundreds of rows at first.
- **From a grid library:** years of selection edge cases (multiple ranges, autoscroll while dragging, IME). We own those.

## 10. Build order

1. **Risk check, throwaway.** Done 2026-11-21; its results are folded into §7 and §12.
2. **Core seams** (§8).
3. **Smallest table.** Children as rows, one view, column blocks, cells, the three key modes, the guards. No sort, no query.
4. **Query and sort.** Parser onto `TypedBlockQuery`, query bar, term errors, new-row back-fill, the editing freeze.
5. **Range.** Select, copy, paste, clear, then fill.
6. **Columns.** Resize, reorder and hide gestures, "add to #type".
7. **Later.** Named views, grouping, column summaries (SQL aggregates), the remaining engine terms, windowed virtualization, touch range selection, per-column formulas (a closed interpreter, never `eval`).

## 11. Decisions

1. **Engine only, or a JS tail in the plugin? Resolved 2026-11-21 (Vlad): engine only, and plugins can extend the language** (§5, "Extending the language"). For the record, the question was: either way the user writes the text query and it compiles to a `TypedBlockQuery`; nobody writes SQL. The question is what happens to a term `TypedBlockQuery` cannot express yet, such as `(status=open | deadline<=today)`. Engine only (pick): that term is an error until `TypedBlockQuery` learns it, so there is one evaluation path, but or-groups wait and only scalar columns sort. JS tail (#363): the plugin loads every candidate row and filters and sorts the rest in JS, so those work on day one, at the cost of a second path.
2. **Where does the query live? Resolved 2026-11-21 (Vlad): both.** The query is a property on the host, and its value block's content is a fenced code block holding the query text. The host's title stays free; the query is undone, synced and shown like any value; an agent writes it as one markdown block. The fence also removes the editing hazard: type completion is switched off inside literal markdown, a fence included (read: `typeAutocomplete.ts`, `isInsideLiteralMarkdown`), so typing `#book` there cannot tag the row or mint a type. No dedicated query editor is needed. Not checked: that the string codec round-trips multi-line fenced content, and that reference parsing skips the fence (so `[[Mary]]` in a query makes no backlink).
3. **Where do rows created in a query table live? Resolved 2026-11-21 (Vlad): under the host.** A parent term in the query (`childof=`, `under=`) still wins. For the record: under the host: visible below the grid even when they stop matching, but deleting the table deletes them. On today's daily note (#363's candidate): safe from that, but created somewhere the user isn't looking.
4. **The offline sort/filter gap (§2).** Size it with the divergence check first (pick), then decide on re-projecting at sync arrival. It is a platform change, not table work.

Also settled: no tweak layer; view blocks are visible children; lazy mounting before windowed virtualization.

## 12. Not verified

The risk check (§10 step 1) measured the focus model, scope-root cells, the inline-control key mode, completions off, lazy mounting at 300 rows and undo, in headless Chromium against a dev build with synthetic data and pre-resolved cell ids. Still unmeasured:

- The intermittent loss of the first arrow after a click at 300 rows.
- A real table query and per-cell lookup in the loop; a 5000-row grid of real blocks.
- IME, fast multi-character typing, focus restoration after reload, the row-title editor, reference-value completion.
- A release build, a real phone, production bundle size.
- What `updated` means for a row: editing a cell's value row moves the value row's edit time, not the owner's, so "updated since X" misses rows whose cells were edited (measured in review of the query terms). Undecided whether the projection should move the owner's edit time when a user edit changes the projected value.

## 13. What the review changed

Three reviewers read rev 1 against master. Their findings fell into five causes, each fixed by a change of shape, not a guard:

| Cause | Rev 1 | Rev 2 |
|---|---|---|
| Focus on the cell, or the host for empty cells | Two-mode cursor; a wildcard action allowlist; keys on an empty cell fell through to the table block itself | Focus on the row; cells are scope roots; no allowlist |
| The grid decided what to write from what it drew | Could wipe a stored value by opening a cell; clear did nothing on unparseable cells and over-deleted elsewhere; cleanup could delete text typed within the editor's debounce | Three core functions that classify inside the transaction |
| Host children could be invisible in query mode | Non-matching rows and stray children hidden | Everything under the host is drawn |
| Query edited in the block editor | `#type` completion would rewrite the query | The value block's content is a code fence, where that completion is off (decision 2) |
| Sort and engine scope understated | "Three small additions", any column sorts | Four additions; scalar columns only |

Also from the review: lazy mounting in place of a new virtualization dependency; one row-source path; single sort on the view; fewer frozen seeds; an explicit error column; the offline gap stated in scope; `!((id))` for embeds.
