# Glycine before bed — an N-of-1 sleep protocol

Written as a pre-registration: the design, outcomes and analysis are fixed
here before the first night, so the result cannot be read into the data
after the fact. The **Sleep Lab** extension in this directory runs it —
the schedule, the nightly check-ins, the watch import and the analysis all
follow this document.

## 1. Question

Does 3 g of glycine taken 30–60 minutes before bed improve my sleep, as
measured by a Galaxy Watch 8 (objective) and morning ratings (subjective)?
And does it show the thermoregulatory signature the mechanism predicts —
warmer wrist skin early in the night?

## 2. Background

The evidence for glycine is small but consistent in direction (citations
from memory — verify the specifics before quoting them elsewhere):

- Inagawa et al. 2006 (*Sleep Biol Rhythms* 4:75): 3 g before bed improved
  subjective sleep quality in people who slept poorly.
- Yamadera et al. 2007 (*Sleep Biol Rhythms* 5:126): 3 g shortened
  polysomnographic sleep-onset latency and the latency to slow-wave sleep,
  without changing sleep architecture; subjective quality improved.
- Bannai et al. 2012 (*Front Neurol* 3:61): 3 g reduced daytime sleepiness
  and fatigue under partial sleep restriction.
- Kawai et al. 2015 (*Neuropsychopharmacology* 40:1405): mechanism — NMDA
  receptors in the suprachiasmatic nucleus → peripheral vasodilation → a
  drop in core temperature, which is the physiological trigger for sleep
  onset. That predicts a **rise in distal skin temperature** (the wrist is
  distal) shortly after the dose.

Effect sizes in those studies are moderate on subjective scales and small
in minutes on PSG (onset latency shortened by several minutes). Glycine is
cheap, tastes mildly sweet, and is safe at far higher doses than this (it
is used at 15–60 g/day in psychiatric trials); the usual side effect is
mild GI upset.

## 3. Design

**Two arms, alternating in short periods, order randomized within pairs.**

- Arms: **glycine** (3 g) vs **control**.
- A *period* is 3 consecutive nights on one arm. Periods come in *pairs*;
  within each pair the order (glycine→control or control→glycine) is drawn
  from a seeded random generator, so the arms are balanced over weekdays,
  weekends and slow drifts, and no run is longer than 6 nights.
- **8 pairs = 48 nights ≈ 7 weeks** in the first pass.
- The first night of each period is a *transition night*. It stays in the
  primary analysis (the effect is expected to be acute — glycine clears in
  hours) and is dropped in a sensitivity analysis.
- **Baseline week first**: 7 nights with the watch on and the morning
  check-in, no glycine. Not part of the comparison — it proves the data
  pipeline end-to-end and gives the night-to-night variance the sample
  size below assumes.

**Why open-label in the first pass.** Glycine is sweet enough that a
convincing placebo needs matched sachets prepared by someone else (or
capsules). Rather than gate the experiment on that, the first pass is
unblinded and leans on *objective* primaries: the watch does not know
which arm it is. If the objective outcomes move, expectation did not do
it. If only the subjective outcomes move, that is exactly the result a
blinded confirmation pass is for — the extension supports a `placebo`
control label for that run.

**Why not per-night randomization.** It is more efficient statistically
for an acute effect, but it makes every evening a decision and doubles the
number of transition nights. Three-night periods are the compromise.

## 4. Intervention

- **Dose**: 3 g glycine powder dissolved in 100–200 ml water, 30–60 min
  before lights-out. Log the time taken.
- **Control**: nothing (first pass); a matched placebo drink in a blinded
  pass.
- **Hold constant**: bedtime window, caffeine cut-off, no new supplements
  or sleep changes during the run; the watch on the same wrist, same
  tightness. Anything unusual (illness, travel, a very late night) gets
  the night flagged, with the reason.

## 5. Measures

**Objective — Galaxy Watch 8 via Samsung Health.** What reaches the
extension depends on the path:

| Measure | Health Connect (automatic) | Samsung export (manual) |
| --- | --- | --- |
| Sleep session start / end, stages (light / deep / REM / awake) | yes | yes |
| Heart rate during sleep | yes (delayed sync) | yes |
| Blood oxygen | yes | yes |
| HRV (RMSSD) | via the webhook app | yes |
| Skin temperature | via the webhook app | yes |
| Respiratory rate | via the webhook app | yes |
| Samsung sleep score | no | yes |

Derived per night from the session and its stages: **onset latency**
(leading awake time), **total sleep time**, **time in bed**,
**efficiency**, **deep / REM / light / awake minutes**, **awakenings**
(awake bouts after onset), mean and minimum **heart rate**, mean **HRV**,
mean **SpO2**, mean **skin-temperature delta**, mean **respiratory rate**.

**Subjective — morning check-in, within ~30 minutes of waking**, each on
a 1–5 scale: sleep **quality**, how **rested** you feel, how **easily**
you fell asleep. **Afternoon** (~15:00): sleepiness on the Karolinska
scale (1 = extremely alert … 9 = fighting sleep).

**Covariates**, logged on the night: alcoholic drinks (count), caffeine
after 14:00, a large meal within 2 h of bed, a strength session that day
(read from the Strength Tracker's own blocks — no re-entry), nap minutes
(from any daytime sleep session the watch recorded), and the *unusual*
flag with a reason.

**Adherence**: the dose is a todo under the night block. Ticked = taken;
the check-in can stamp the time.

## 6. Outcomes

**Primary** (three, chosen for where the literature is strongest):

1. Sleep-onset latency, minutes (objective).
2. Deep-sleep minutes (objective).
3. Morning sleep quality, 1–5 (subjective).

**Secondary**: total sleep time, efficiency, awake minutes, awakenings,
REM minutes, mean sleeping heart rate, HRV, SpO2, respiratory rate,
Samsung sleep score, restedness, ease of falling asleep, afternoon
sleepiness.

**Mechanistic**: skin-temperature delta (expected *higher* on glycine
nights if the vasodilation route is real).

Smallest effects worth acting on: onset latency −5 min, deep sleep
+10 min, quality +0.5 points. Below those, the answer is "not worth the
nightly ritual", whatever the p-value.

## 7. Analysis

- **Estimand**: mean difference, glycine − control, per outcome.
- **Populations**: *by assignment* (every night, whatever was taken —
  primary) and *per protocol* (glycine nights with the dose logged as
  taken; control nights with no glycine). Both are reported.
- **Exclusions**, fixed here: nights flagged *unusual*; nights with no
  main sleep session (watch not worn); nights before the experiment's
  first period.
- **Inference**: bootstrap 95% confidence interval (nights resampled
  within arm) and a permutation p-value that shuffles arm labels **within
  pairs**, respecting the randomization actually done. A paired estimate
  (period means, differenced within pairs) is shown as a check.
- **Multiplicity**: three primaries are reported side by side with their
  intervals; no correction, and no single one "wins" the experiment. A
  convincing result is all three leaning the same way with at least one
  interval clear of zero.
- **Sensitivity**: without transition nights; without alcohol ≥ 2 nights;
  split by trained / rest days.

**Decision rule after 8 pairs**:

- primary intervals clear of zero in the beneficial direction → adopt,
  and consider a blinded confirmation pass for the subjective outcomes;
- point estimates favour glycine but intervals straddle zero → extend by
  4 pairs, to a maximum of 16;
- otherwise → stop; glycine is not doing enough to keep.

## 8. Data pipeline

Watch → Samsung Health → Health Connect → *Health Connect Webhook* app
(scheduled POST each morning) → ingest endpoint → the extension turns each
sleep session into a block under its night. Fallback: Samsung Health's
"Download personal data" export, imported through the extension's import
dialog. Both paths are idempotent — a session is identified by its start
time, so re-importing converges instead of duplicating. See the README.

## 9. Safety and stopping

Stop the glycine arm early and note it if there is persistent GI upset,
nausea, or clearly worse sleep for 3+ consecutive glycine nights. Nothing
here is medical advice; glycine at 3 g is a common dietary supplement.

## 10. Timeline

| Week | What |
| --- | --- |
| 0 | Baseline: watch + morning check-in, verify the import lands |
| 1–7 | Pairs 1–8 |
| 7 | Read the dashboard against §7's rule |
| 8–11 | Optional extension, pairs 9–12 |
