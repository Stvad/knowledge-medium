/**
 * Presentational tree of toggle rows for the System Plugins settings
 * surface.
 *
 * Pure: takes a discovered `ToggleNode[]` + the current `Overrides`
 * map + an `onToggle(handle, next)` callback, and renders nested
 * checkboxes. The caller threads `onToggle` into a write to the
 * System Plugins block (see `setOverride`, slice 9c).
 *
 * Conventions:
 *
 *   - Each row is a checkbox + label + (optional) description.
 *   - Essentials render as `checked` and `disabled` — they cannot be
 *     flipped through the UI (the `isEnabled` filter forces them on
 *     anyway, so a flippable checkbox would only confuse).
 *   - Children indent one level via padding; ARIA `treeitem` /
 *     `aria-level` carries the nesting for assistive tech and tests.
 */

import {Fragment, useMemo} from 'react'
import {Checkbox} from '@/components/ui/checkbox.tsx'
import {Label} from '@/components/ui/label.tsx'
import type {ToggleNode} from '@/extensions/discoverToggleTree.ts'
import {isEnabled, type Overrides, type Togglable} from '@/extensions/togglable.ts'

/** Stable-sort the tree so essentials surface first within each level,
 *  then alphabetical (case-insensitive, locale-aware) within each
 *  (essential / non-essential) group. Catalog order in
 *  `staticAppExtensions.ts` stays the source of truth for plugin
 *  authors; the settings UI reorders purely for discoverability. */
const nameComparator = new Intl.Collator(undefined, {sensitivity: 'base'})
const compareNodes = (a: ToggleNode, b: ToggleNode): number => {
  const aEss = a.handle.essential === true ? 0 : 1
  const bEss = b.handle.essential === true ? 0 : 1
  if (aEss !== bEss) return aEss - bEss
  return nameComparator.compare(a.handle.name, b.handle.name)
}

const groupEssentialsFirst = (
  nodes: ReadonlyArray<ToggleNode>,
): ToggleNode[] => {
  return nodes
    .toSorted(compareNodes)
    .map(node => ({
      handle: node.handle,
      children: groupEssentialsFirst(node.children),
    }))
}

export interface SystemPluginsSettingsProps {
  tree: ReadonlyArray<ToggleNode>
  overrides: Overrides
  onToggle: (handle: Togglable, nextState: boolean) => void
}

export const SystemPluginsSettings = ({
  tree,
  overrides,
  onToggle,
}: SystemPluginsSettingsProps) => {
  // Bucket the top level by handle.kind so user extensions get their
  // own section. Within each bucket: essentials first, then
  // alphabetical. Nested children inherit the same sort but stay
  // under their parent regardless of kind.
  const sections = useMemo(() => {
    const system: ToggleNode[] = []
    const user: ToggleNode[] = []
    for (const root of tree) {
      if (root.handle.kind === 'user') user.push(root)
      else system.push(root)
    }
    return {
      system: groupEssentialsFirst(system),
      user: groupEssentialsFirst(user),
    }
  }, [tree])

  if (sections.system.length === 0 && sections.user.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No plugins to display.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {sections.system.length > 0 && (
        <Section title="System plugins" nodes={sections.system}
          overrides={overrides} onToggle={onToggle}/>
      )}
      {sections.user.length > 0 && (
        <Section title="User extensions" nodes={sections.user}
          overrides={overrides} onToggle={onToggle}/>
      )}
    </div>
  )
}

interface SectionProps {
  title: string
  nodes: ReadonlyArray<ToggleNode>
  overrides: Overrides
  onToggle: (handle: Togglable, nextState: boolean) => void
}

const Section = ({title, nodes, overrides, onToggle}: SectionProps) => (
  <section className="flex flex-col gap-1">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {title}
    </h3>
    <ul role="tree" className="flex flex-col gap-1">
      {nodes.map(node => (
        <ToggleRow
          key={node.handle.id}
          node={node}
          overrides={overrides}
          onToggle={onToggle}
          level={1}
        />
      ))}
    </ul>
  </section>
)

interface ToggleRowProps {
  node: ToggleNode
  overrides: Overrides
  onToggle: (handle: Togglable, nextState: boolean) => void
  level: number
}

const ToggleRow = ({node, overrides, onToggle, level}: ToggleRowProps) => {
  const {handle, children} = node
  const checked = isEnabled(handle, overrides)
  const essential = handle.essential === true
  const checkboxId = `system-plugin-toggle-${handle.id}`
  // Pad inward per level; level 1 stays flush so the outer row aligns
  // with the parent container.
  const indent = (level - 1) * 16

  return (
    <Fragment>
      <li
        role="treeitem"
        aria-level={level}
        aria-checked={checked}
        aria-label={handle.name}
        className="flex items-start gap-2"
        style={{paddingInlineStart: indent}}
      >
        <Checkbox
          id={checkboxId}
          checked={checked}
          disabled={essential}
          onCheckedChange={(next) => {
            if (essential) return
            onToggle(handle, next === true)
          }}
        />
        <div className="flex flex-col">
          <Label
            htmlFor={checkboxId}
            className={essential ? 'text-muted-foreground' : undefined}
          >
            {handle.name}
            {essential && (
              <span className="ml-2 text-xs text-muted-foreground">
                (essential)
              </span>
            )}
          </Label>
          {handle.description && (
            <span className="text-xs text-muted-foreground">
              {handle.description}
            </span>
          )}
        </div>
      </li>
      {children.length > 0 && children.map(child => (
        <ToggleRow
          key={child.handle.id}
          node={child}
          overrides={overrides}
          onToggle={onToggle}
          level={level + 1}
        />
      ))}
    </Fragment>
  )
}
