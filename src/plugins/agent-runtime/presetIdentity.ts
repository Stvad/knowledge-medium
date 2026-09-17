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
 * SCOPE. This compares against what is registered on THIS device right now, so
 * it sees a conflict only while the core it replaces is live: the previous
 * version of an extension that is running, a plugin's core, or a kernel one.
 * A re-install of an extension that is installed but not approved/enabled here
 * replaces nothing yet and is not flagged. That is the honest limit of an
 * install-time check — the old encoding exists nowhere in the data, only in the
 * code that is running.
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
 *  the reason it could not get there. A core that starts REFUSING a config it
 *  used to read has changed what the definition publishes just as surely as one
 *  that changes the codec's type, so both are the same kind of answer and
 *  compare as strings. */
export const presetCodecOutcome = (
  core: AnyValuePresetCore,
  storedConfig: unknown,
): string => {
  let config: unknown
  try {
    config = decodePresetConfig(core, storedConfig)
  } catch (error) {
    return `config rejected (${(error as Error).message})`
  }
  try {
    return `codec type ${JSON.stringify(core.build(config as never).type)}`
  } catch (error) {
    return `build threw (${(error as Error).message})`
  }
}

/** The stored configs a comparison must cover: every distinct one in use, plus
 *  `undefined` for the preset's own default. The default probe is what makes a
 *  workspace with no definitions yet still comparable — and it is the only
 *  probe when a preset's codec type does not vary with config, which is every
 *  preset in the tree today. */
const configsToProbe = (
  definitions: readonly DefinitionRow[],
): readonly unknown[] => {
  const seen = new Map<string, unknown>()
  seen.set('', undefined)
  for (const row of definitions) {
    const key = JSON.stringify(row.config ?? null)
    if (!seen.has(key)) seen.set(key, row.config)
  }
  return [...seen.values()]
}

/** Every way the candidate core is not interchangeable with the registered
 *  one, as refusal lines. Empty means the two publish the same encoding for
 *  every config in use — see the module docblock for what that cannot prove. */
export const presetIdentityDifferences = (
  current: AnyValuePresetCore,
  candidate: AnyValuePresetCore,
  definitions: readonly DefinitionRow[],
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
  for (const config of configsToProbe(definitions)) {
    const before = presetCodecOutcome(current, config)
    const after = presetCodecOutcome(candidate, config)
    if (before === after) continue
    const pair = `${before} -> ${after}`
    if (reported.has(pair)) continue
    reported.add(pair)
    const where = config === undefined
      ? 'at the preset default config'
      : `at stored config ${JSON.stringify(config)}`
    differences.push(`${pair} (${where})`)
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

interface DefinitionSqlRow {
  id: string
  presetId: string | null
  config: string | null
  name: string | null
}

/** `json_each(...).value` hands back JSON TEXT for an object or array cell and
 *  a plain SQLite value for a scalar. A config cell is an object, so it arrives
 *  as text that has to be parsed back; anything unparseable is treated as
 *  absent, which is what `rawPresetConfig` does with an undefined cell. */
const parseConfigCell = (raw: string | null): unknown => {
  if (raw === null) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
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
  // The LAST occurrence of each key, and the `OBJECT_BAG` guard, both for the
  // reasons `propertyKeyScan` spells out: a repeated key in a hand-written bag
  // is read by `JSON.parse` (and so by the projector) as the last one, and
  // `json_extract` RAISES on a malformed bag instead of skipping the row.
  const cell = (): string =>
    `(SELECT j.value FROM json_each(${OBJECT_BAG}) j WHERE j.key = ? ORDER BY j.id DESC LIMIT 1)`
  const rows = await repo.db.getAll<DefinitionSqlRow>(
    `SELECT b.id AS id, ${cell()} AS presetId, ${cell()} AS config, ${cell()} AS name
       FROM blocks b
       JOIN block_types t ON t.block_id = b.id AND t.workspace_id = b.workspace_id
      WHERE t.type = ? AND b.workspace_id = ? AND b.deleted = 0`,
    [presetIdProp.name, presetConfigProp.name, propertyNameProp.name,
      PROPERTY_SCHEMA_TYPE, workspaceId],
  )
  return rows.flatMap(row => typeof row.presetId === 'string' && row.presetId
    ? [{
        fieldId: row.id,
        presetId: row.presetId,
        config: parseConfigCell(row.config),
        storedName: typeof row.name === 'string' ? row.name : '',
      }]
    : [])
}

/** Live blocks carrying a cell under each of `names`. */
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
        AND j.key IN (${names.map(() => '?').join(',')})
      GROUP BY j.key`,
    [workspaceId, ...names],
  )
  return new Map(rows.map(row => [String(row.property ?? ''), row.cells]))
}

/**
 * Which of `candidates` re-type data already stored under their preset id.
 *
 * `candidates` is what the extension being installed contributes to
 * `valuePresetCoresFacet`; the comparison is against `repo.valuePresetCores`,
 * the map every projector rebuild resolves definitions through.
 */
export const findPresetIdentityConflicts = async (
  repo: Repo,
  workspaceId: string,
  candidates: readonly AnyValuePresetCore[],
): Promise<PresetIdentityConflict[]> => {
  const registered = repo.valuePresetCores
  // Identity, not just presence: an extension that re-exports the core it
  // imported (from the kernel, or from a plugin through the page importmap)
  // contributes the SAME object, which cannot have changed behaviour.
  const contested = candidates.filter(core => {
    const current = registered.get(core.id)
    return current !== undefined && current !== core
  })
  if (contested.length === 0) return []

  const definitionRows = await readDefinitionRows(repo, workspaceId)
  const registry = repo.propertyDefinitions?.workspaceId === workspaceId
    ? repo.propertyDefinitions
    : null

  const conflicts: PresetIdentityConflict[] = []
  for (const candidate of contested) {
    const current = registered.get(candidate.id)!
    const rows = definitionRows.filter(row => row.presetId === candidate.id)
    const differences = presetIdentityDifferences(current, candidate, rows)
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

    const seedNames = [...(registry?.seedsByKey.values() ?? [])]
      .filter(seed => seed.presetId === candidate.id)
      .map(seed => seed.name)
      .sort()

    conflicts.push({
      presetId: candidate.id,
      differences,
      definitions,
      cells,
      seedNames,
      replacesKernelCore: Object.hasOwn(kernelValuePresetCoresById, candidate.id),
    })
  }
  return conflicts
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
  conflicts: readonly PresetIdentityConflict[],
  extensionName: string,
  workspaceId: string,
): string => {
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
    `install-extension: refusing to install ${extensionName} — it registers a value preset `
      + 'whose codec differs from the one currently registered under the same id.',
    ...blocks.map(block => `  ${block}`),
    `Counts are this device's live blocks in workspace ${workspaceId}; other workspaces, `
      + 'tombstones, and rows this device has not synced are not counted.',
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
