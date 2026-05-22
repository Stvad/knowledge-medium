import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.js'

const HeaderRegion = ({
  items,
  className = '',
}: {
  items: readonly HeaderItemContribution[]
  className?: string
}) => (
  <div className={`flex min-w-0 items-center gap-1 sm:gap-2 md:gap-4 ${className}`}>
    {items.map(({id, component: Component}) => (
      <ExtensionRenderBoundary key={id}>
        <Component/>
      </ExtensionRenderBoundary>
    ))}
  </div>
)

export function Header() {
  const runtime = useAppRuntime()
  const items = runtime.read(headerItemsFacet)
  const startItems = items.filter(item => item.region === 'start')
  const endItems = items.filter(item => item.region === 'end')

  return (
    <div className="flex flex-nowrap items-center gap-x-1 px-2 py-1 sm:gap-x-2 sm:py-2 md:flex-wrap md:justify-between md:gap-x-4 md:gap-y-2 md:px-0">
      <HeaderRegion items={startItems} className="shrink-0 md:flex-1 md:basis-40"/>
      <HeaderRegion items={endItems} className="ml-auto flex-1 justify-end overflow-hidden md:ml-0 md:max-w-full md:flex-none md:flex-wrap"/>
    </div>
  )
}
