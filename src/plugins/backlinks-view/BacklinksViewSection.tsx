import { useMemo } from 'react'
import type { BlockRenderer, BlockRendererProps } from '@/types.ts'
import type {
  BlockChildrenFooterContribution,
  BlockResolveContext,
} from '@/extensions/blockInteraction.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useUserPrefsProperty } from '@/data/globalState.ts'
import { useWorkspaceId } from '@/hooks/block.ts'
import { useRepo } from '@/context/repo.tsx'
import { useBacklinks } from '@/plugins/backlinks/useBacklinks.ts'
import { backlinksViewFacet } from './facet.ts'
import { backlinksViewProp } from './prop.ts'

interface Props extends BlockRendererProps {
  /** Captured at contribution time so we can resolve variants without
   *  rebuilding the resolver context inside this component. */
  resolveContext: BlockResolveContext
}

/**
 * Footer section that drives the variant pick:
 * - reads registered variants from `backlinksViewFacet`
 * - reads the user's saved choice from `backlinksViewProp` (UserPrefs)
 * - mounts only the selected variant — unselected variants never run
 *   their queries, since their hooks live inside their components and
 *   only mount when rendered
 *
 * The "are there any backlinks?" gate is hoisted up here so the picker
 * doesn't appear above a block with no references. Both the variant's
 * internal gate and this one subscribe to the same query handle —
 * the data layer dedupes the underlying query.
 */
export function BacklinksViewSection({block, resolveContext}: Props) {
  const runtime = useAppRuntime()
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const backlinks = useBacklinks(block, workspaceId)

  const variants = useMemo(
    () => runtime.read(backlinksViewFacet)(resolveContext).all,
    [runtime, resolveContext],
  )

  const [savedId, setSavedId] = useUserPrefsProperty(backlinksViewProp)
  const selected = variants.find(v => v.id === savedId) ?? variants[0]

  if (!selected) return null
  // Mirror the legacy variant gate — render nothing for blocks without
  // any backlinks. Keeps the picker from dangling on empty pages.
  if (backlinks.length === 0) return null

  const Selected = selected.render

  return (
    <>
      {variants.length > 1 && (
        <div className="mt-8 flex items-center gap-1 text-xs text-muted-foreground">
          <span className="mr-1">View:</span>
          {variants.map(variant => {
            const active = variant.id === selected.id
            return (
              <button
                key={variant.id}
                type="button"
                onClick={() => setSavedId(variant.id)}
                className={`rounded-sm px-2 py-0.5 transition-colors ${
                  active
                    ? 'bg-accent text-foreground'
                    : 'hover:bg-accent/50 hover:text-foreground'
                }`}
                aria-pressed={active}
              >
                {variant.label}
              </button>
            )
          })}
        </div>
      )}
      <Selected block={block}/>
    </>
  )
}

/** Coordinator footer contribution. Captures the resolve context so
 *  the section component can read `backlinksViewFacet` (whose
 *  resolver takes `BlockResolveContext`) without rebuilding it inside
 *  the React tree. The captured ctx is stable per (block, panel, ...)
 *  thanks to `DefaultBlockRenderer`'s resolve-context memo, so the
 *  wrapper component identity is stable per block. */
export const backlinksViewFooterContribution: BlockChildrenFooterContribution = (ctx) => {
  if (!ctx.isTopLevel) return null
  const Section: BlockRenderer = (props) =>
    <BacklinksViewSection {...props} resolveContext={ctx}/>
  Section.displayName = 'BacklinksViewSection'
  return Section
}
