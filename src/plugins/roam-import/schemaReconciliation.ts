/** Phase 4 of the Roam import: every imported `key:: value` attribute
 *  becomes a registered property schema instead of an unschemaed JSON
 *  blob. See user-defined-properties.md §8.
 *
 *  Classification rules (sampled across all planned blocks):
 *    - all values are `[[…]]` page tokens          → 'refList' preset
 *    - all values are finite numbers               → 'number' preset
 *    - all values are true/false                   → 'boolean' preset
 *    - mixed string scalars + string arrays         → 'list' preset
 *    - otherwise                                   → 'string' preset
 *
 *  refList classification is paired with `normalizeRefPropertyValues`
 *  which walks every planned block and converts `[[X]]` token strings
 *  into id arrays (resolved via the importer's aliasIdMap). Without
 *  this normalization, the refList codec's `decode(string[])` would
 *  reject the raw token strings on first read.
 */

import type { AnyPropertySchema, BlockData } from '@/data/api'
import type { Repo } from '@/data/repo'
import { resolveEditorOverride } from '@/data/propertyDefinitionRegistry'
import {
  propertyCellValueRejection,
  type PropertyCellValueRejection,
} from '@/data/propertyChildren'
import {
  ROAM_PAGE_ALIAS_PROP,
  collectAliasesFromRoamSemanticRefListValue,
  inferRefListTargetTypes,
  isDailyNoteAlias,
  isRoamSemanticRefListProperty,
  parsePageTokenList,
} from './properties'

type ClassifiedPresetId = 'string' | 'number' | 'boolean' | 'list' | 'refList'

interface SampledNameStats {
  totalValues: number
  numbers: number
  booleans: number
  /** Strings that parse as a pure page-token list (`[[X]]`,
   *  `[[X]] [[Y]]`, `[[X]], [[Y]]` — see `isPageTokenListValue`). */
  pageTokenStrings: number
  /** Array values that contain only page-token strings (the explosion
   *  path in `propertiesFromRoam` already produces these). */
  pageTokenArrays: number
  /** Array values whose items are plain strings (no `[[X]]` wrapping).
   *  These map to the `list` preset, not `refList`, since the strings
   *  aren't aliases to resolve — we keep them as-is in the value. */
  plainStringArrays: number
  /** Scalar strings that are not pure `[[X]]` token lists. If these
   *  appear alongside plainStringArrays, the field is a string-list
   *  property whose scalar cases need one-item-array normalization. */
  plainStrings: number
  /** Token aliases extracted from every pure-token value seen — feeds
   *  `inferRefListTargetTypes` so a property whose targets are all
   *  daily notes lands on `targetTypes: ['daily-note']` and shows up
   *  with the date filter affordance in the backlinks UI. */
  refListTokensTotal: number
  refListTokensDailyNote: number
  nonRefListSamples: Array<{blockRef: string; value: string}>
}

const SCHEMA_NEAR_MISS_THRESHOLD = 0.85
const SCHEMA_NEAR_MISS_MIN_VALUES = 10

const formatSampleValue = (value: unknown): string => {
  let formatted: string
  try {
    const json = JSON.stringify(value)
    formatted = json === undefined ? String(value) : json
  } catch {
    formatted = String(value)
  }
  const normalized = formatted.replace(/\s+/g, ' ').trim()
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized
}

const rememberNonRefListSample = (
  stats: SampledNameStats,
  blockId: string,
  value: unknown,
): void => {
  stats.nonRefListSamples.push({blockRef: `((${blockId}))`, value: formatSampleValue(value)})
}

const isPureTokenString = (value: string): boolean => {
  return parsePageTokenList(value) !== null
}

const tallyTokens = (stats: SampledNameStats, value: string): void => {
  const tokens = parsePageTokenList(value)
  if (!tokens) return
  for (const {alias} of tokens) {
    stats.refListTokensTotal += 1
    if (isDailyNoteAlias(alias)) stats.refListTokensDailyNote += 1
  }
}

const recordSample = (stats: SampledNameStats, blockId: string, value: unknown): void => {
  stats.totalValues += 1
  if (typeof value === 'number' && Number.isFinite(value)) {
    stats.numbers += 1
    rememberNonRefListSample(stats, blockId, value)
    return
  }
  if (typeof value === 'boolean') {
    stats.booleans += 1
    rememberNonRefListSample(stats, blockId, value)
    return
  }
  if (typeof value === 'string' && isPureTokenString(value)) {
    stats.pageTokenStrings += 1
    tallyTokens(stats, value)
    return
  }
  if (typeof value === 'string') {
    stats.plainStrings += 1
    rememberNonRefListSample(stats, blockId, value)
    return
  }
  if (Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string')) {
    if (value.every(item => isPureTokenString(item as string))) {
      stats.pageTokenArrays += 1
      for (const item of value as string[]) tallyTokens(stats, item)
    } else {
      stats.plainStringArrays += 1
      rememberNonRefListSample(stats, blockId, value)
    }
    return
  }
  rememberNonRefListSample(stats, blockId, value)
}

const classify = (stats: SampledNameStats): ClassifiedPresetId => {
  if (stats.totalValues === 0) return 'string'
  if (stats.numbers === stats.totalValues) return 'number'
  if (stats.booleans === stats.totalValues) return 'boolean'
  if (stats.pageTokenStrings + stats.pageTokenArrays === stats.totalValues) return 'refList'
  // Pure scalar strings remain 'string'. Once any value is a plain
  // string-array, though, the property is structurally a list; scalar
  // string cases are normalized to one-item arrays before writing.
  const plainTextValues = stats.plainStrings + stats.plainStringArrays
  if (stats.plainStringArrays > 0 && plainTextValues === stats.totalValues) return 'list'
  return 'string'
}

const schemaNearMissDiagnostic = (
  name: string,
  stats: SampledNameStats,
  effectivePreset: string,
  schemaSource: 'existing' | 'inferred',
): string | null => {
  if (stats.totalValues < SCHEMA_NEAR_MISS_MIN_VALUES) return null
  if (effectivePreset !== 'string' && effectivePreset !== 'list') return null

  const refListLike = stats.pageTokenStrings + stats.pageTokenArrays
  if (refListLike === 0 || refListLike === stats.totalValues) return null
  const ratio = refListLike / stats.totalValues
  if (ratio < SCHEMA_NEAR_MISS_THRESHOLD) return null

  const sourceLabel = schemaSource === 'existing'
    ? `uses existing ${effectivePreset} schema`
    : `inferred ${effectivePreset}`
  const percent = Math.round(ratio * 100)
  const nonRefListValues = stats.totalValues - refListLike
  const samples = stats.nonRefListSamples.length > 0
    ? ` Misses: ${stats.nonRefListSamples
      .map(sample => `${sample.blockRef}=${sample.value}`)
      .join('; ')}.`
    : ''
  return (
    `Schema inference near-miss: property "${name}" ${sourceLabel}, but ` +
    `${refListLike}/${stats.totalValues} values (${percent}%) looked like refList; ` +
    `${nonRefListValues} non-refList value(s) kept it from refList.${samples}`
  )
}

/** Plan-time reconciliation: collect every property name appearing on
 *  any planned block, skip kernel/plugin/already-registered names and
 *  hidden reserved slots, classify the rest by sampling values across
 *  the planned set, and produce a list of {name, presetId} pairs to
 *  register before the import writes content. */
export interface ReconciliationRegistration {
  readonly name: string
  readonly presetId: ClassifiedPresetId
  /** Inferred when every observed token alias resolves to a single known
   *  target type (currently only daily-note). Omitted otherwise — the
   *  schema lands with no `targetTypes` constraint and the user can
   *  refine via `RefTargetTypePicker`. */
  readonly targetTypes?: readonly string[]
}

export const collectSchemaReconciliationPlan = (
  blocks: ReadonlyArray<BlockData>,
  repo: Repo,
): {
  toRegister: ReadonlyArray<ReconciliationRegistration>
  skippedReserved: ReadonlyArray<string>
  diagnostics: ReadonlyArray<string>
} => {
  const sampler = new Map<string, SampledNameStats>()

  for (const block of blocks) {
    if (!block.properties) continue
    for (const [name, value] of Object.entries(block.properties)) {
      const stats = sampler.get(name) ?? {
        totalValues: 0,
        numbers: 0,
        booleans: 0,
        pageTokenStrings: 0,
        pageTokenArrays: 0,
        plainStringArrays: 0,
        plainStrings: 0,
        refListTokensTotal: 0,
        refListTokensDailyNote: 0,
        nonRefListSamples: [],
      }
      recordSample(stats, block.id, value)
      sampler.set(name, stats)
    }
  }

  const toRegister: ReconciliationRegistration[] = []
  const skippedReserved: string[] = []
  const diagnostics: string[] = []

  const schemas = repo.propertySchemas
  const overrides = repo.propertyEditorOverrides

  for (const [name, stats] of sampler) {
    const inferredPreset = isRoamSemanticRefListProperty(name) ? 'refList' : classify(stats)
    const existingSchema = schemas.get(name)

    // Already registered — kernel, plugin, type-lifted, or pre-existing
    // user schema. The §3 hybrid rule wants vocabulary shared, so any
    // existing schema wins.
    if (existingSchema) {
      const diagnostic = schemaNearMissDiagnostic(name, stats, existingSchema.codec.type, 'existing')
      if (diagnostic) diagnostics.push(diagnostic)
      continue
    }

    // Reserved kernel-internal slot (per §6 collision rule). The override
    // join is by seed identity (B′ §8), so a `hidden` override is matched
    // through the name's winning definition rather than by raw name.
    if (resolveEditorOverride(name, repo.propertyDefinitions, overrides, existingSchema)?.hidden === true) {
      skippedReserved.push(name)
      continue
    }

    const diagnostic = schemaNearMissDiagnostic(name, stats, inferredPreset, 'inferred')
    if (diagnostic) diagnostics.push(diagnostic)

    const targetTypes = inferredPreset === 'refList'
      ? inferRefListTargetTypes({
        total: stats.refListTokensTotal,
        dailyNote: stats.refListTokensDailyNote,
      })
      : undefined

    toRegister.push(
      targetTypes ? {name, presetId: inferredPreset, targetTypes} : {name, presetId: inferredPreset},
    )
  }

  return {toRegister, skippedReserved, diagnostics}
}

/** Apply phase: register every classified schema synchronously through
 *  `userSchemas.addSchema`. Each call persists a property-schema block
 *  under the workspace's Properties page AND adds the runtime
 *  contribution before content blocks are written. Failures are
 *  logged into `diagnostics` and the schema is skipped — content blocks
 *  whose property values use the missing schema fall through to the
 *  unknown-schema read fallback (per §9). */
export const applySchemaReconciliation = async (
  toRegister: ReadonlyArray<ReconciliationRegistration>,
  repo: Repo,
  diagnostics: string[],
): Promise<void> => {
  for (const entry of toRegister) {
    const {name, presetId} = entry
    const config = entry.targetTypes ? {targetTypes: entry.targetTypes} : undefined
    try {
      await repo.userSchemas.addSchema({name, presetId, config})
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      diagnostics.push(`Failed to register schema "${name}" (preset ${presetId}): ${message}`)
    }
  }
}

const jsonStringify = (value: unknown): string => {
  try {
    const json = JSON.stringify(value)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

/** The ONE reshaping rule, by codec type: how a promoted value that does not
 *  fit its codec is made to fit, where a fit is reachable at all.
 *
 *  Two cases only, and both exist because promotion's own shape (scalar for a
 *  single occurrence, array for repeated/child-list ones) is per BLOCK while a
 *  definition is per NAME. Nothing here can make text a number or a name an
 *  id — those keys are declined at promotion instead (`acceptValue`).
 *
 *  Every reshaping caller routes through this: the two name-set passes below,
 *  which the importer drives off its own classification, and
 *  {@link fitPromotedValueToSchema}, which the streaming path drives off the
 *  effective registry. A second copy would be a rule that reshapes one way at
 *  plan time and another at write time. */
const reshapeForCodecType = (codecType: string, value: unknown): unknown => {
  if (codecType === 'string' && typeof value !== 'string') return jsonStringify(value)
  if (codecType === 'list' && !Array.isArray(value)) return [value]
  return value
}

/** Can `schema` carry `value`, after the reshaping that is available to it?
 *
 *  `fits` carries the value to STORE, which may differ from the one passed in.
 *  `unfit` means no reshaping helps: post-flip the materialize processor
 *  rejects a write of it and rolls the whole transaction back, so a producer
 *  asks this BEFORE the write and declines the key instead (#594).
 *
 *  The acceptance half is `propertyCellValueRejection` — the same function the
 *  processor rejects with, deliberately, rather than a decode of our own that
 *  could come to disagree with it. */
export type PromotedValueFit =
  | {readonly kind: 'fits'; readonly value: unknown}
  | {readonly kind: 'unfit'; readonly rejection: PropertyCellValueRejection}

export const fitPromotedValueToSchema = (
  schema: AnyPropertySchema,
  value: unknown,
): PromotedValueFit => {
  const reshaped = reshapeForCodecType(schema.codec.type, value)
  const rejection = propertyCellValueRejection(schema, reshaped)
  return rejection ? {kind: 'unfit', rejection} : {kind: 'fits', value: reshaped}
}

/** String-schema normalization for mixed Roam attributes. Some Roam
 *  fields are scalar on most pages but multi-value arrays on a few
 *  pages (`email::` with child bullets, `Twitter::` with multiple
 *  accounts, etc.). When reconciliation chooses the string preset for
 *  that mixed field, preserve the non-string JSON shape as a JSON text
 *  value so the registered string codec can decode it. */
export const normalizeStringPropertyValues = (
  blocks: ReadonlyArray<BlockData>,
  stringPropertyNames: ReadonlySet<string>,
): void => {
  if (stringPropertyNames.size === 0) return
  for (const block of blocks) {
    if (!block.properties) continue
    for (const name of stringPropertyNames) {
      if (!(name in block.properties)) continue
      block.properties[name] = reshapeForCodecType('string', block.properties[name])
    }
  }
}

/** List-schema normalization for Roam attributes. Promotion emits a
 *  scalar for single `key:: value` occurrences and an array for
 *  repeated/child-list occurrences. When schema reconciliation picks
 *  the list preset, wrap the scalar cases so every stored value matches
 *  the list codec shape instead of being rejected on decode. */
export const normalizeListPropertyValues = (
  blocks: ReadonlyArray<BlockData>,
  listPropertyNames: ReadonlySet<string>,
): void => {
  if (listPropertyNames.size === 0) return
  for (const block of blocks) {
    if (!block.properties) continue
    for (const name of listPropertyNames) {
      if (!(name in block.properties)) continue
      block.properties[name] = reshapeForCodecType('list', block.properties[name])
    }
  }
}

/** Last gate before the import writes: make every planned value fit the
 *  definition it will be stored under, and DROP the ones no reshaping fits.
 *
 *  Runs AFTER the ref/string/list normalizations, never before — those are
 *  what turn `[[X]]` tokens into ids and scalars into lists, so asking earlier
 *  would decline values that were about to become valid.
 *
 *  Dropping is the lesser loss here, and only here: the importer's promotion
 *  is ADDITIVE, so an attribute's `key:: value` bullet survives as an ordinary
 *  block whatever happens to the property. Post-flip the alternative is not
 *  "store it anyway" but a processor rejection that aborts the whole batch, so
 *  the choice is a reported per-value skip against a failed import.
 *
 *  A name with no registered definition is left ALONE: nothing is known about
 *  what would fit, and property migration skips such keys rather than
 *  rejecting them. That is also what makes this safe in a dry run, where no
 *  definition has been registered yet. */
export const dropPlannedValuesThatCannotBeStored = (
  blocks: ReadonlyArray<BlockData>,
  repo: Repo,
  diagnostics: string[],
): void => {
  for (const block of blocks) {
    if (!block.properties) continue
    for (const name of Object.keys(block.properties)) {
      const schema = repo.propertySchemas.get(name)
      if (!schema) continue
      const fit = fitPromotedValueToSchema(schema, block.properties[name])
      if (fit.kind === 'fits') {
        block.properties[name] = fit.value
        continue
      }
      diagnostics.push(
        `Block ${block.id}: dropped property "${name}" — its "${schema.codec.type}" definition ` +
        `cannot hold ${formatSampleValue(block.properties[name])}. The source text is kept on ` +
        'the block; widen or correct that definition and re-import to store it.',
      )
      delete block.properties[name]
    }
  }
}

/** Token-→-id normalization for ref/refList-typed properties. Walks
 *  every planned block and, for each property whose name is in
 *  `refPropertyKinds`, converts `[[X]]` token strings/arrays into the
 *  shape the codec expects:
 *    - `'ref'`     → first resolved id (single string), or empty
 *                    string when nothing resolves.
 *    - `'refList'` → array of resolved ids (any order, drops
 *                    unresolved ones).
 *
 *  Without this pass the codec's `decode` would reject the raw token
 *  shape on first read. Tokens we can't resolve are reported through
 *  `diagnostics` so the user can fix dangling references later. */
export const normalizeRefPropertyValues = (
  blocks: ReadonlyArray<BlockData>,
  refPropertyKinds: ReadonlyMap<string, 'ref' | 'refList'>,
  aliasIdMap: ReadonlyMap<string, string>,
  diagnostics: string[],
): void => {
  if (refPropertyKinds.size === 0) return
  for (const block of blocks) {
    if (!block.properties) continue
    for (const [name, kind] of refPropertyKinds) {
      if (!(name in block.properties)) continue
      const raw = block.properties[name]
      const plainAliasMode = name === ROAM_PAGE_ALIAS_PROP ? 'conservative' : 'broad'
      const tokens = isRoamSemanticRefListProperty(name)
        ? collectAliasesFromRoamSemanticRefListValue(raw, plainAliasMode)
        : collectTokens(raw)
      if (tokens === null) continue

      const ids: string[] = []
      const dangling: string[] = []
      for (const alias of tokens) {
        const id = aliasIdMap.get(alias)
        if (id) ids.push(id)
        else dangling.push(alias)
      }
      if (dangling.length > 0) {
        diagnostics.push(
          `Block ${block.id}: ${kind} property "${name}" has unresolved aliases: ${dangling.join(', ')}`,
        )
      }
      if (kind === 'ref') {
        // Roam refs typically carry one alias; if a value happens to
        // hold multiple, take the first and report the rest. The
        // ref codec stores a single id; defaultValue '' represents
        // "no ref resolved".
        if (ids.length > 1) {
          diagnostics.push(
            `Block ${block.id}: ref property "${name}" had ${ids.length} aliases; keeping the first`,
          )
        }
        block.properties[name] = ids[0] ?? ''
      } else {
        block.properties[name] = ids
      }
    }
  }
}

const collectTokens = (raw: unknown): string[] | null => {
  if (typeof raw === 'string') {
    return parsePageTokenList(raw)?.map(token => token.alias) ?? null
  }
  if (Array.isArray(raw)) {
    if (raw.length === 0) return []
    if (!raw.every(item => typeof item === 'string')) return null
    const out: string[] = []
    for (const item of raw as string[]) {
      const tokens = parsePageTokenList(item)
      if (tokens) out.push(...tokens.map(token => token.alias))
    }
    return out
  }
  return null
}

/** The minimum a caller must supply: whatever it is about to write. Kept
 *  structural so an extension can pass its own in-flight block tree. */
export interface PromotedPropertyBag {
  readonly id?: string
  properties?: Record<string, unknown>
}

/** Re-exported from the data layer so a promotion consumer has it to hand.
 *  It is the SAME function `addSchema` gates on, deliberately — a mirror here
 *  could drift and let a name through that registration then rejects, after
 *  a subtractive consumer had already dropped the source bullet. */
export { isRegistrablePropertyName } from '@/data/userSchemasService'

/** Register a definition for every promoted `key:: value` attribute a
 *  consumer is about to write, and normalize the values so the codec it
 *  registered can decode them.
 *
 *  Content promotion INVENTS property names from block text, so no code seed
 *  can declare them ahead of time — the definition has to be minted at write
 *  time or the key lands definition-less. Property migration skips a key with
 *  no schema (`propertyChildrenProcessor` — no schema, `continue`), so it is
 *  the one class of property data a child-backed workspace cannot carry, and
 *  §9 requires every key to resolve a definition before a workspace flips.
 *
 *  Preset choice is PER KEY, from the values in hand: promoted attributes are
 *  homogeneous in practice, so inference lands the useful type rather than
 *  widening every scalar into a one-item list.
 *
 *  Two known limits, both deliberate:
 *
 *  - **refList is downgraded to `list`.** The importer earns refList by
 *    building an `aliasIdMap` and rewriting `[[X]]` tokens to ids via
 *    `normalizeRefPropertyValues`. A streaming consumer has neither, so
 *    registering refList would store token strings under a codec that
 *    rejects them on read.
 *  - **Two devices meeting one new key before syncing can still disagree**
 *    if they happen to observe different shapes first; the registry keeps one
 *    definition per name, so the loser's cells would not decode. Not
 *    corrupting — the values are intact and the definition is editable — and
 *    `kmagent audit-properties` surfaces it. Converging this properly needs a
 *    deterministic definition id, which is an `addSchema` API change.
 *
 *  This does NOT delete anything from `bags`. A key it cannot register is
 *  reported and left alone: the helper cannot know whether its caller kept
 *  the source block, and a subtractive consumer would lose the text entirely.
 *  Decline such keys upstream with `isRegistrablePropertyName` instead.
 *
 *  `bags` is mutated in place by normalization, so pass the blocks you are
 *  about to write. Returns diagnostics worth logging. */
export const ensurePromotedPropertySchemas = async (
  repo: Repo,
  bags: ReadonlyArray<PromotedPropertyBag>,
): Promise<ReadonlyArray<string>> => {
  if (bags.length === 0) return []

  // The plan/normalize helpers read only `.id` and `.properties`, so a caller
  // can hand over its own in-flight tree rather than synthesizing rows.
  const names = new Set<string>()
  for (const bag of bags) for (const key of Object.keys(bag.properties ?? {})) names.add(key)

  const asBlocks = bags as unknown as ReadonlyArray<BlockData>
  const {toRegister, diagnostics} = collectSchemaReconciliationPlan(asBlocks, repo)
  const notes = [...diagnostics]

  // `addSchema` resolves the workspace itself from `repo.activeWorkspaceId`,
  // and each registration is a separate await. A switch mid-batch would put
  // the remaining definitions in the NEW workspace while the caller writes
  // its blocks to the old one — so the batch is pinned and abandoned rather
  // than half-landed somewhere else. Checking only around the whole call is
  // not enough; the window is between the keys.
  const pinnedWorkspaceId = repo.activeWorkspaceId
  const registeredNow = new Map<string, string>()
  for (const entry of toRegister) {
    if (repo.activeWorkspaceId !== pinnedWorkspaceId) {
      notes.push(
        `Stopped registering promoted properties: the active workspace changed mid-batch `
        + `(was ${String(pinnedWorkspaceId)}). Remaining keys were left unregistered.`,
      )
      break
    }
    // refList would need `normalizeRefPropertyValues` + an aliasIdMap, which
    // only the importer builds; storing tokens under it rejects them on read.
    const presetId = entry.presetId === 'refList' ? 'list' as const : entry.presetId
    const config = entry.targetTypes ? {targetTypes: entry.targetTypes} : undefined
    try {
      await repo.userSchemas.addSchema(
        config ? {name: entry.name, presetId, config} : {name: entry.name, presetId})
      registeredNow.set(entry.name, presetId)
    } catch (err) {
      notes.push(
        `Could not register promoted property ${JSON.stringify(entry.name)} `
        + `(preset ${presetId}): ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Reshape against the EFFECTIVE registry, not merely what this call
  // registered, and report in the same pass — one walk, one rule
  // (`fitPromotedValueToSchema`), so what is reshaped and what is reported
  // can never be two different answers. A value that its key's definition
  // cannot carry is not cosmetic: post-flip
  // `MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR` rejects it during the write and
  // rolls the whole transaction back — and a poll-driven caller that holds its
  // cursor on failure then retries the same event forever.
  const missing: string[] = []
  const unfit = new Set<string>()
  for (const name of names) {
    const schema = repo.propertySchemas.get(name)
    if (!schema) { missing.push(name); continue }
    for (const bag of bags) {
      const properties = bag.properties
      if (!properties || !(name in properties)) continue
      const fit = fitPromotedValueToSchema(schema, properties[name])
      if (fit.kind === 'fits') properties[name] = fit.value
      else unfit.add(name)
    }
  }
  const undecodable = [...unfit]
  if (missing.length > 0) {
    notes.push(
      `${missing.length} promoted key(s) have NO definition and will be skipped by property `
      + `migration: ${missing.map(n => JSON.stringify(n)).join(', ')}. `
      + 'Re-run once the workspace settles, or let §9 orphan synthesis pick them up; '
      + '`kmagent audit-properties` lists them.',
    )
  }
  if (undecodable.length > 0) {
    // Reshaping only reaches `string` and `list`. A key whose existing schema
    // is narrower (url, number, boolean, date…) can still receive arbitrary
    // promoted text that no reshaping fixes — and post-flip that aborts the
    // writing transaction.
    //
    // Still reported rather than enforced, because by here it is too late to
    // enforce anything: a subtractive caller has already dropped the source
    // bullet, so dropping the key would destroy the text. The refusal belongs
    // at promotion — `promotedValueAcceptorFor` — which is why what reaches
    // this note is the residue: a caller that does not decline at promotion, a
    // key that is not promoted at all, or a definition edited in the window
    // between the two.
    notes.push(
      `${undecodable.length} promoted key(s) carry a value their existing definition `
      + `cannot hold: ${undecodable.map(n => JSON.stringify(n)).join(', ')}. `
      + 'This value cannot be made to fit by reshaping; widen or correct that definition, '
      + 'or decline the key at promotion. In a child-backed workspace a write like this '
      + 'is REJECTED by the materialize processor, so it must be resolved before that '
      + 'workspace flips.',
    )
  }

  return notes
}

/** The promotion-time twin of {@link ensurePromotedPropertySchemas}: may this
 *  finalized promoted value become a property under this name?
 *
 *  Pass it as `PromotionOptions.acceptValue`. A key it rejects is withdrawn
 *  before any bullet is consumed, so the text stays where the user wrote it —
 *  which is the whole reason the check has to happen at promotion rather than
 *  at write time, where a subtractive consumer has already dropped the bullet
 *  and dropping the key would destroy the only copy.
 *
 *  A name with NO definition is ACCEPTED: `ensurePromotedPropertySchemas`
 *  mints one from the values in hand, so it fits by construction. The keys
 *  this declines are the ones whose definition already exists and is narrower
 *  than the text — a `number` that meets "many", a `ref` that meets a person's
 *  name (#594).
 *
 *  It reads the registry at promotion time, so a definition edited between
 *  here and the write is not covered; that residue lands in
 *  `ensurePromotedPropertySchemas`'s report, and post-flip in the processor's
 *  rejection. */
export const promotedValueAcceptorFor = (
  repo: Repo,
): ((propName: string, value: unknown) => boolean) => (propName, value) => {
  const schema = repo.propertySchemas.get(propName)
  if (!schema) return true
  return fitPromotedValueToSchema(schema, value).kind === 'fits'
}
