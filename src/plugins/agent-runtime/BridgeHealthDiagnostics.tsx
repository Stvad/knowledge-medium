import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  runBridgeHealthProbe,
  type BridgeHealthProbeMode,
  type BridgeHealthProbeResult,
} from './bridgeHealthProbe.ts'

export interface BridgeHealthDiagnosticsProps {
  getBridgeUrl: () => string
}

export function BridgeHealthDiagnostics({getBridgeUrl}: BridgeHealthDiagnosticsProps) {
  const [running, setRunning] = useState<BridgeHealthProbeMode | null>(null)
  const [results, setResults] = useState<Partial<Record<BridgeHealthProbeMode, BridgeHealthProbeResult>>>({})

  const probe = async (mode: BridgeHealthProbeMode) => {
    setRunning(mode)
    try {
      const result = await runBridgeHealthProbe({getBridgeUrl, mode})
      setResults(current => ({...current, [mode]: result}))
    } finally {
      setRunning(null)
    }
  }

  return (
    <section className="space-y-2 rounded-md border p-3" aria-label="Bridge health diagnostics">
      <div>
        <h3 className="text-sm font-medium">Bridge connection test</h3>
        <p className="text-xs text-muted-foreground">
          Sends a one-time, token-free request to the configured local bridge.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={running !== null}
          onClick={() => { void probe('standard') }}
        >
          {running === 'standard' ? 'Testing standard…' : 'Test /health'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={running !== null}
          onClick={() => { void probe('loopback') }}
        >
          {running === 'loopback' ? 'Testing loopback…' : 'Test /health (loopback target)'}
        </Button>
      </div>
      {(['standard', 'loopback'] as const).map(mode => {
        const result = results[mode]
        return result ? (
          <pre
            key={mode}
            role="status"
            aria-live="polite"
            className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-2 text-xs"
          >
            {JSON.stringify(result)}
          </pre>
        ) : null
      })}
    </section>
  )
}
