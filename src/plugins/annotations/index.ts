/** Comments and annotations: threads of comments anchored to a block, or to a
 *  quoted range of its text. A thread is an ordinary block under the
 *  workspace's `Comments (km)` page, pointing at its target through a ref
 *  property; the target is never written to. */

import type {AppExtension} from '@/facets/facet.js'
import {systemToggle} from '@/facets/togglable.js'
import {blockDeletionGuardsFacet} from '@/extensions/core.js'
import {annotationsDataExtension} from './dataExtension.ts'
import {commentsPageDeletionGuard} from './container.ts'

const SOURCE = 'annotations'

export const annotationsPlugin: AppExtension = systemToggle({
  id: 'system:annotations',
  name: 'Comments',
  description: 'Comment on a block, or on selected text in it, in threads that live beside your notes.',
}).of([
  annotationsDataExtension,
  blockDeletionGuardsFacet.of(commentsPageDeletionGuard, {source: SOURCE}),
])
