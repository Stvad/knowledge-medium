/** Reactive bridge between user-defined `'block-type'` blocks and the
 *  `typesFacet`'s `'user-data'` runtime contribution bucket
 *  (user-defined-types Phase 1). Mirrors UserSchemasService in shape:
 *  subscribe to the meta-type blocks, build TypeContribution[],
 *  publish through `repo.setRuntimeContributions`. Re-resolves when
 *  the merged propertySchemas map changes (a newly-published schema
 *  resolves a previously-dropped block-type:properties ref).
 *
 *  Deliberately narrow: NO synchronous-append / withProvisional path.
 *  See user-defined-types/design.html §Lessons from PR #50 — callers
 *  that need an in-tx dependent on a freshly-registered type use a
 *  two-tx flow (commit the type-definition block; wait for the
 *  subscription rebuild via `repo.onTypesChange`; then open the
 *  dependent tx). */

import {
  type AnyPropertySchema,
  type TypeContribution,
  type Unsubscribe,
} from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import type { UserSchemasService } from '@/data/userSchemasService'
import {
  blockTypeDescriptionProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
} from '@/data/properties'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { typesFacet } from '@/data/facets'

const USER_DATA_SOURCE_ID = 'user-data'

export class UserTypesService {
  /** Source of truth for the user-data bucket on `typesFacet`. */
  private contributions: readonly TypeContribution[] = []

  /** Maps a published type id back to the block id that materialised
   *  it. Phase 1's type-id-IS-block-id decision makes the key and the
   *  value identical for resolved contributions; the map is kept
   *  explicit so future UI surfaces (a "navigate to type definition"
   *  action) read through a stable accessor. */
  private blockIdByTypeId = new Map<string, string>()

  /** Active block-subscription disposer, set by `start()`. */
  private subscriptionDisposer: Unsubscribe | null = null

  /** Disposer for the property-schemas listener; we re-resolve when
   *  the merged schema map changes so a newly-arriving schema makes
   *  previously-dropped `block-type:properties` refs resolvable. */
  private schemasListenerDisposer: (() => void) | null = null

  /** Latest blocks list captured by the subscription. Stored so the
   *  schema-change re-resolve can run without a fresh DB read. */
  private latestBlocks: readonly Block[] = []

  constructor(
    private readonly repo: Repo,
    private readonly userSchemas: UserSchemasService,
  ) {}

  /** Look up the source block id for a published type id. Returns
   *  undefined for kernel/plugin types (no backing block) or ids
   *  that aren't user-data registered. */
  getTypeBlockId(typeId: string): string | undefined {
    return this.blockIdByTypeId.get(typeId)
  }

  start(): () => void {
    if (this.subscriptionDisposer) {
      throw new Error('[UserTypesService] already started')
    }

    // Pin the workspace at start() time, mirroring UserSchemasService.
    // The React provider restarts the service on workspace switch, so
    // capturing here pairs the subscription's lifetime to one workspace.
    const workspaceId = this.repo.activeWorkspaceId
    if (!workspaceId) {
      throw new Error('[UserTypesService] no active workspace at start()')
    }

    const rebuildFromBlocks = (blocks: readonly Block[]): void => {
      this.latestBlocks = blocks
      const next: TypeContribution[] = []
      const nextBlockIdByTypeId = new Map<string, string>()
      for (const block of blocks) {
        const built = this.tryBuildType(block)
        if (built) {
          next.push(built)
          nextBlockIdByTypeId.set(built.id, block.id)
        }
      }
      // The propertySchemas rebuild step in Repo notifies BOTH
      // propertySchemasListeners AND typesListeners — they share a
      // step because mergeLiftedSchemas reads typesFacet to lift
      // properties. We listen to onPropertySchemasChange to re-resolve
      // refList entries when a new schema lands, so an unconditional
      // republish would form a feedback loop: our publish triggers the
      // step, the step fires propertySchemasListeners, we fire again.
      // Short-circuit when nothing materially changed.
      if (this.contributionsEqual(next, this.contributions)) return
      this.contributions = next
      this.blockIdByTypeId = nextBlockIdByTypeId
      this.repo.setRuntimeContributions(typesFacet, USER_DATA_SOURCE_ID, this.contributions)
    }

    this.subscriptionDisposer = this.repo.subscribeBlocks(
      {workspaceId, types: [BLOCK_TYPE_TYPE]},
      blocks => {
        // Hydrate raw rows into Block facades so we can decode through
        // peekProperty rather than poking properties_json shapes.
        rebuildFromBlocks(blocks.map(b => this.repo.block(b.id)))
      },
    )

    this.schemasListenerDisposer = this.repo.onPropertySchemasChange(() => {
      rebuildFromBlocks(this.latestBlocks)
    })

    return () => this.dispose()
  }

  dispose(): void {
    this.subscriptionDisposer?.()
    this.subscriptionDisposer = null
    this.schemasListenerDisposer?.()
    this.schemasListenerDisposer = null
  }

  /** Field-wise equality on the contribution list. Element identity
   *  isn't useful because tryBuildType creates fresh objects per
   *  rebuild; compare the load-bearing fields and check the properties
   *  array element-wise (schemas come from UserSchemasService and ARE
   *  reused across rebuilds, so reference identity is the right check
   *  there). */
  private contributionsEqual(
    a: readonly TypeContribution[],
    b: readonly TypeContribution[],
  ): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      const ac = a[i]
      const bc = b[i]
      if (ac.id !== bc.id || ac.label !== bc.label || ac.description !== bc.description) return false
      const ap = ac.properties ?? []
      const bp = bc.properties ?? []
      if (ap.length !== bp.length) return false
      for (let j = 0; j < ap.length; j++) {
        if (ap[j] !== bp[j]) return false
      }
    }
    return true
  }

  /** Build a TypeContribution from a user-authored block-type block.
   *  Returns null with a logged diagnostic when the label is empty;
   *  silently drops refList entries that don't resolve through
   *  `UserSchemasService.getSchemaForBlockId` (those will fill in on
   *  the next `onPropertySchemasChange` tick when the missing schema
   *  publishes). */
  private tryBuildType(block: Block): TypeContribution | null {
    const label = block.peekProperty(blockTypeLabelProp) ?? ''
    if (!label) {
      console.warn(`[UserTypesService] block ${block.id} has empty label; skipping`)
      return null
    }
    const description = block.peekProperty(blockTypeDescriptionProp) ?? ''
    const refIds = block.peekProperty(blockTypePropertiesProp) ?? []
    const properties: AnyPropertySchema[] = []
    for (const refId of refIds) {
      const schema = this.userSchemas.getSchemaForBlockId(refId)
      if (schema) properties.push(schema)
    }
    const contribution: TypeContribution = {
      id: block.id,
      label,
      ...(description ? {description} : {}),
      properties,
    }
    return contribution
  }
}
