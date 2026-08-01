/** The look-back view, as a renderer you can put on a block.
 *
 *  What it is NOT any more: the place logging happens. Sessions live in the
 *  outline where you logged them, so this page is a lens over history —
 *  milestones, trends, asymmetry — and nothing here owns state.
 *
 *  Selected by the Strength Log page's own type. Making it droppable on any
 *  block — the parameterised-view idea — would mean registering it under an
 *  id a `renderer:` property can name, and it is not registered that way
 *  today, so don't read this as already true.
 */

import {useEffect, useState} from 'react'

import {DefaultBlockRenderer} from '@/components/renderer/DefaultBlockRenderer.js'
import {useRepo} from '@/context/repo.js'
import {getBlockTypes} from '@/data/properties.js'
import {useWorkspaceId} from '@/hooks/block.js'
import type {BlockRenderer, BlockRendererProps} from '@/types.js'

import type {ProgramConfig} from '../engine/types'
import {DEFAULT_CONFIG} from '../program/defaults'
import {STRENGTH_LOG_TYPE} from '../km/fields'
import {readProgram} from '../km/tonight'
import {HistoryView} from './HistoryView'
import {useSessionRows} from './decorations/sessionRows'

const StrengthLogContent: BlockRenderer = ({block}: BlockRendererProps) => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block)
  // History is reactive (it is just blocks); the plan is read once, since
  // milestones and trend names come from the program and it does not change
  // while you look at a chart. Seeded with the plan-faithful defaults so the
  // view is usable the instant it mounts.
  const [config, setConfig] = useState<ProgramConfig>(DEFAULT_CONFIG)
  const {history} = useSessionRows(workspaceId)

  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false
    void readProgram(repo, workspaceId)
      .then(snapshot => { if (!cancelled) setConfig(snapshot.config) })
      .catch((error: unknown) => console.error('[strength] could not read the plan outline', error))
    return () => { cancelled = true }
  }, [repo, workspaceId])

  if (!workspaceId) return <div className="py-2 text-sm text-muted-foreground">Loading…</div>

  return (
    <div className="strength-tracker flex w-full max-w-2xl flex-col gap-8 py-2">
      <HistoryView config={config} history={history}/>
    </div>
  )
}
StrengthLogContent.displayName = 'StrengthLogContent'

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
