import { useMemo, type ReactNode } from 'react'
import { useRepo } from '@/context/repo'
import { PropertyDisplayScopeContext } from '@/context/propertyDisplay'
import { useHandle } from '@/hooks/block'
import { useActiveWorkspaceId, useWorkspaces } from '@/hooks/useWorkspaces'
import { pluginPrefsBlockId } from '@/data/stateBlocks'
import {
  parsePropertyDisplaySetting,
  propertyDisplayDefaultProp,
  propertyDisplayPrefsType,
} from '@/data/propertyDisplayMode'
import { isChildBackedPropertiesWorkspace } from '@/types'

/** Provides the workspace level of the property display mode to the outline
 *  below it: whether the active workspace is child-backed, and this user's
 *  preference for it. Mounted once per panel, so the outline's thousands of
 *  blocks read a context rather than each subscribing to the workspace row.
 *  The preference is read from its deterministic prefs-block id, without
 *  creating the block — only a write (the switch actions) creates it. */
export function PropertyDisplayScope({children}: {children: ReactNode}) {
  const repo = useRepo()
  const workspaceId = useActiveWorkspaceId()
  const {workspaces} = useWorkspaces()
  const childBacked = workspaces.some(workspace =>
    workspace.id === workspaceId && isChildBackedPropertiesWorkspace(workspace.propertiesMigration))
  const prefsBlock = repo.block(workspaceId
    ? pluginPrefsBlockId(workspaceId, repo.user.id, propertyDisplayPrefsType.id)
    : '')
  const workspaceSetting = useHandle(prefsBlock, {
    selector: doc => parsePropertyDisplaySetting(doc?.properties[propertyDisplayDefaultProp.name]),
  })
  const levels = useMemo(() => ({
    childBacked,
    workspace: workspaceSetting,
    panel: 'inherit' as const,
  }), [childBacked, workspaceSetting])
  return (
    <PropertyDisplayScopeContext.Provider value={levels}>
      {children}
    </PropertyDisplayScopeContext.Provider>
  )
}
