import { useMemo, type MouseEvent } from 'react'
import type { BlockRenderer, BlockRendererProps } from '@/types.js'
import type {
  BlockChildrenFooterContribution,
  BlockResolveContext,
} from '@/extensions/blockInteraction.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useHandle, usePropertyValue } from '@/hooks/block.js'
import { backlinksViewFacet } from './facet.ts'
import { backlinksViewProp, defaultBacklinksViewIdForBlock } from './prop.ts'

interface Props extends BlockRendererProps {
  /** Captured at contribution time so we can resolve variants without
   *  rebuilding the resolver context inside this component. */
  resolveContext: BlockResolveContext
}

/**
 * Footer section that drives the variant pick:
 * - reads registered variants from `backlinksViewFacet`
 * - reads the current block's optional saved choice from `backlinksViewProp`
 * - otherwise derives the default view from the block (daily notes use grouped)
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

  const defaultId = useHandle(block, {selector: defaultBacklinksViewIdForBlock})
  const [overrideId, setOverrideId] = usePropertyValue(block, backlinksViewProp)
  const selectedId = overrideId ?? defaultId
  const selected =
    variants.find(v => v.id === selectedId) ??
    variants.find(v => v.id === defaultId) ??
    variants[0]

  if (!selected) return null

  const Selected = selected.render
  // Compact text-toggle switcher. No top margin / block wrapper: the variants
  // render this inline inside their header row (next to the filter icon), so it
  // costs no extra vertical line. `variants.length > 1` ⇒ nothing when only the
  // flat variant is registered.
  const controls = variants.length > 1 && (
    <div
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      role="group"
      aria-label="Backlinks view"
    >
      {variants.map(variant => {
        const active = variant.id === selected.id
        return (
          <button
            key={variant.id}
            type="button"
            onClick={() => setOverrideId(variant.id === defaultId ? undefined : variant.id)}
            className={`leading-4 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
              active ? 'font-medium text-foreground' : 'hover:text-foreground'
            }`}
            aria-pressed={active}
          >
            {variant.label}
          </button>
        )
      })}
    </div>
  )

  return (
    <div onClick={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}>
      <Selected block={block} controls={controls || undefined}/>
    </div>
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
