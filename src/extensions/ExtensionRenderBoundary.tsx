import { Suspense, type ReactNode } from 'react'
import { ErrorBoundary } from 'react-error-boundary'
import { FallbackComponent } from '@/components/util/error.js'

export function ExtensionRenderBoundary({
  children,
  suspenseFallback = null,
}: {
  children: ReactNode
  suspenseFallback?: ReactNode
}) {
  return (
    <ErrorBoundary FallbackComponent={FallbackComponent}>
      <Suspense fallback={suspenseFallback}>
        {children}
      </Suspense>
    </ErrorBoundary>
  )
}
