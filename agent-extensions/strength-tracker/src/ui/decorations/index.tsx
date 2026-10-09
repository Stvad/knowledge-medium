/** What the extension actually contributes to the outline.
 *
 *  Four augmentations on blocks the user already has, and nothing that owns
 *  state. Each is gated on the block's own types, so every other block in the
 *  workspace renders exactly as it did before the extension was installed.
 */

import {
  blockChildrenFooterFacet,
  blockContentDecoratorsFacet,
  type BlockChildrenFooterContribution,
  type BlockContentDecoratorContribution,
} from '@/extensions/blockInteraction.js'
import type {AppExtension} from '@/facets/facet.js'

import {ASSESSMENT_RESULT_TYPE, EXERCISE_ENTRY_TYPE, SET_TYPE, WORKOUT_TYPE} from '../../km/fields'
import {decorateAssessmentResult} from './AssessmentLine'
import {decorateLiftContent} from './LiftLine'
import {decorateSetContent} from './SetLine'
import {WorkoutFooter} from './WorkoutFooter'

/** Gated on `context.types` rather than inside the component, so a block that
 *  is none of ours pays for no extra render — the decorator chain is walked
 *  for every block on screen. */
const setDecorator: BlockContentDecoratorContribution = context =>
  context.types.includes(SET_TYPE) ? decorateSetContent : null

const liftDecorator: BlockContentDecoratorContribution = context =>
  context.types.includes(EXERCISE_ENTRY_TYPE) ? decorateLiftContent : null

const assessmentDecorator: BlockContentDecoratorContribution = context =>
  context.types.includes(ASSESSMENT_RESULT_TYPE) ? decorateAssessmentResult : null

const workoutFooter: BlockChildrenFooterContribution = context =>
  context.types.includes(WORKOUT_TYPE) ? WorkoutFooter : null

const source = 'strength-tracker'

export const strengthDecorations: AppExtension = [
  blockContentDecoratorsFacet.of(setDecorator, {source}),
  blockContentDecoratorsFacet.of(liftDecorator, {source}),
  blockContentDecoratorsFacet.of(assessmentDecorator, {source}),
  blockChildrenFooterFacet.of(workoutFooter, {source}),
]
