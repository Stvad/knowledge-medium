// The data extensions whose types the tutorial's demos tag themselves with. A
// focused list — NOT the full `staticDataExtensions` — so a seed in a test
// doesn't register the references/alias post-commit processors, which fire
// async and would make transaction counts racy. `seed.test.ts` guards that
// production's `staticDataExtensions` registers the same types.

import { annotationsDataExtension } from '@/plugins/annotations/dataExtension'
import { characterCounterDataExtension } from '@/plugins/character-counter/dataExtension'
import { geoDataExtension } from '@/plugins/geo/dataExtension'
import { htmlDocumentDataExtension } from '@/plugins/html-document/dataExtension'
import { srsReschedulingDataExtension } from '@/plugins/srs-rescheduling/dataExtension'
import { todoDataExtension } from '@/plugins/todo/dataExtension'

export const TUTORIAL_TYPE_EXTENSIONS = [
  todoDataExtension,
  characterCounterDataExtension,
  srsReschedulingDataExtension,
  geoDataExtension,
  htmlDocumentDataExtension,
  annotationsDataExtension,
]
