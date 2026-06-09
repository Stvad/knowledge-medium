import { BlockRendererProps } from "@/types"

export const MissingDataRenderer = ({block}: BlockRendererProps) =>
  block?.peek() === undefined ? <div className="text-gray-500 text-sm">Loading block...</div> : null

MissingDataRenderer.canRender = ({block}: BlockRendererProps) => !block?.peek()
MissingDataRenderer.priority = () => 1
