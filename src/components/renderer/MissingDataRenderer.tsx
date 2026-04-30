import { BlockRendererProps } from "@/types"

export const MissingDataRenderer = () => <div className="text-gray-500 text-sm">Loading block...</div>

MissingDataRenderer.canRender = ({block}: BlockRendererProps) => !block?.peek()
MissingDataRenderer.priority = () => 1
