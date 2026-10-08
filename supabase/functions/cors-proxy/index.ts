// Deno entry for the `cors-proxy` edge function. Everything but the platform
// wiring lives in ./proxy.ts, where vitest can reach it.

import { createProxyHandler } from './proxy.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
if (!supabaseUrl) throw new Error('cors-proxy: SUPABASE_URL is not set')

const resolveDns = async (hostname: string, signal: AbortSignal): Promise<string[]> => {
  const lookups = await Promise.allSettled([
    Deno.resolveDns(hostname, 'A', {signal}),
    Deno.resolveDns(hostname, 'AAAA', {signal}),
  ])
  return lookups.flatMap(lookup => (lookup.status === 'fulfilled' ? lookup.value : []))
}

// `allowHost`: the proxy names the host itself when it connects to a checked address.
const client = Deno.createHttpClient({allowHost: true})

Deno.serve(createProxyHandler({
  supabaseUrl,
  fetch: (input, init) => fetch(input, {...init, client}),
  resolveDns,
}))
