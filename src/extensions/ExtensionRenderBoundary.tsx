import { Suspense, type ComponentType, type ReactNode } from 'react'
import { ErrorBoundary, type FallbackProps } from 'react-error-boundary'
import { FallbackComponent } from '@/components/util/error.js'

export function ExtensionRenderBoundary({
  children,
  suspenseFallback = null,
  FallbackComponent: Fallback = FallbackComponent,
}: {
  children: ReactNode
  suspenseFallback?: ReactNode
  FallbackComponent?: ComponentType<FallbackProps>
}) {
  return (
    <ErrorBoundary FallbackComponent={Fallback}>
      <Suspense fallback={suspenseFallback}>
        {children}
      </Suspense>
    </ErrorBoundary>
  )
}
