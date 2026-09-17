/**
 * Does installing this extension change the ENCODING of values already stored
 * under a value preset it registers?
 *
 * A property-definition block stores a preset ID and a preset config, never a
 * codec. Behaviour is resolved live through `repo.valuePresetCores` on every
 * projector rebuild, so the codec a definition publishes is whatever core is
 * registered under that id at the time. For code-owned presets
 * `seedIdentityLedger.ts` freezes that: its test fails on any edit to a seed's
 * `presetId` / `codec.type` and carries the remedy on the line. An extension's
 * cores live in the database, never pass through that build, and so have no
 * such tripwire — installing a new version whose `build` returns a different
 * codec under the same preset id re-types every definition using it.
 *
 * Nothing downstream catches it. No definition ROW changes, so
 * `core.migratePropertyDefinition` never fires — it watches definition-block
 * writes, which is the point of #1013. The projector publishes the new codec on
 * the next rebuild while the stored values stay in the old encoding, and a read
 * either throws or silently reinterprets them. This is the install-time half of
 * the residual that processor's docblock points at (#1022).
 *
 * WHAT IS COMPARED, and why it is not `codec.type` alone.
 *
 * The preset ID is fixed here by construction — it is the key being matched on
 * — so the definition-change processor's reason for comparing the codec's
 * INPUTS rather than its type (`codecInputsChanged`: a row whose preset was
 * swapped can move between `optional-string` and `string`, which share a
 * `type`) does not transfer. Those are two preset ids and two cores; one core
 * cannot be both. Comparing inputs is in fact useless here — the inputs are
 * identical by definition, and it is the code behind them that moved. So this
 * compares the OUTPUT, on two axes:
 *
 *   - the built codec's `type`, once per stored config (see
 *     {@link presetCodecOutcome}); and
 *   - `configCodec.type`, because the definition row's `property-schema:config`
 *     cell is stored under it. A core that can no longer decode its own stored
 *     config makes `tryBuildSchema` return null, which drops the definition to
 *     metadata-only — every cell then reads as unset.
 *
 * NOT `defaultValue`: it is written into the definition row, but nothing stored
 * is keyed or encoded by it and an incompatible one already falls back
 * (`decodeStoredDefault`). Changing it is an ordinary edit, and the ledger
 * leaves it unfrozen for the same reason.
 *
 * THE BLIND SPOT, stated because it is the ledger's own and the same remedy
 * closes it: a `build` returning a codec with an UNCHANGED `type` and changed
 * encode/decode behaviour is invisible here. No observable of a codec pins its
 * behaviour, and probing one with sample values proves nothing about the values
 * actually stored. An author who moves the encoding must treat the codec's
 * `type` string as a version and bump it — which is exactly what
 * `seedIdentityLedger.ts` already asks of a plugin-owned core, and what makes
 * the change detectable both here and there.
 *
 * SCOPE, on both sides. What it compares AGAINST is what is registered on THIS
 * device right now, so it sees a conflict only while the core it replaces is
 * live: the previous version of a running extension, a plugin's core, or a
 * kernel one. The old encoding exists nowhere in the data — only in the code
 * that is running — so that is the honest limit of an install-time check.
 *
 * What it compares is whatever the caller's install EXECUTES, and install does
 * not execute source it will not make live (#67: a first install grants no
 * trust and sets no intent). So a re-install of a block this device has not
 * approved is not checked at all unless `--verify` asks for the evaluation —
 * and it does not need to be, because nothing it stores runs. The gap that
 * leaves is the ENABLE that later does make it run, which is #1046.
 *
 * ACCEPTED — this is a POINT-IN-TIME comparison against what is LIVE, so
 * anything not yet live is outside it: definition rows inside a durable sync
 * gap or landing after the scan (`syncGap` reports that basis rather than
 * refusing on it), another install landing before the next reload, and a core
 * registered imperatively by an effect (#1054). The candidate is also resolved
 * against the block's PRE-write row — its new source, but its old content and
 * properties — so an extension choosing its core by reading its own block is
 * outside it too; overlaying one row would cover `load` and leave every query
 * and `repo.db` path uncovered, which is worse than saying so. All of them can
 * only MISS a refusal, never invent one.
 *
 * Neither obvious repair works, which is why none is attempted. An
 * in-transaction re-scan would have to ask a NARROWER question than the
 * pre-check — `Tx` exposes no raw read, and definitions are found by type, not
 * by parent — and would answer all-clear over a subset. Serializing installs
 * changes when the scans happen, not what they see: a stored source
 * contributes nothing until a reload.
 */

import type { AnyValuePresetCore } from '@/data/api'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { OBJECT_BAG } from '@/data/internals/propertyKeyScan'
import { kernelValuePresetCoresById } from '@/data/kernelValuePresetCores'
import {
  presetConfigProp,
  presetIdProp,
  propertyNameProp,
} from '@/data/properties'
import type { Repo } from '@/data/repo'
import { decodePresetConfig } from '@/data/userSchemasService'

/** A live definition block whose values this preset encodes. */
export interface AffectedDefinition {
  /** The definition block's id — its durable field identity. */
  fieldId: string
  /** The name its cells are keyed under: the registry's effective name where
   *  the registry knows the row, the stored one otherwise (the fallback is for
   *  rows whose metadata does not parse, which the registry omits entirely). */
  name: string
  /** Live blocks in this workspace carrying a cell under `name`. */
  cells: number
}

export interface PresetIdentityConflict {
  presetId: string
  /** One line per observable that moved, already phrased for the refusal. */
  differences: string[]
  /** Live property-definition blocks in the active workspace using this
   *  preset, most cells first. */
  definitions: AffectedDefinition[]
  /** Cells across `definitions`. */
  cells: number
  /** Code-owned property seeds declaring this preset, by name. Their rows may
   *  not have materialized yet, so they are counted separately from
   *  `definitions` rather than folded in. */
  seedNames: string[]
  /** The core being replaced is a KERNEL one, so this install re-types every
   *  definition in the app that uses the id, not just the extension's own
   *  (#692 — the shadowing half of the same registry property). */
  replacesKernelCore: boolean
}

/** What a core makes of one stored config: the codec type it would publish, or
 *  that it would publish NOTHING.
 *
 *  A core that starts REFUSING a config it used to read has changed what the
 *  definition publishes just as surely as one that changes the codec's type, so
 *  both are outcomes of the same kind. But `unavailable` carries no identity
 *  beyond itself: whether the config decode threw or `build` did, and whatever
 *  either said, `tryBuildSchema` returns null and the definition stays
 *  metadata-only — no stored value changes interpretation. Comparing the
 *  message would refuse an update that only reworded a validation error, so
 *  `detail` exists for the refusal to print and is never compared. */
export type PresetCodecOutcome =
  | {kind: 'codec'; type: string}
  | {kind: 'unavailable'; detail: string}

export const presetCodecOutcome = (
  core: AnyValuePresetCore,
  storedConfig: unknown,
): PresetCodecOutcome => {
  let config: unknown
  try {
    config = decodePresetConfig(core, storedConfig)
  } catch (error) {
    return {kind: 'unavailable', detail: `config rejected (${(error as Error).message})`}
  }
  try {
    return {kind: 'codec', type: core.build(config as never).type}
  } catch (error) {
    return {kind: 'unavailable', detail: `build threw (${(error as Error).message})`}
  }
}

/** What the comparison is ON. See {@link PresetCodecOutcome}. */
const outcomeIdentity = (outcome: PresetCodecOutcome): string =>
  outcome.kind === 'codec' ? `codec type ${JSON.stringify(outcome.type)}` : 'unavailable'

/** What the refusal PRINTS — the identity, plus the diagnosis where there is one. */
const describeOutcome = (outcome: PresetCodecOutcome): string =>
  outcome.kind === 'codec' ? `codec type ${JSON.stringify(outcome.type)}` : outcome.detail

/** The stored configs a comparison must cover: every distinct one in use, plus
 *  `undefined` for the preset's own default. The default probe is what makes a
 *  workspace with no definitions yet still comparable — and it is the only
 *  probe when a preset's codec type does not vary with config, which is every
 *  preset in the tree today.
 *
 *  "In use" is not only the definition ROWS. A code-owned seed declaring this
 *  preset already supplies the schema its cells are written under, whether or
 *  not its definition row has materialized yet, so its `encodedConfig` belongs
 *  here too — otherwise a candidate that preserves the codec at the default and
 *  changes it at the seed's config passes, and materialization reads those cells
 *  under the new one. */
const configsToProbe = (
  definitions: readonly {config: unknown}[],
): readonly unknown[] => {
  const seen = new Map<string, unknown>()
  for (const row of definitions) {
    // A stored `null` and an ABSENT cell are different inputs, not one:
    // `rawPresetConfig` passes `null` to the config codec and falls back to the
    // preset default only for `undefined`. Keying both as `'null'` let either
    // probe suppress the other, and the scan has no ordering guarantee over
    // which one won.
    const key = row.config === undefined ? 'absent' : `stored:${JSON.stringify(row.config)}`
    if (!seen.has(key)) seen.set(key, row.config)
  }
  return [undefined, ...seen.values()]
}

/** Every way the candidate core is not interchangeable with the registered
 *  one, as refusal lines. Empty means the two publish the same encoding for
 *  every config in use — see the module docblock for what that cannot prove. */
export const presetIdentityDifferences = (
  current: AnyValuePresetCore,
  candidate: AnyValuePresetCore,
  storedConfigs: readonly {config: unknown}[],
): string[] => {
  const differences: string[] = []

  const currentConfigCodec = current.configCodec?.type ?? '(none)'
  const candidateConfigCodec = candidate.configCodec?.type ?? '(none)'
  if (currentConfigCodec !== candidateConfigCodec) {
    differences.push(`config codec ${currentConfigCodec} -> ${candidateConfigCodec}`)
  }

  // One line per distinct (before, after) pair, not per config. A preset with
  // no `configCodec` builds from `undefined` whatever the row stores, so every
  // probe yields the same answer and would otherwise repeat the same line once
  // per definition; the config named is the first that produced the pair.
  const reported = new Set<string>()
  for (const config of configsToProbe(storedConfigs)) {
    const before = presetCodecOutcome(current, config)
    const after = presetCodecOutcome(candidate, config)
    const pair = `${outcomeIdentity(before)} -> ${outcomeIdentity(after)}`
    if (outcomeIdentity(before) === outcomeIdentity(after)) continue
    if (reported.has(pair)) continue
    reported.add(pair)
    const where = config === undefined
      ? 'at the preset default config'
      : `at stored config ${JSON.stringify(config)}`
    differences.push(`${describeOutcome(before)} -> ${describeOutcome(after)} (${where})`)
  }

  return differences
}

/** One live `property-schema` row, read the way the projector reads it. */
export interface DefinitionRow {
  fieldId: string
  presetId: string
  /** The row's decoded `property-schema:config` cell, or `undefined` when it
   *  carries none (which is what `decodePresetConfig` falls back on). */
  config: unknown
  /** The name stored on the row, before the registry's effective-name rule. */
  storedName: string
}

/** Every live property-definition row in the workspace, with the two cells the
 *  codec is built from.
 *
 *  Read from `blocks` rather than the registry because the registry carries no
 *  preset id — `PropertyDefinitionMetadata` is deliberately codec-less — and
 *  because a row whose metadata fails to parse is absent from the registry
 *  entirely while its cells are still stored under its name. */
const readDefinitionRows = async (
  repo: Repo,
  workspaceId: string,
): Promise<DefinitionRow[]> => {
  // The WHOLE bag, parsed in JS, rather than a cell at a time in SQL. A config
  // is an arbitrary JSON value — `presetConfigProp` stores it through
  // `unsafeIdentity` — and `json_each(...).value` flattens that: a string cell
  // comes back unquoted, a boolean as 0/1, JSON null as NULL, so parsing the
  // column back as JSON mangles every config that is not an object. Reading it
  // the way the runtime does removes the whole class, and gets the
  // last-duplicate-key rule (`propertyKeyScan`'s `ORDER BY j.id DESC`) for
  // free, since `JSON.parse` is what defines it. `OBJECT_BAG` is still the
  // guard: `json_valid`/`json_type` in a CASE short-circuit, so a malformed bag
  // degrades to `{}` rather than raising.
  const rows = await repo.db.getAll<{id: string; bag: string}>(
    `SELECT b.id AS id, ${OBJECT_BAG} AS bag
       FROM blocks b
       JOIN block_types t ON t.block_id = b.id AND t.workspace_id = b.workspace_id
      WHERE t.type = ? AND b.workspace_id = ? AND b.deleted = 0`,
    [PROPERTY_SCHEMA_TYPE, workspaceId],
  )
  return rows.flatMap(row => {
    let bag: Record<string, unknown>
    try {
      bag = JSON.parse(row.bag) as Record<string, unknown>
    } catch {
      return []
    }
    const presetId = bag[presetIdProp.name]
    if (typeof presetId !== 'string' || !presetId) return []
    const storedName = bag[propertyNameProp.name]
    return [{
      fieldId: row.id,
      presetId,
      config: bag[presetConfigProp.name],
      storedName: typeof storedName === 'string' ? storedName : '',
    }]
  })
}

/** Live blocks carrying a cell under each of `names`.
 *
 *  The names go in as ONE bound JSON array rather than a generated `IN` list,
 *  so the statement binds two parameters whatever the name count. Defence in
 *  depth, and unpinned: a generated list only raises `too many SQL variables`
 *  past this build's limit, which a measured 1,100 definitions on one preset
 *  does not come near. It is the shape that cannot have the problem, for the
 *  same cost. */
const countCells = async (
  repo: Repo,
  workspaceId: string,
  names: readonly string[],
): Promise<Map<string, number>> => {
  if (names.length === 0) return new Map()
  const rows = await repo.db.getAll<{property: string | null; cells: number}>(
    `SELECT j.key AS property, COUNT(*) AS cells
       FROM blocks b, json_each(${OBJECT_BAG}) j
      WHERE b.workspace_id = ? AND b.deleted = 0
        AND j.key IN (SELECT n.value FROM json_each(?) n)
      GROUP BY j.key`,
    [workspaceId, JSON.stringify(names)],
  )
  return new Map(rows.map(row => [String(row.property ?? ''), row.cells]))
}

/** The effective core each AFFECTED preset id would resolve to once this
 *  install takes effect — `undefined` for an id nothing would register any
 *  more.
 *
 *  Affected is both directions, which is why this is a REGISTRY DIFF and not a
 *  scan of what the candidate declares. An extension that currently shadows a
 *  kernel or plugin core and simply STOPS contributing that id declares
 *  nothing, and the id still changes codec — to whatever was underneath. The
 *  caller is what knows the two sides (`presetRegistryAfter` in
 *  `commands.ts`); this compares them. */
export type PresetRegistryAfter = ReadonlyMap<string, AnyValuePresetCore | undefined>

export interface PresetIdentityScan {
  conflicts: PresetIdentityConflict[]
  /** This device's view of the workspace when the definitions were read, or
   *  null when nothing is outstanding locally. Non-null means the definition
   *  and cell counts are SHORT by an unknown amount. */
  syncGap: string | null
}

/**
 * Which affected preset ids would re-type data already stored under them.
 *
 * `after` is the effective registry this install would produce for the ids it
 * touches; the comparison is against `repo.valuePresetCores`, the map every
 * projector rebuild resolves definitions through.
 */
export const findPresetIdentityConflicts = async (
  repo: Repo,
  workspaceId: string,
  after: PresetRegistryAfter,
): Promise<PresetIdentityScan> => {
  const registered = repo.valuePresetCores
  // `current !== next` is a fast path, not a guard — comparing a core against
  // itself finds no differences anyway. It is here because an extension that
  // re-exports the core it imported (from the kernel, or from a plugin through
  // the page importmap) contributes the SAME object, and that is the common
  // case: without it every such install pays the definition scan below to
  // reach the same answer.
  const contested = [...after].flatMap(([presetId, next]) => {
    const current = registered.get(presetId)
    // Nothing resolves this id today, so nothing is stored under a codec this
    // install could change.
    if (current === undefined) return []
    if (current === next) return []
    return [{presetId, current, next}]
  })
  if (contested.length === 0) return {conflicts: [], syncGap: null}

  const definitionRows = await readDefinitionRows(repo, workspaceId)
  const syncGap = (await repo.workspaceViewGap(workspaceId))?.reason ?? null
  // The workspace test is defence in depth; no test pins it. Install resolves
  // the ACTIVE workspace, which is the one the registry is loaded for — but
  // reading another workspace's registry here would rewrite every name through
  // a stranger's seeds, and the stored-name fallback below is strictly better
  // than that.
  const registry = repo.propertyDefinitions?.workspaceId === workspaceId
    ? repo.propertyDefinitions
    : null

  const conflicts: PresetIdentityConflict[] = []
  for (const {presetId, current, next} of contested) {
    const rows = definitionRows.filter(row => row.presetId === presetId)
    const seeds = [...(registry?.seedsByKey.values() ?? [])]
      .filter(seed => seed.presetId === presetId)
    const differences = next === undefined
      ? [`${describeOutcome(presetCodecOutcome(current, undefined))} -> no core registers this id `
          + '(every definition using it publishes no schema, so its cells read as unset)']
      : presetIdentityDifferences(current, next, [
          ...rows,
          // A seed's declared config counts whether or not its row has
          // materialized — see `configsToProbe`.
          ...seeds.map(seed => ({config: seed.encodedConfig})),
        ])
    if (differences.length === 0) continue

    const names = rows.map(row =>
      registry?.definitionsByFieldId.get(row.fieldId)?.name ?? row.storedName)
    const cellsByName = await countCells(repo, workspaceId, [...new Set(names)])
    const definitions = rows
      .map((row, index) => ({
        fieldId: row.fieldId,
        name: names[index]!,
        cells: cellsByName.get(names[index]!) ?? 0,
      }))
      .sort((left, right) => right.cells - left.cells || left.name.localeCompare(right.name))

    // Cells are counted per NAME, so two definitions competing for one name
    // must not have it counted twice.
    const cells = [...new Set(definitions.map(d => d.name))]
      .reduce((total, name) => total + (cellsByName.get(name) ?? 0), 0)

    const seedNames = seeds.map(seed => seed.name).sort()

    conflicts.push({
      presetId,
      differences,
      definitions,
      cells,
      seedNames,
      replacesKernelCore: Object.hasOwn(kernelValuePresetCoresById, presetId),
    })
  }
  return {conflicts, syncGap}
}

/** Definitions named in the refusal before it summarizes the rest. Enough to
 *  recognize what is at stake without printing a 768-row graph's worth. */
const NAMED_DEFINITION_LIMIT = 10

const describeDefinitions = (conflict: PresetIdentityConflict): string => {
  if (conflict.definitions.length === 0) {
    return 'No definition block in this workspace uses it'
  }
  const named = conflict.definitions.slice(0, NAMED_DEFINITION_LIMIT)
    .map(definition => `${definition.name} (${definition.cells} cells)`)
  const rest = conflict.definitions.length - named.length
  return `${conflict.definitions.length} definition block(s), ${conflict.cells} cells: `
    + named.join(', ')
    + (rest > 0 ? `, and ${rest} more` : '')
}

/** The refusal an install raises. Facts first — what moved, what is stored
 *  under it here — then the ways out, because every one of them is a decision
 *  about data this cannot make. */
export const presetIdentityRefusal = (
  scan: PresetIdentityScan,
  extensionName: string,
  workspaceId: string,
): string => {
  const {conflicts, syncGap} = scan
  const blocks = conflicts.map(conflict => {
    const lines = [
      `preset ${JSON.stringify(conflict.presetId)}:`,
      ...conflict.differences.map(difference => `    ${difference}`),
      `    ${describeDefinitions(conflict)}`,
    ]
    if (conflict.seedNames.length > 0) {
      lines.push(`    declared by seed(s): ${conflict.seedNames.join(', ')}`)
    }
    if (conflict.replacesKernelCore) {
      lines.push('    this id is a KERNEL preset — the replacement applies app-wide, '
        + 'to definitions this extension did not create')
    }
    return lines.join('\n  ')
  })

  return [
    `install-extension: refusing to install ${extensionName} — it changes which codec a `
      + 'value preset id resolves to, and values are already stored under the current one.',
    ...blocks.map(block => `  ${block}`),
    `Counts are this device's live blocks in workspace ${workspaceId}; other workspaces, `
      + 'tombstones, and rows this device has not synced are not counted.'
      + (syncGap === null ? '' : ` This device's view is incomplete (${syncGap}), so they are short.`),
    'A definition block stores a preset id, never a codec, so no row changes and nothing '
      + 'migrates the values: the projector publishes the new codec on the next rebuild '
      + 'while the stored values stay in the old encoding, to be thrown on or silently '
      + 'reinterpreted.',
    'Ways out: give the new codec a NEW preset id and repoint the definitions at it '
      + '(an edit to each definition row, which core.migratePropertyDefinition does '
      + 'fan out); keep the registered codec\'s encoding; or re-run with '
      + '--allow-preset-change if the stored values are disposable.',
  ].join('\n')
}
