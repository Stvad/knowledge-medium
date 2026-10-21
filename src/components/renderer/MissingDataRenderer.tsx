import { BlockRendererProps } from "@/types"
import type { BlockRendererRegistration } from '@/extensions/blockInteraction.js'

export const MissingDataRenderer = ({block}: BlockRendererProps) =>
  block?.peek() === undefined ? <div className="text-gray-500 text-sm">Loading block...</div> : null

export const missingDataRendererRegistration: BlockRendererRegistration = {
  id: 'missingData',
  label: 'Missing block',
  resolve: ctx => ctx.block.peek() ? null : {render: MissingDataRenderer},
}
