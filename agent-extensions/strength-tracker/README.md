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
- **Fast logging.** Every set is pre-filled from the prescription; accepting
  one as-prescribed is a single tap. A finished workout lands as blocks.
- **Layoff awareness.** Gaps between full sessions are classified against the
  plan's re-entry table and recorded as `strength-layoff` blocks; the comeback
  ramp shows until you're back to pre-break weights.
- **Trends & milestones.** Per-lift progression sparklines, dance-lift
  milestone bars, and a left/right asymmetry view for single-arm work.
- **Shoulder self-check.** After logging, occasionally surfaces the plan's
  re-open triggers; any checked trigger creates a todo referencing the
  shoulder-policy block.

## Design

- **Pure engine.** `src/engine/` is `(history, config, today) → prescription`
  with no km, DOM, or clock dependency — the progression rules, re-entry
  table, scheduling, trends, and shoulder logic are all unit-tested there.
- **Config from notes.** `src/program/planParser.ts` reads exercises, rep
  ranges, increments, re-entry percentages, and milestones live from the plan
  outline; `src/program/defaults.ts` is a plan-faithful fallback for anything
  a line can't be read from. Edit the program by editing your notes.
- **Data as blocks.** `src/km/` stores workouts, exercise entries (sets in a
  `strength:sets` property plus a denormalised working weight for flat SQL),
  and layoffs as typed blocks — queryable, hand-editable, meaningful even with
  the extension removed.

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

Then run the **Strength: open tonight's session** command (⌃⇧L) — it creates
the *Strength Log* page on first use and navigates to it.

## SQL sanity checks

```sql
-- last working weight for an exercise
SELECT json_extract(properties_json, '$.strength:workingWeight') AS weight
FROM blocks
WHERE json_extract(properties_json, '$.strength:exercise') = 'Bench press'
ORDER BY created_at DESC LIMIT 1;

-- all bench workouts since June
SELECT b.content
FROM blocks b
WHERE json_extract(b.properties_json, '$.strength:exercise') = 'Bench press';
```
