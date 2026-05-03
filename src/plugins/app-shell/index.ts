import { CommandPalette } from '@/components/CommandPalette.tsx'
import { QuickFind } from '@/components/QuickFind.tsx'
import { appMountsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'

export const appShellPlugin: AppExtension = [
  appMountsFacet.of(
    {id: 'app-shell.command-palette', component: CommandPalette},
    {source: 'app-shell'},
  ),
  appMountsFacet.of(
    {id: 'app-shell.quick-find', component: QuickFind},
    {source: 'app-shell'},
  ),
]
