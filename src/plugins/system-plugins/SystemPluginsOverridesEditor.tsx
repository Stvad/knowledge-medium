/**
 * Property editor for `system-plugins:overrides`.
 *
 * Renders inside the property panel of the System Plugins prefs
 * block. Composes:
 *   - `useToggleTree()` — walks the full extension tree (static +
 *     dynamic) into a discoverable forest
 *   - `<SystemPluginsSettings>` — the presentational checkbox tree
 *   - `applyToggle` + `onChange` — the property-panel infrastructure
 *     handles the actual `tx.setProperty` write
 *
 * The block holds the canonical state; the sync effect mirrors each
 * change to the localStorage cache + dispatches `refreshAppRuntime`
 * so all consumers of the runtime see the toggle take effect.
 */

import {useCallback} from 'react'
import type {PropertyEditorProps} from '@/data/api'
import {applyToggle, type Overrides, type Togglable} from '@/extensions/togglable.ts'
import {SystemPluginsSettings} from './SystemPluginsSettings.tsx'
import {useToggleTree} from './useToggleTree.ts'

export const SystemPluginsOverridesEditor = ({
  value,
  onChange,
}: PropertyEditorProps<Overrides>) => {
  const {tree, loading} = useToggleTree()

  const handleToggle = useCallback(
    (handle: Togglable, nextState: boolean) => {
      onChange(applyToggle(value, handle, nextState))
    },
    [onChange, value],
  )

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading plugins…</p>
  }

  return (
    <SystemPluginsSettings
      tree={tree}
      overrides={value}
      onToggle={handleToggle}
    />
  )
}
