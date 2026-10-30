/** Comments and annotations: threads of comments anchored to a block, or to a
 *  quoted range of its text. A thread is an ordinary block under the
 *  workspace's `Comments (km)` page, pointing at its target through a ref
 *  property; the target is never written to. */

import type {AppExtension} from '@/facets/facet.js'
import {systemToggle} from '@/facets/togglable.js'
import {actionsFacet, headerItemsFacet, panelMountsFacet} from '@/extensions/core.js'
import {
  blockChildrenFooterFacet,
  blockContentDecoratorsFacet,
  blockContentRendererFacet,
  blockContextMenuItemsFacet,
} from '@/extensions/blockInteraction.js'
import {codeMirrorExtensionsFacet} from '@/editor/codeMirrorExtensions.js'
import {markdownExtensionsFacet} from '@/markdown/extensions.js'
import {mobileKeyboardToolbarItemsFacet} from '@/plugins/mobile-keyboard-toolbar/facet.js'
import {annotationActions, COMMENT_ON_SELECTION_ACTION_ID} from './actions.ts'
import {annotationsDataExtension} from './dataExtension.ts'
import {SUGGEST_EDIT_ACTION_ID, suggestEditAction} from './suggestActions.ts'
import {threadHighlightsContribution} from './highlights.ts'
import {CommentMargin, MarginHeaderItem} from './margin.tsx'
import {threadMarksMarkdownExtension} from './readHighlights.ts'
import {
  commentActionsContribution,
  commentContextMenuItem,
  commentPillContribution,
  commentsFooterContribution,
  threadRootContentContribution,
} from './ui.tsx'

const SOURCE = 'annotations'

export const annotationsPlugin: AppExtension = systemToggle({
  id: 'system:annotations',
  name: 'Comments',
  description: 'Comment on a block, or on selected text in it, in threads that live beside your notes.',
}).of([
  annotationsDataExtension,
  annotationActions.map(action => actionsFacet.of(action, {source: SOURCE})),
  actionsFacet.of(suggestEditAction, {source: SOURCE}),
  blockContentDecoratorsFacet.of(commentPillContribution, {source: SOURCE}),
  blockContentDecoratorsFacet.of(commentActionsContribution, {source: SOURCE}),
  blockChildrenFooterFacet.of(commentsFooterContribution, {source: SOURCE}),
  blockContentRendererFacet.of(threadRootContentContribution, {source: SOURCE}),
  blockContextMenuItemsFacet.of(commentContextMenuItem, {source: SOURCE}),
  codeMirrorExtensionsFacet.of(threadHighlightsContribution, {source: SOURCE}),
  // After every other markdown extension (default precedence), so its
  // transform marks their nodes rather than splitting their tokens.
  markdownExtensionsFacet.of(threadMarksMarkdownExtension, {source: SOURCE, precedence: 100}),
  // A panel mount, not a block layout: that facet is last-wins, and the video
  // notes and SRS review layouts already contribute to it.
  panelMountsFacet.of({id: 'annotations.margin', component: CommentMargin}, {source: SOURCE}),
  headerItemsFacet.of({id: 'annotations.margin-toggle', region: 'end', component: MarginHeaderItem}, {source: SOURCE}),
  mobileKeyboardToolbarItemsFacet.of(
    {id: 'annotations.comment', actionId: COMMENT_ON_SELECTION_ACTION_ID, movesFocus: true},
    {source: SOURCE, precedence: 60}),
  mobileKeyboardToolbarItemsFacet.of(
    {id: 'annotations.suggest', actionId: SUGGEST_EDIT_ACTION_ID, movesFocus: true},
    {source: SOURCE, precedence: 61}),
])
