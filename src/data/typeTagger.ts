/**
 * Type-tagging engine (data-layer redesign spec §3 type API). Owns the
 * add / remove / toggle / set-types write logic that maintains a block's
 * `types` property plus the type's initial-value seeding. Extracted from
 * `Repo` (audit D1(b)) so the logic is unit-testable against a minimal
 * host rather than a full Repo; `Repo` keeps spec-pinned delegating
 * methods over a single `TypeTagger` instance.
 *
 * The four public variants exist for distinct call shapes:
 *   - `addType` / `removeType` / `toggleType` / `setBlockTypes` open their
 *     own `repo.tx`.
 *   - `addTypeInTx` (strict) / `addTypeInTxLenient` / `removeTypeInTx`
 *     compose inside a caller's existing tx.
 * Strict throws `BlockNotFoundForTypeError` when the target is missing /
 * tombstoned; lenient silently no-ops (sync-apply / processor paths that
 * may race a concurrent delete).
 */

import type {
  AnyPropertySchema,
  PropertySchema,
  RepoTxOptions,
  Tx,
  TypeContribution,
  TypeRegistrySnapshot,
} from '@/data/api'
import { BlockNotFoundForTypeError, ChangeScope } from '@/data/api'
import { typesProp } from './properties'

/** The slice of `Repo` the tagger needs: a tx primitive, the live type +
 *  schema registries, and a snapshot accessor for the own-tx entry
 *  points. `Repo` satisfies this structurally. */
export interface TypeTaggerHost {
  tx<R>(fn: (tx: Tx) => Promise<R>, opts: RepoTxOptions): Promise<R>
  snapshotTypeRegistries(): TypeRegistrySnapshot
  readonly types: ReadonlyMap<string, TypeContribution>
  readonly propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}

const requireTypeContribution = (
  types: ReadonlyMap<string, TypeContribution>,
  typeId: string,
): TypeContribution => {
  const contribution = types.get(typeId)
  if (contribution !== undefined) return contribution
  throw new Error(
    `[addType] type id ${JSON.stringify(typeId)} is not registered. ` +
    'Register a type seed (seedType) through typeSeedsFacet before calling addType.',
  )
}

const hasStoredProperty = (properties: Record<string, unknown>, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(properties, name)

const readResolvedProperty = <T>(
  properties: Record<string, unknown>,
  schema: PropertySchema<T>,
): T => hasStoredProperty(properties, schema.name)
  ? schema.codec.decode(properties[schema.name])
  : schema.defaultValue

// Property-bag writes in this class stay RAW (`tx.update`) rather than routing
// through `tx.setProperty` / `tx.setProperties`, and that is correct on a
// flipped (child-backed) workspace (PR #288 props-bag audit, verified). Every
// write here is a net ADD or CHANGE of the registered `typesProp` — plus, in
// `_addTypeInTx`, registered initial-value schemas resolved through the SAME
// identity boundary `setProperty` uses — never a set-then-unset of one key
// within a single tx, so the deferred MATERIALIZE pass reconciles the net cell
// diff into field children with no resurrection hazard (the failure mode that
// forced the primitives to delete children eagerly). `typesProp.changeScope`
// is `BlockDefault`, matching every tx opened here, so an eager `setProperty`
// would clear the same scope gate but buy nothing: on a non-flipped workspace
// (all production today) `setProperty` writes only the cell — byte-identical to
// this — and on a flipped one MATERIALIZE already creates the children. Kept
// raw to leave this widest-blast-radius helper's proven path untouched and to
// preserve `_addTypeInTx`'s only-if-empty, dual-name (caller-raw + canonical)
// initial-value contract, which `setProperties` can't express directly.
export class TypeTagger {
  constructor(private readonly host: TypeTaggerHost) {}

  private async _addTypeInTx(
    tx: Tx,
    types: ReadonlyMap<string, TypeContribution>,
    propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>>,
    /** When true (the default, used by `addType` / `addTypeInTx`), throw
     *  `BlockNotFoundForTypeError` if the target block is missing or
     *  tombstoned. Lenient callers (`addTypeInTxLenient`) pass `false`
     *  to preserve the legacy silent-no-op behavior for sync-apply /
     *  processor paths that may legitimately race a concurrent delete. */
    strict: boolean,
  ): Promise<void> {
    const contribution = requireTypeContribution(types, typeId)
    const block = await tx.get(blockId)
    if (!block) {
      if (strict) throw new BlockNotFoundForTypeError(blockId, typeId, 'missing')
      return
    }
    if (block.deleted) {
      if (strict) throw new BlockNotFoundForTypeError(blockId, typeId, 'tombstoned')
      return
    }

    // Resolve before decoding: a shadowing winner may use an incompatible
    // codec, and this write path must reject through the identity boundary
    // rather than attempting to interpret the winner's cell as membership.
    const resolvedTypes = await tx.resolvePropertySchema(blockId, typesProp)
    const current = readResolvedProperty(block.properties, resolvedTypes)
    const wasNew = !current.includes(typeId)
    const next: Record<string, unknown> = {...block.properties}
    let propsChanged = false

    if (wasNew) {
      next[resolvedTypes.name] = resolvedTypes.codec.encode([...current, typeId])
      propsChanged = true
    }

    const entries = Object.entries(initialValues)
    const declaredSchemas = entries.length === 0
      ? null
      : new Map((contribution.properties ?? []).map(schema => [schema.name, schema] as const))
    for (const [name, value] of entries) {
      // Preserve the legacy only-if-empty contract for the caller's raw key.
      // After resolution, repeat it for the canonical key; `hasOwnProperty`
      // treats an explicitly stored null as present even when an optional codec
      // would decode that value to undefined.
      if (hasStoredProperty(block.properties, name)) continue
      const schema = declaredSchemas?.get(name) ?? propertySchemas.get(name)
      if (schema === undefined) {
        throw new Error(
          `[addType] initialValues[${JSON.stringify(name)}] has no registered PropertySchema ` +
          'in the merged registry.',
        )
      }
      const resolved = await tx.resolvePropertySchema(blockId, schema)
      if (hasStoredProperty(next, resolved.name)) continue
      next[resolved.name] = resolved.codec.encode(value)
      propsChanged = true
    }

    if (propsChanged) {
      await tx.update(blockId, {properties: next})
    }
  }

  private async _removeTypeInTx(tx: Tx, blockId: string, typeId: string): Promise<void> {
    const block = await tx.get(blockId)
    if (!block) return
    const resolvedTypes = await tx.resolvePropertySchema(blockId, typesProp)
    const current = readResolvedProperty(block.properties, resolvedTypes)
    if (!current.includes(typeId)) return
    const next = {
      ...block.properties,
      [resolvedTypes.name]: resolvedTypes.codec.encode(current.filter(t => t !== typeId)),
    }
    await tx.update(blockId, {properties: next})
  }

  /** Strict: throws `BlockNotFoundForTypeError` if `blockId` is missing
   *  or tombstoned at write time. Use when the caller's correctness
   *  depends on the tag actually landing (orchestration / fan-out
   *  paths). For the lenient variant that silently no-ops on a missing
   *  block, see `addTypeInTxLenient` and (in-tx) the dedicated lenient
   *  entry points. */
  async addType(
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const {types, propertySchemas} = this.host.snapshotTypeRegistries()
    await this.host.tx(async tx => {
      await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues, true)
    }, {scope: ChangeScope.BlockDefault, description: `addType ${typeId}`})
  }

  /** Strict in-tx variant. Throws `BlockNotFoundForTypeError` if the
   *  target block is missing or tombstoned. The default for orchestration
   *  code; pair with the lenient variant only when racing a concurrent
   *  delete is legitimate (sync-apply / processor paths). */
  async addTypeInTx(
    tx: Tx,
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
    snapshot?: TypeRegistrySnapshot,
  ): Promise<void> {
    const types = snapshot?.types ?? this.host.types
    const propertySchemas = snapshot?.propertySchemas ?? this.host.propertySchemas
    await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues, true)
  }

  /** Lenient in-tx variant — silently no-ops if the target block is
   *  missing or tombstoned. Reserved for sync-apply / processor paths
   *  that may legitimately observe a concurrent delete between
   *  pre-tx state and tx-start. New orchestration code should prefer
   *  `addTypeInTx` (strict) so a footgun like the Roam-isa adoption
   *  bug (PR #47) can't be expressed. */
  async addTypeInTxLenient(
    tx: Tx,
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
    snapshot?: TypeRegistrySnapshot,
  ): Promise<void> {
    const types = snapshot?.types ?? this.host.types
    const propertySchemas = snapshot?.propertySchemas ?? this.host.propertySchemas
    await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues, false)
  }

  async removeType(blockId: string, typeId: string): Promise<void> {
    await this.host.tx(async tx => {
      await this._removeTypeInTx(tx, blockId, typeId)
    }, {scope: ChangeScope.BlockDefault, description: `removeType ${typeId}`})
  }

  async removeTypeInTx(tx: Tx, blockId: string, typeId: string): Promise<void> {
    await this._removeTypeInTx(tx, blockId, typeId)
  }

  async toggleType(blockId: string, typeId: string): Promise<void> {
    const {types, propertySchemas} = this.host.snapshotTypeRegistries()
    await this.host.tx(async tx => {
      const block = await tx.get(blockId)
      // toggleType pre-checks the block existence itself; if it's
      // missing or tombstoned here, the no-op is intentional (this is a
      // UI/UX entry point, not orchestration). Pass strict=false to
      // `_addTypeInTx` so the pre-check stays the single source of
      // truth for the missing-block branch.
      if (!block || block.deleted) return
      const resolvedTypes = await tx.resolvePropertySchema(blockId, typesProp)
      if (readResolvedProperty(block.properties, resolvedTypes).includes(typeId)) {
        await this._removeTypeInTx(tx, blockId, typeId)
      } else {
        await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, {}, false)
      }
    }, {scope: ChangeScope.BlockDefault, description: `toggleType ${typeId}`})
  }

  async setBlockTypes(blockId: string, typeIds: readonly string[]): Promise<void> {
    const desiredOrder = Array.from(new Set(typeIds))
    const {types} = this.host.snapshotTypeRegistries()
    await this.host.tx(async tx => {
      const block = await tx.get(blockId)
      // Pre-check matches toggleType's contract — silently no-op on a
      // missing/tombstoned target (UI-driven path); pass strict=false
      // to the inner add so the pre-check remains authoritative.
      if (!block || block.deleted) return

      const resolvedTypes = await tx.resolvePropertySchema(blockId, typesProp)
      const current = readResolvedProperty(block.properties, resolvedTypes)
      const currentSet = new Set(current)
      for (const typeId of desiredOrder) {
        if (currentSet.has(typeId)) continue
        requireTypeContribution(types, typeId)
      }
      const alreadyOrdered =
        current.length === desiredOrder.length &&
        current.every((typeId, index) => typeId === desiredOrder[index])
      if (alreadyOrdered) return
      await tx.update(blockId, {
        properties: {
          ...block.properties,
          [resolvedTypes.name]: resolvedTypes.codec.encode(desiredOrder),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'setBlockTypes'})
  }
}
