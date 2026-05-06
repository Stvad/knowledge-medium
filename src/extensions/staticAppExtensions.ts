import type { Repo } from '@/data/repo'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import { defaultRenderersExtension } from '@/extensions/defaultRenderers.tsx'
import { defaultEditorInteractionExtension } from '@/extensions/defaultEditorInteractions.ts'
import { defaultActionsExtension } from '@/shortcuts/defaultShortcuts.ts'
import { accountHeaderPlugin } from '@/plugins/account-header'
import { commandPalettePlugin } from '@/plugins/command-palette'
import { quickFindPlugin } from '@/plugins/quick-find'
import { themeTogglePlugin } from '@/plugins/theme-toggle'
import { workspaceHeaderPlugin } from '@/plugins/workspace-header'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import { vimNormalModePlugin } from '@/plugins/vim-normal-mode'
import { videoPlayerPlugin } from '@/plugins/video-player'
import { backlinksPlugin } from '@/plugins/backlinks'
import { groupedBacklinksPlugin } from '@/plugins/grouped-backlinks'
import { updateIndicatorPlugin } from '@/plugins/update-indicator'
import { agentRuntimePlugin } from '@/plugins/agent-runtime'
import { srsReschedulingPlugin } from '@/plugins/srs-rescheduling'
import { todoPlugin } from '@/plugins/todo'
import type { AppExtension } from '@/extensions/facet.ts'

export const staticAppExtensions = ({repo}: {repo: Repo}): AppExtension[] => [
  // kernelDataExtension contributes KERNEL_MUTATORS and core data
  // registries. repo.setFacetRuntime REPLACES those registries, so the
  // kernel contribution must be present in every static runtime.
  kernelDataExtension,
  defaultRenderersExtension,
  defaultEditorInteractionExtension,
  defaultActionsExtension({repo}),
  workspaceHeaderPlugin,
  commandPalettePlugin,
  quickFindPlugin,
  themeTogglePlugin,
  accountHeaderPlugin,
  plainOutlinerPlugin,
  vimNormalModePlugin({repo}),
  videoPlayerPlugin,
  backlinksPlugin,
  groupedBacklinksPlugin,
  todoPlugin,
  srsReschedulingPlugin,
  updateIndicatorPlugin,
  agentRuntimePlugin,
]
