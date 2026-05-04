import { ErrorBoundary } from 'react-error-boundary'
import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { FallbackComponent } from '@/components/util/error.tsx'

const HeaderRegion = ({
  items,
  className = '',
}: {
  items: readonly HeaderItemContribution[]
  className?: string
}) => (
  <div className={`flex min-w-0 items-center gap-2 sm:gap-4 ${className}`}>
    {items.map(({id, component: Component}) => (
      <ErrorBoundary key={id} FallbackComponent={FallbackComponent}>
        <Component/>
      </ErrorBoundary>
    ))}
  </div>
)

export function Header() {
  const runtime = useAppRuntime()
  const items = runtime.read(headerItemsFacet)
  const startItems = items.filter(item => item.region === 'start')
  const endItems = items.filter(item => item.region === 'end')

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
      <HeaderRegion items={startItems} className="min-w-0 flex-1 basis-40"/>
      <HeaderRegion items={endItems} className="max-w-full flex-wrap justify-end"/>
    </div>
  )
}
