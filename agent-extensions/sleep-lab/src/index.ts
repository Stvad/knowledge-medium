/** Sleep Lab — N-of-1 sleep experiments on top of the outline.
 *
 *  The extension augments the outline (a check-in row under each night, a
 *  "taken now" button under each dose) and contributes one page renderer for
 *  the dashboard, plus the four global commands the README documents. The
 *  schedule/derivation/statistics engine and the import parsers are pure and
 *  unit-tested; this file is only wiring — modelled on the Strength
 *  Tracker's `src/index.ts`.
 */
import {actionsFacet, blockRenderersFacet} from '@/extensions/core.js'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets.js'
import {dialogAppMountExtension} from '@/extensions/dialogAppMount.js'

import {SLEEPLAB_PROPS, SLEEPLAB_TYPES} from './km/schema'
import {importAction, lastNightAction, openLabAction, tonightAction} from './ui/actions'
import {sleepLabDecorations} from './ui/decorations'
import {LabPageRenderer} from './ui/LabPageRenderer'

const source = 'sleep-lab'

export default [
  dialogAppMountExtension,

  ...SLEEPLAB_PROPS.map(prop => definitionSeedsFacet.of(prop, {source})),
  ...SLEEPLAB_TYPES.map(type => typeSeedsFacet.of(type, {source})),

  sleepLabDecorations,
  blockRenderersFacet.of({id: 'sleepLab', renderer: LabPageRenderer}, {source}),

  actionsFacet.of(openLabAction, {source}),
  actionsFacet.of(tonightAction, {source}),
  actionsFacet.of(lastNightAction, {source}),
  actionsFacet.of(importAction, {source}),
]
