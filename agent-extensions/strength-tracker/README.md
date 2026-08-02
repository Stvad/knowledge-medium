# Strength Tracker Extension

Operationalises **Strength Plan v2** — the barbell program whose canonical
outline lives in km under *strength training*. The extension reads that plan
(it never writes it), computes tonight's prescription, and logs sessions as
plain km blocks.

## What it does

- **Tonight's prescription.** Given logged history + today's date it answers
  "what do I lift tonight": the session type (A / B / mini per the weekly
  template) and, per exercise, target weight × sets × rep-range — with double
  progression applied, and, when a gap is detected, the re-entry table applied
  automatically and visibly ("20-day gap → 90% of pre-break weights").
- **Fast logging.** Starting a session stamps the whole thing as blocks at
  once — the workout, one block per prescribed lift, one per prescribed set —
  each set pre-filled and carrying the app's own todo checkbox. Logging a set
  is ticking it; correcting a load is the ± controls beside it. There is no
  draft to accept and nothing to save.
- **Layoff awareness.** Gaps between full sessions are classified against the
  plan's re-entry table and recorded as `strength-layoff` blocks; the comeback
  ramp shows until you're back to pre-break weights.
- **Trends & milestones.** Per-lift progression sparklines, dance-lift
  milestone bars, and a left/right asymmetry view for single-arm work.

## Design

- **The outline IS the state.** A set block's *existence* means prescribed;
  its todo `status` means performed. Nothing is materialised on a guess and
  nothing is pruned at the end, so there is no draft to reconcile — editing a
  session is editing its blocks, through the ordinary block path.
- **Pure engine.** `src/engine/` is `(history, config, today) → prescription`
  with no km, DOM, or clock dependency — the progression rules, re-entry
  table, scheduling and trends are all unit-tested there.
- **Config from notes.** `src/program/planParser.ts` reads exercises, rep
  ranges, increments, re-entry percentages, and milestones live from the plan
  outline; `src/program/defaults.ts` is a plan-faithful fallback for anything
  a line can't be read from. Edit the program by editing your notes.
- **Data as blocks, one record per block.** `src/km/` stores the workout, each
  exercise entry, each SET, and each layoff as its own typed block — so every
  one of them is queryable, referenceable, undoable and hand-editable on its
  own, and the session still reads as a session with the extension removed.
  The entry keeps a denormalised working weight so "last weight for lift X"
  stays a flat scan — a snapshot taken at Finish, not a maintained cache: see
  the SQL section for why to read the sets instead.

The one non-obvious modelling call: the re-entry table's *load-cutting* tiers
are global (a real break detrains everything), but "repeat, no jump" is
**per-lift** — every lift here is trained once a week, so three consecutive
Thursday benches (7 days apart) must progress, not read as a missed session.
See the comment in `src/program/defaults.ts`.

## Build & test

No local install — the extension has no dependencies of its own (React and
every `@/…` app module are externalised), so it uses the repo-root toolchain
directly:

```sh
pnpm -C agent-extensions/strength-tracker run check
```

The installable artifact builds at
`agent-extensions/strength-tracker/dist/Strength Tracker.js` (git-ignored;
regenerate with `run build`). The agent CLI uses the file basename as the
extension's install identity — keep the filename when updating an install.

## Install into a live client

```sh
pnpm agent --profile <profile> install-extension --verify "agent-extensions/strength-tracker/dist/Strength Tracker.js"
pnpm agent --profile <profile> enable-extension "Strength Tracker"
```

Two commands, because starting a session and reading the log are different
gestures:

- **Strength: start a session here** (⌃⇧L) — asks what tonight is, then
  stamps it *where your cursor is*: taking the place of the empty line you
  just opened, or as a child of the block you are pointing at. Run it while a
  session is already under way for today and it navigates to that one instead
  of starting a second.
- **Strength: open the log** — creates the *Strength Log* page and its
  settings block on first use, and navigates there. The page carries a **Log a
  workout** button, which runs the same flow but files the session on the log
  page rather than at your cursor.

Configure the program by editing the settings block on that page (plan root,
day-rollover hour, cadence, rounding).

## SQL sanity checks

```sql
-- last working weight for an exercise, from the SETS you actually ticked.
-- `strength:workingWeight` on the entry is a snapshot taken at Finish and is
-- not maintained: unticking a set of a closed session is a supported
-- correction, and it leaves that number behind. The sets are the record.
SELECT s.id, json_extract(s.properties_json, '$.strength:weight') AS weight
FROM blocks e
JOIN blocks s ON s.parent_id = e.id AND coalesce(s.deleted, 0) = 0
WHERE json_extract(e.properties_json, '$.strength:exercise') = 'Bench press'
  AND json_extract(s.properties_json, '$.status') = 'done'
ORDER BY e.created_at DESC, s.order_key
LIMIT 5;

-- all bench workouts since June
SELECT b.content
FROM blocks b
WHERE json_extract(b.properties_json, '$.strength:exercise') = 'Bench press';
```
