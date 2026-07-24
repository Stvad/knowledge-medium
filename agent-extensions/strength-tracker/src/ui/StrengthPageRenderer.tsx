/** Block renderer for the Strength Log page.
 *
 *  Mirrors the SRS deck renderer: keep the default block frame, swap the
 *  content area for the tracker (Tonight + look-back). The page's child
 *  workout blocks still render below as a plain, hand-editable outline —
 *  the "data as blocks" view — so nothing is hidden behind the UI.
 */

import {DefaultBlockRenderer} from '@/components/renderer/DefaultBlockRenderer.js'
import {useRepo} from '@/context/repo.js'
import {getBlockTypes} from '@/data/properties.js'
import {useWorkspaceId} from '@/hooks/block.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'

import {STRENGTH_LOG_TYPE} from '../km/fields'
import {HistoryView} from './HistoryView'
import {TonightView} from './TonightView'
import {useProgram} from './useProgram'

const StrengthLogContent: BlockRenderer = ({block}: BlockRendererProps) => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block)
  return workspaceId ? (
    <StrengthTracker repo={repo} workspaceId={workspaceId} pageId={block.id} />
  ) : (
    <div className="py-2 text-sm text-muted-foreground">Loading…</div>
  )
}
StrengthLogContent.displayName = 'StrengthLogContent'

function StrengthTracker({
  repo,
  workspaceId,
  pageId,
}: {
  repo: ReturnType<typeof useRepo>
  workspaceId: string
  pageId: string
}) {
  const program = useProgram(repo, workspaceId, pageId)
  return (
    <div className="strength-tracker flex w-full max-w-2xl flex-col gap-8 py-2">
      <TonightView repo={repo} workspaceId={workspaceId} pageId={pageId} program={program} />
      <HistoryView program={program} />
    </div>
  )
}

export const StrengthLogRenderer: BlockRenderer = Object.assign(
  (props: BlockRendererProps) => (
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={StrengthLogContent}
      EditContentRenderer={StrengthLogContent}
    />
  ),
  {
    canRender: ({block}: BlockRendererProps): boolean => {
      const data = block.peek()
      return !!data && getBlockTypes(data).includes(STRENGTH_LOG_TYPE)
    },
    priority: () => 100,
  },
)
StrengthLogRenderer.displayName = 'StrengthLogRenderer'
