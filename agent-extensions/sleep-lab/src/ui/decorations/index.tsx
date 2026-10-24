/** What the extension contributes to the outline: a check-in row under each
 *  night, a "taken now" button under each dose, and a progress/stamp footer
 *  under each experiment. Gated on the block's own types, so every other
 *  block in the workspace renders exactly as it did before the extension was
 *  installed.
 *
 *  The `cachedContentDecorator` wrapping happens HERE rather than inside
 *  `NightLine`/`DoseLine` themselves, so those modules stay renderable in a
 *  unit test without also needing a runtime for `@/extensions/blockInteraction.js`
 *  — see `NightLine`'s doc comment. `ExperimentFooter` needs no such wrapping
 *  — `blockChildrenFooterFacet` takes a plain renderer, not a decorator — but
 *  is still exported raw for the same testability reason.
 */
import {
  blockChildrenFooterFacet, blockContentDecoratorsFacet, cachedContentDecorator,
  type BlockChildrenFooterContribution, type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type {AppExtension} from '@/facets/facet.js'

import {DOSE_TYPE, EXPERIMENT_TYPE, NIGHT_TYPE} from '../../km/fields'
import {DoseLine} from './DoseLine'
import {ExperimentFooter} from './ExperimentFooter'
import {NightLine} from './NightLine'

const decorateNightContent = cachedContentDecorator(NightLine, 'SleepLabNightLine')
const decorateDoseContent = cachedContentDecorator(DoseLine, 'SleepLabDoseLine')

const nightDecorator: BlockContentDecoratorContribution = context =>
  context.types.includes(NIGHT_TYPE) ? decorateNightContent : null

const doseDecorator: BlockContentDecoratorContribution = context =>
  context.types.includes(DOSE_TYPE) ? decorateDoseContent : null

const experimentFooter: BlockChildrenFooterContribution = context =>
  context.types.includes(EXPERIMENT_TYPE) ? ExperimentFooter : null

const source = 'sleep-lab'

export const sleepLabDecorations: AppExtension = [
  blockContentDecoratorsFacet.of(nightDecorator, {source}),
  blockContentDecoratorsFacet.of(doseDecorator, {source}),
  blockChildrenFooterFacet.of(experimentFooter, {source}),
]
