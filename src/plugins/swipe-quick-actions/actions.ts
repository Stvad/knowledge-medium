import type { ComponentType, SVGProps } from 'react'
import {
  Trash2,
  Copy,
  Link2,
  PanelRightOpen,
  ZoomIn,
  ChevronsDownUp,
  SlidersHorizontal,
  Hash,
  ClipboardCopy,
} from 'lucide-react'
import { Block } from '@/data/block'
import { Repo } from '@/data/repo'
import { isCollapsedProp, showPropertiesProp, topLevelBlockIdProp, setFocusedBlockId } from '@/data/properties.ts'
import { previousVisibleBlock } from '@/utils/selection.ts'
import { navigate } from '@/utils/navigation.ts'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

export interface QuickActionContext {
  block: Block
  repo: Repo
  uiStateBlock: Block
  workspaceId: string
}

export interface QuickAction {
  id: string
  label: string
  icon: IconComponent
  /** Optional destructive flag — used by the UI to color the button red. */
  destructive?: boolean
  run: (ctx: QuickActionContext) => void | Promise<void>
}

const writeToClipboard = (text: string): void => {
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    void navigator.clipboard.writeText(text)
  }
}

const deleteBlock: QuickAction = {
  id: 'delete',
  label: 'Delete',
  icon: Trash2,
  destructive: true,
  run: async ({block, uiStateBlock}) => {
    const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
    const prevVisible = topLevelBlockId
      ? await previousVisibleBlock(block, topLevelBlockId)
      : null
    await block.delete()
    if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
  },
}

/** Copy the block's textual content. The bullet's right-click context menu
 *  copies references/IDs but never the content itself; this is the most
 *  literal interpretation of "copy block" for a swipe-action. */
const copyBlockContent: QuickAction = {
  id: 'copy-content',
  label: 'Copy',
  icon: Copy,
  run: ({block}) => {
    const data = block.peek()
    if (!data) return
    writeToClipboard(data.content)
  },
}

const copyBlockRef: QuickAction = {
  id: 'copy-ref',
  label: 'Copy Ref',
  icon: Link2,
  run: ({block}) => {
    writeToClipboard(`((${block.id}))`)
  },
}

const openInPanel: QuickAction = {
  id: 'open-in-panel',
  label: 'Open',
  icon: PanelRightOpen,
  run: ({block, repo, uiStateBlock, workspaceId}) => {
    navigate(repo, {
      blockId: block.id,
      workspaceId,
      target: 'new-panel',
      sourcePanelId: uiStateBlock.id,
    })
  },
}

const zoomIn: QuickAction = {
  id: 'zoom-in',
  label: 'Zoom In',
  icon: ZoomIn,
  run: ({block, repo, workspaceId}) => {
    navigate(repo, {blockId: block.id, workspaceId, target: 'focused'})
  },
}

const toggleCollapse: QuickAction = {
  id: 'toggle-collapse',
  label: 'Collapse',
  icon: ChevronsDownUp,
  run: async ({block}) => {
    const collapsed = block.peekProperty(isCollapsedProp) ?? false
    await block.set(isCollapsedProp, !collapsed)
  },
}

const toggleProperties: QuickAction = {
  id: 'toggle-properties',
  label: 'Properties',
  icon: SlidersHorizontal,
  run: async ({block}) => {
    const showing = block.peekProperty(showPropertiesProp) ?? false
    await block.set(showPropertiesProp, !showing)
  },
}

const copyBlockId: QuickAction = {
  id: 'copy-id',
  label: 'Copy ID',
  icon: Hash,
  run: ({block}) => {
    writeToClipboard(block.id)
  },
}

const copyBlockEmbed: QuickAction = {
  id: 'copy-embed',
  label: 'Copy Embed',
  icon: ClipboardCopy,
  run: ({block}) => {
    writeToClipboard(`!((${block.id}))`)
  },
}

/** Primary toolbar — visible icons. Order: most-used to least-used,
 *  with destructive last so it's farthest from the swipe origin. */
export const PRIMARY_ACTIONS: readonly QuickAction[] = [
  copyBlockContent,
  copyBlockRef,
  openInPanel,
  deleteBlock,
]

/** Secondary toolbar — hidden under the kebab/"More" button. */
export const OVERFLOW_ACTIONS: readonly QuickAction[] = [
  zoomIn,
  toggleCollapse,
  toggleProperties,
  copyBlockId,
  copyBlockEmbed,
]
