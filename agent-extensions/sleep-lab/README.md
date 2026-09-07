# Sleep Lab

Runs N-of-1 sleep experiments on top of the outline. The protocol is a
page in your notes — question, design, measures, outcomes, analysis,
decision rule — and the experiment block sits inside it, carrying the
machine-readable half: intervention, dose text, control kind, start date,
period length, pair count, seed. The extension assigns each night to an
arm from that block's schedule, collects the morning check-in, imports
what the Galaxy Watch measured, and shows the comparison the protocol
pre-registered. Nothing here is specific to one intervention: a second
experiment is a second block in a second protocol page.

Design lineage: the Strength Tracker next door. Same shape — the outline
IS the state, one block per record, a pure engine, and gestures that write
once and never reconcile.

## What it does

- **Schedule.** An experiment block is typed into the protocol page (or
  created there by "start an experiment here"); stamping it writes its
  periods as child blocks — N nights on one arm, order randomized within
  pairs from the seed on the block. You can see the whole schedule, and
  edit it by editing the blocks.
- **Tonight.** One gesture creates tonight's night block — assigned arm
  from the schedule, dose todo beneath it when the arm calls for one —
  and takes you there. Run it twice and it takes you to the same block.
- **Morning.** Rating controls under the night block: quality, rested,
  ease of falling asleep (1–5), afternoon sleepiness (KSS 1–9), and the
  covariate toggles. Tapping writes the property; there is no form to
  submit.
- **Watch data.** Sleep sessions arrive from Health Connect (automatic,
  via a webhook relay) or from a Samsung Health export (manual, through
  the import dialog). Each session becomes a block under its night, with
  the derived per-night numbers as typed properties. Importing the same
  session twice converges on one block.
- **Analysis.** The Sleep Lab page shows the running experiment — day N
  of M, tonight's arm, adherence — and, per outcome, the glycine − control
  difference with a bootstrap interval and a pair-respecting permutation
  p-value, for both the by-assignment and per-protocol populations.

## Data model

Everything is a typed block; nothing is a row inside a JSON property.

```
<your protocol page>                   (anywhere in the notes)
└─ glycine experiment                  sleeplab-experiment
   ├─ Period 1 · glycine · Sep 15–17   sleeplab-period
   ├─ Period 2 · control · Sep 18–20   sleeplab-period
   └─ …
Sleep Lab                              sleeplab-lab      (kernel page, one per workspace)
├─ Night of Sep 15 → 16                sleeplab-night    (one per wake date; id derived from the date)
│  ├─ 3 g glycine, 30–60 min before bed  sleeplab-dose + todo
│  └─ Sleep 23:41 → 07:12              sleeplab-session  (id derived from start time)
└─ …
```

- **Night** is the experimental unit, keyed by its *wake date*. Its id is
  derived from `{workspace, date}` (`getOrCreateTypedChild`), because
  three writers race for it — the evening gesture, the morning check-in,
  and the importer — and they must converge on one block rather than
  create three. It carries the assignment (refs to the experiment and the
  period, plus the arm), the subjective ratings, and the covariates.
- **Session** is what the watch recorded: start, end, and the per-night
  numbers derived from stages and vitals (onset latency, sleep and in-bed
  minutes, efficiency, stage minutes, awakenings, HR, HRV, SpO2, skin
  temperature delta, respiratory rate, Samsung score where available).
  The `main` flag marks the night's sleep — the longest session that ends
  between 03:00 and 15:00 and lasts 3 h or more, judged in the browser's
  own time zone; other sessions ending the same day are naps. A night
  slept in another zone can therefore be filed as a nap: flip `main` on
  the block by hand. Its id is derived from `{workspace, start minute}`, so the
  same session from either source lands on one block. The stage-by-stage
  series is **not** stored — the derived numbers are, and re-deriving
  means re-importing the source file.
- **Dose** composes the built-in todo: ticked means taken; `takenAt` is
  stamped by the check-in's "taken now" button.
- **Experiment** and **period** have ordinary minted ids: a duplicate is
  visible in the outline and deletable, which is the bar the Strength
  Tracker settled on for visible records. The experiment is read by TYPE
  across the workspace, so it lives wherever the protocol does; the
  running one is the newest with status `running`.
- A strength session on the night's day is read from the Strength
  Tracker's own workout blocks at analysis time, not copied.

Uninstall the extension and the page still reads as a log of nights with
their sleep numbers, which is the record-grain test.

## Engine (`src/engine/`, pure)

- `schedule.ts` — `buildSchedule({startDate, periodNights, pairs, seed})`
  → periods; `armForDate(periods, date)`. Seeded PRNG (mulberry32), so
  the same seed reproduces the same schedule on every device.
- `derive.ts` — a session's stages and vitals → the per-night numbers.
- `stats.ts` — per outcome: means, difference, bootstrap 95% CI, a
  permutation p-value that shuffles labels within pairs, the paired
  period estimate. Populations: *by assignment* (every night by its arm)
  and *per protocol* (a night whose dose block is unticked is out, on
  either arm; an intervention night with no dose block is out). Nights
  flagged unusual are excluded by default; transition nights and an
  alcohol cap are sensitivity toggles.

## Import (`src/import/`, pure)

- `healthConnect.ts` — the [Health Connect Webhook][hcw] payload: `sleep`
  sessions with stages, plus `heart_rate`, `heart_rate_variability`,
  `oxygen_saturation`, `skin_temperature`, `respiratory_rate` samples,
  joined to a session by time window.
- `samsungExport.ts` — Samsung Health's "Download personal data" folder,
  fitted against a real export: the sleep and sleep-stage CSVs (first line
  is metadata, timestamps are UTC, stage codes 40001–40004, stages join
  the session by `sleep_id`), the per-night oxygen, skin-temperature and
  respiratory-rate CSVs, the per-minute heart-rate CSV, and HRV from the
  `jsons/com.samsung.health.hrv/` binning files, which is the only place
  the export keeps it — so the import dialog takes the whole folder.
  Samsung's own onset latency is used over the stages (its session starts
  at detected onset, so the stages never show the latency), and its
  `sleep_duration` is read as time in bed, which is what it is.

Both produce the same `ImportedSession` shape; `src/km/nights.ts` turns
that into blocks. Onset latency is measured differently by the two paths
(Samsung's algorithm vs. leading awake stages from Health Connect), so
compare nights within one path, not across them.

[hcw]: https://github.com/mcnaveen/health-connect-webhook

## Getting the watch data in automatically

Health Connect is on-device only; there is no Samsung cloud API for an
individual. The automatic path is therefore a relay on the phone:

1. Samsung Health syncs sleep, heart rate and SpO2 to Health Connect (it
   does not sync HRV, skin temperature or respiratory rate there — the
   webhook app reads those from the wearable's Health Connect records
   where present).
2. The **Health Connect Webhook** app posts new records to a URL on a
   schedule (e.g. 08:00 daily).
3. An ingest endpoint stores the payload; the extension pulls it on open
   and materializes sessions. **Not built yet** — see the open questions
   in the PR. Until it lands, the import dialog accepts the same JSON
   payload pasted or uploaded, and the Samsung export files.

## Build & test

```sh
pnpm -C agent-extensions/sleep-lab run check
```

No dependencies of its own; it uses the repo-root toolchain like the
Strength Tracker. Unit tests run against the kernel-type stubs
(`vitest.config.ts`), integration tests against the real `@/` sources
and a real database (`vitest.integration.config.ts`).

## Install into a live client

```sh
pnpm agent --profile <profile> install-extension --verify "agent-extensions/sleep-lab/dist/Sleep Lab.js"
pnpm agent --profile <profile> enable-extension "Sleep Lab"
```

Actions:

- **Sleep Lab: open** — creates the page on first use and navigates.
- **Sleep Lab: start an experiment here** (⌃⇧E) — asks for the intervention,
  dose, control, start date, period length, pairs and seed, then stamps
  the experiment block and its schedule where your cursor is — inside the
  protocol page. An experiment block typed by hand gets a **Stamp
  schedule** button in its footer instead.
- **Sleep Lab: tonight** — tonight's night block with its assignment and
  dose; navigates there.
- **Sleep Lab: last night** — last night's block, for the morning check-in.
- **Sleep Lab: import watch data** — the import dialog.

The Sleep Lab page carries the same as buttons, plus the analysis.

## Writing the protocol page

Pre-register it before the first night: the question; the design (arms,
period length, pairs, what a transition night is, blinding or not and
why); the intervention and what is held constant; the measures and where
each comes from; the primary outcomes (few) and the smallest effect worth
acting on; the analysis (estimand, populations, exclusions, inference,
sensitivity) and the decision rule at the end of the schedule; safety and
stopping. Then the experiment block, with its properties filled in.
