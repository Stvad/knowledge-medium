import type { AnyPropertySeedDeclaration } from '@/data/api'
import { aliasesProp, typesProp } from '@/data/properties'
import type { SeedHiddenTierTarget } from '@/data/seedHiddenTier'
import {
  mediaFilenameProp,
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
} from '@/plugins/attachments/mediaBlock'
import { attributionCreatorsProp, attributionEditorsProp } from '@/plugins/contributors/schema'
import { dailyNoteDateProp } from '@/plugins/daily-notes/schema.js'
import {
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '@/plugins/srs-rescheduling/schema'
import { roamTodoStateProp, statusProp } from '@/plugins/todo/schema'

/** The built-in definitions moved to the hidden tier because something else
 *  on the block already shows their value. Their declarations carry
 *  `hidden: true` at revision 2; `kmagent seed-hidden-tier` brings rows that
 *  workspaces materialized before that up to it. */
export const HIDDEN_TIER_SEEDS: readonly AnyPropertySeedDeclaration[] = [
  typesProp,
  aliasesProp,
  statusProp,
  roamTodoStateProp,
  dailyNoteDateProp,
  srsIntervalProp,
  srsFactorProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsGradeProp,
  srsArchivedProp,
  srsSnapshotHistoryProp,
  attributionCreatorsProp,
  attributionEditorsProp,
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
  mediaFilenameProp,
]

/** Refuses a listed seed whose declaration is no longer hidden: the pass would
 *  otherwise write `hidden: true` against its own declaration. */
export const hiddenTierTargets = (): readonly SeedHiddenTierTarget[] =>
  HIDDEN_TIER_SEEDS.map(seed => {
    if (!seed.hidden) throw new Error(`seed-hidden-tier: ${seed.seedKey} no longer declares hidden: true`)
    return {seedKey: seed.seedKey, revision: seed.revision}
  })
