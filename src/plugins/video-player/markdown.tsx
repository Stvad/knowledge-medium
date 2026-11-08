import VideoTimeStamp from './VideoTimeStamp.tsx'
import type { MarkdownExtension } from '@/markdown/extensions.js'
import { remarkTimestamps } from './remark-timestamps.ts'
import type { Components } from 'react-markdown'
import { useBlockContext } from '@/context/block.js'

interface TimestampNode {
  properties?: {
    hms?: unknown
  }
}

interface TimestampComponentProps {
  node?: TimestampNode
}

const TimestampComponent = ({node}: TimestampComponentProps) => {
  const blockContext = useBlockContext()
  const hms = node?.properties?.hms
  const videoBlockId = blockContext.videoPlayerBlockId
  if (typeof hms !== 'string' || typeof videoBlockId !== 'string') return null
  const renderScopeId = typeof blockContext.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : undefined
  return <VideoTimeStamp hms={hms} videoBlockId={videoBlockId} renderScopeId={renderScopeId}/>
}

const components = {'time-stamp': TimestampComponent} as unknown as Components

export const videoPlayerMarkdownExtension: MarkdownExtension = ({blockContext}) =>
  typeof blockContext.videoPlayerBlockId === 'string'
    ? {remarkPlugins: [remarkTimestamps], components}
    : null
