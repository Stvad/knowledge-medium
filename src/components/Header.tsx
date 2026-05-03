import { ErrorBoundary } from 'react-error-boundary'
import { headerItemsFacet, type HeaderItemContribution } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { FallbackComponent } from '@/components/util/error.tsx'

const HeaderRegion = ({items}: {items: readonly HeaderItemContribution[]}) => (
  <div className="flex items-center gap-4">
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
    <div className="flex items-center justify-between py-2 gap-4">
      <HeaderRegion items={startItems}/>
      <HeaderRegion items={endItems}/>
    </div>
  )
}
