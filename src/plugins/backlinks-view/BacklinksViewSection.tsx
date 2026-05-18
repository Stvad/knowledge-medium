import { useMemo } from 'react'
import type { BlockRenderer, BlockRendererProps } from '@/types.ts'
import type {
  BlockChildrenFooterContribution,
  BlockResolveContext,
} from '@/extensions/blockInteraction.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useUserPrefsProperty } from '@/data/globalState.ts'
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
 * The "are there any backlinks?" gate lives inside the selected variant,
 * which receives `controls` and decides whether to render them. That lets
 * grouped backlinks gate from its grouped snapshot instead of forcing this
 * coordinator to run an unconditional flat backlinks query first.
 */
export function BacklinksViewSection({block, resolveContext}: Props) {
  const runtime = useAppRuntime()

  const variants = useMemo(
    () => runtime.read(backlinksViewFacet)(resolveContext).all,
    [runtime, resolveContext],
  )

  const [savedId, setSavedId] = useUserPrefsProperty(backlinksViewProp)
  const selected = variants.find(v => v.id === savedId) ?? variants[0]

  if (!selected) return null

  const Selected = selected.render
  const controls = variants.length > 1 && (
    <div
      className="mt-4 inline-flex items-center gap-0.5 text-xs text-muted-foreground"
      role="group"
      aria-label="Backlinks view"
    >
      {variants.map(variant => {
        const active = variant.id === selected.id
        return (
          <button
            key={variant.id}
            type="button"
            onClick={() => setSavedId(variant.id)}
            className={`rounded-sm px-1.5 py-0.5 leading-4 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
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
  )

  return <Selected block={block} controls={controls || undefined}/>
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
